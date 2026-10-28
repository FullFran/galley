package reanchor

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// File is one file of a GitHub comparison.
type File struct {
	Filename         string
	PreviousFilename string
	// Status is GitHub's: added, removed, modified, renamed, copied, changed
	// or unchanged.
	Status string
	// Patch is the file's unified diff hunks; empty for binary files and
	// when GitHub omits it because it is too large.
	Patch string
}

// Comparison is the changed files between two commits.
type Comparison struct {
	Files []File
	// Truncated means the file list may be incomplete (GitHub lists at most
	// 300 files, and very large comparisons are cut off).
	Truncated bool
}

// GitHub is what the Reanchorer needs from GitHub, called with the user's
// own token.
type GitHub interface {
	// Compare is GET /repos/{owner}/{repo}/compare/{base}...{head}.
	Compare(ctx context.Context, token, fullName, base, head string) (Comparison, error)
	// FileAt returns a file's content at ref; found is false when the file
	// does not exist there.
	FileAt(ctx context.Context, token, fullName, path, ref string) (content string, found bool, err error)
}

// TokenSource returns the user's GitHub token (comments.CachedAccess.Token).
type TokenSource func(ctx context.Context, userID string) (string, error)

// Defaults for Config.
const (
	DefaultMaxPositions   = 20_000
	DefaultMaxComparisons = 512
	DefaultMaxFiles       = 64
	// DefaultMaxCacheBytes bounds the comparison cache and, separately, the
	// file cache.
	DefaultMaxCacheBytes = 64 << 20
	DefaultWindow        = 50
	DefaultNegativeTTL   = 30 * time.Second
	DefaultCallBurst     = 30
	DefaultCallEvery     = 2 * time.Second
)

// Config wires a Service. Zero fields take the defaults.
type Config struct {
	GitHub GitHub
	Token  TokenSource
	// MaxPositions bounds the cached positions, per (thread, base, at).
	MaxPositions int
	// MaxComparisons bounds the cached comparisons, per (repo, base, head).
	MaxComparisons int
	// MaxFiles bounds the cached file contents, per (repo, path, ref).
	MaxFiles int
	// MaxCacheBytes bounds the bytes of cached comparisons and of cached
	// files (each); larger single entries are not cached.
	MaxCacheBytes int64
	// Window is the fuzzy search window, in lines either side.
	Window int
	// NegativeTTL is how long a failed GitHub call is remembered, so a
	// listing does not retry it for every thread.
	NegativeTTL time.Duration
	// Limiter limits GitHub calls (cache misses) per user; defaults to
	// DefaultCallBurst at once and one more every DefaultCallEvery.
	Limiter *comments.RateLimiter
	Clock   comments.Clock
	Logger  *slog.Logger
}

// Service implements comments.Reanchorer. Results are cached in memory with
// bounds; positions and successful GitHub results never expire because
// commits are immutable. When GitHub fails, is rate limited or the user has
// no token, the stored position is returned unchanged (its commit_sha then
// differs from at, which tells clients the thread was not mapped) and
// nothing is cached for the thread.
type Service struct {
	cfg       Config
	positions *lru[comments.Position]
	compares  *lru[Comparison]
	files     *lru[fileContent]

	mu       sync.Mutex
	inflight map[string]*call
}

type fileContent struct {
	content string
	found   bool
}

type call struct {
	done chan struct{}
}

var _ comments.Reanchorer = (*Service)(nil)

// New validates cfg and returns a Service.
func New(cfg Config) (*Service, error) {
	if cfg.GitHub == nil || cfg.Token == nil {
		return nil, errors.New("reanchor: github and token are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.MaxPositions <= 0 {
		cfg.MaxPositions = DefaultMaxPositions
	}
	if cfg.MaxComparisons <= 0 {
		cfg.MaxComparisons = DefaultMaxComparisons
	}
	if cfg.MaxFiles <= 0 {
		cfg.MaxFiles = DefaultMaxFiles
	}
	if cfg.MaxCacheBytes <= 0 {
		cfg.MaxCacheBytes = DefaultMaxCacheBytes
	}
	if cfg.Window <= 0 {
		cfg.Window = DefaultWindow
	}
	if cfg.NegativeTTL <= 0 {
		cfg.NegativeTTL = DefaultNegativeTTL
	}
	if cfg.Limiter == nil {
		cfg.Limiter = comments.NewRateLimiter(DefaultCallBurst, DefaultCallEvery, cfg.Clock)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Service{
		cfg:       cfg,
		positions: newLRU[comments.Position](cfg.MaxPositions, 0, nil),
		compares:  newLRU(cfg.MaxComparisons, cfg.MaxCacheBytes, comparisonSize),
		files:     newLRU(cfg.MaxFiles, cfg.MaxCacheBytes, func(f fileContent) int64 { return int64(len(f.content)) + 64 }),
		inflight:  map[string]*call{},
	}, nil
}

// CachedPositions reports how many positions are cached.
func (s *Service) CachedPositions() int { return s.positions.len() }

// errSkipped marks a lookup that was not attempted (rate limited).
var errSkipped = errors.New("reanchor: skipped")

// Position implements comments.Reanchorer.
func (s *Service) Position(ctx context.Context, userID string, t comments.ThreadRecord, q comments.Quote, at string) (comments.Position, error) {
	stored := t.Position
	if stored.Path == "" {
		stored.Path = t.Path
	}
	base := stored.CommitSHA
	if at == "" || at == base {
		return stored, nil
	}
	key := t.ID + "|" + base + "|" + at
	now := s.cfg.Clock.Now()
	if p, ok, _ := s.positions.get(key, now); ok {
		return p, nil
	}
	p, err := s.compute(ctx, userID, t, stored, q, at)
	if err != nil {
		if !errors.Is(err, errSkipped) && !errors.Is(err, comments.ErrUnauthenticated) {
			s.cfg.Logger.Warn("re-anchoring unavailable", "error", err)
		}
		return stored, nil
	}
	s.positions.put(key, p, nil, time.Time{})
	return p, nil
}

func (s *Service) compute(ctx context.Context, userID string, t comments.ThreadRecord, stored comments.Position, q comments.Quote, at string) (comments.Position, error) {
	orphaned := comments.Position{Path: stored.Path, CommitSHA: at, Range: stored.Range, State: comments.AnchorOrphaned}
	tok, err := s.cfg.Token(ctx, userID)
	if err != nil {
		return comments.Position{}, err
	}
	g := gh{s: s, ctx: ctx, user: userID, token: tok, repoID: t.RepoID, repo: t.RepoFullName}
	cmp, err := g.compare(stored.CommitSHA, at)
	if err != nil {
		return comments.Position{}, err
	}

	path := stored.Path
	newPath := path
	var hunks []Hunk
	fallback := false
	file := findFile(cmp.Files, path)
	switch {
	case file != nil && file.Status == "removed":
		return orphaned, nil
	case file != nil:
		newPath = file.Filename
		if file.Patch == "" {
			fallback = true
		} else if hunks, err = ParsePatch(file.Patch); err != nil {
			fallback = true
		}
	case cmp.Truncated:
		fallback = true
	}
	var newText *string
	if fallback {
		oldF, err := g.file(path, stored.CommitSHA)
		if err != nil {
			return comments.Position{}, err
		}
		newF, err := g.file(newPath, at)
		if err != nil {
			return comments.Position{}, err
		}
		if !oldF.found || !newF.found {
			return orphaned, nil
		}
		hunks = DiffLines(SplitLines(oldF.content), SplitLines(newF.content))
		newText = &newF.content
	}

	r := stored.Range
	ns, ne, clean := Shift(hunks, r.StartLine, r.EndLine)
	if clean {
		moved := comments.Range{StartLine: ns, EndLine: ne, StartColumn: r.StartColumn, EndColumn: r.EndColumn}
		return comments.Position{Path: newPath, CommitSHA: at, Range: moved, State: state(moved, r, newPath, path)}, nil
	}
	if newText == nil {
		f, err := g.file(newPath, at)
		if err != nil {
			return comments.Position{}, err
		}
		if !f.found {
			return orphaned, nil
		}
		newText = &f.content
	}
	text := *newText
	columns := r.StartColumn != 0
	if st, en, ok := FindExact(text, q, ns); ok {
		got := rangeOf(text, st, en, columns)
		return comments.Position{Path: newPath, CommitSHA: at, Range: got, State: state(got, r, newPath, path)}, nil
	}
	allow := func(cells int64) bool { return comments.SpendWork(ctx, cells) }
	st, en, ok, skipped := FindFuzzy(text, q, ns, s.cfg.Window, allow)
	if skipped {
		return comments.Position{}, errSkipped // listing budget spent: not cached
	}
	if ok {
		return comments.Position{Path: newPath, CommitSHA: at, Range: rangeOf(text, st, en, columns), State: comments.AnchorFuzzy}, nil
	}
	return orphaned, nil
}

// findFile returns the comparison's entry for path: an exact filename match
// first, else the file renamed from path (the first one, in GitHub's order).
func findFile(files []File, path string) *File {
	for i := range files {
		if files[i].Filename == path {
			return &files[i]
		}
	}
	for i := range files {
		if files[i].PreviousFilename == path && files[i].Status == "renamed" {
			return &files[i]
		}
	}
	return nil
}

// comparisonSize approximates a cached comparison's memory.
func comparisonSize(c Comparison) int64 {
	n := int64(64)
	for _, f := range c.Files {
		n += int64(len(f.Filename)+len(f.PreviousFilename)+len(f.Status)+len(f.Patch)) + 64
	}
	return n
}

func state(got, was comments.Range, newPath, path string) comments.AnchorState {
	if got == was && newPath == path {
		return comments.AnchorExact
	}
	return comments.AnchorMoved
}

// gh runs cached, rate-limited and deduplicated GitHub calls for one
// thread.
type gh struct {
	s      *Service
	ctx    context.Context
	user   string
	token  string
	repoID int64
	repo   string
}

func (g gh) compare(base, head string) (Comparison, error) {
	key := strconv.FormatInt(g.repoID, 10) + "|" + base + "|" + head
	return cached(g, g.s.compares, "c|"+key, func() (Comparison, error) {
		return g.s.cfg.GitHub.Compare(g.ctx, g.token, g.repo, base, head)
	})
}

func (g gh) file(path, ref string) (fileContent, error) {
	key := strconv.FormatInt(g.repoID, 10) + "|" + ref + "|" + path
	return cached(g, g.s.files, "f|"+key, func() (fileContent, error) {
		c, found, err := g.s.cfg.GitHub.FileAt(g.ctx, g.token, g.repo, path, ref)
		return fileContent{content: c, found: found}, err
	})
}

// cached answers from c, or makes one call per key at a time (concurrent
// callers wait for it) after taking a token from the user's limiter.
// Failures are remembered for NegativeTTL.
func cached[V any](g gh, c *lru[V], key string, fetch func() (V, error)) (V, error) {
	s := g.s
	for {
		if v, ok, err := c.get(key, s.cfg.Clock.Now()); ok {
			return v, err
		}
		s.mu.Lock()
		if cl, busy := s.inflight[key]; busy {
			s.mu.Unlock()
			select {
			case <-cl.done:
				continue
			case <-g.ctx.Done():
				var zero V
				return zero, g.ctx.Err()
			}
		}
		cl := &call{done: make(chan struct{})}
		s.inflight[key] = cl
		s.mu.Unlock()

		v, err := func() (V, error) {
			defer func() {
				s.mu.Lock()
				delete(s.inflight, key)
				s.mu.Unlock()
				close(cl.done)
			}()
			if !s.cfg.Limiter.Allow(g.user) {
				var zero V
				return zero, errSkipped
			}
			v, err := fetch()
			if err != nil {
				if g.ctx.Err() == nil {
					c.put(key, v, err, s.cfg.Clock.Now().Add(s.cfg.NegativeTTL))
				}
				return v, err
			}
			c.put(key, v, nil, time.Time{})
			return v, nil
		}()
		return v, err
	}
}

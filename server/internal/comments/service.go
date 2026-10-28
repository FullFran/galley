package comments

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// Defaults for Config.
const (
	DefaultListLimit  = 200
	DefaultWriteBurst = 30
	DefaultWriteEvery = 2 * time.Second
)

// Config wires a Service.
type Config struct {
	Store  Store
	Access RepoAccess
	Sealer Sealer
	// Clock defaults to the system clock.
	Clock Clock
	// Reanchorer defaults to StoredPosition (phase 1).
	Reanchorer Reanchorer
	// Limiter limits writes per user; defaults to DefaultWriteBurst writes
	// and one more every DefaultWriteEvery.
	Limiter *RateLimiter
	// ListLimit caps the threads of one listing; defaults to DefaultListLimit.
	ListLimit int
	// NewID defaults to random 15-character [a-z0-9] ids.
	NewID func() string
}

// Service runs the comment use cases. Every call checks the actor's
// permission on the repository: read and comment need pull, resolve and
// reopen need push, and comments can only be edited or deleted by their
// author. Threads in repositories the actor cannot see are ErrNotFound.
type Service struct{ cfg Config }

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Access == nil || cfg.Sealer == nil {
		return nil, errors.New("comments: store, access and sealer are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = ClockFunc(time.Now)
	}
	if cfg.Reanchorer == nil {
		cfg.Reanchorer = StoredPosition{}
	}
	if cfg.Limiter == nil {
		cfg.Limiter = NewRateLimiter(DefaultWriteBurst, DefaultWriteEvery, cfg.Clock)
	}
	if cfg.ListLimit <= 0 {
		cfg.ListLimit = DefaultListLimit
	}
	if cfg.NewID == nil {
		cfg.NewID = randomID
	}
	return &Service{cfg: cfg}, nil
}

// ThreadList is one page of threads.
type ThreadList struct {
	Threads []Thread
	// Truncated is set when more threads matched than ListLimit.
	Truncated bool
}

// Unread summarizes what the actor has not read in a repository.
type Unread struct {
	RepoID   int64
	Threads  int
	Comments int
	ByThread map[string]int
}

// ListThreads lists a repository's threads with their comments.
func (s *Service) ListThreads(ctx context.Context, a Actor, repoID int64, f ListFilter) (ThreadList, error) {
	if repoID <= 0 {
		return ThreadList{}, invalid("repo_id")
	}
	if f.Path != "" && !ValidPath(f.Path) {
		return ThreadList{}, invalid("path")
	}
	if f.Status != "" && f.Status != StatusOpen && f.Status != StatusResolved {
		return ThreadList{}, invalid("status")
	}
	if f.At != "" && !ValidSHA(f.At) {
		return ThreadList{}, invalid("at")
	}
	if _, err := s.permission(ctx, a, repoID); err != nil {
		return ThreadList{}, err
	}
	recs, err := s.cfg.Store.Threads(ctx, repoID, f, s.cfg.ListLimit+1)
	if err != nil {
		return ThreadList{}, storeErr(err)
	}
	out := ThreadList{}
	if len(recs) > s.cfg.ListLimit {
		recs, out.Truncated = recs[:s.cfg.ListLimit], true
	}
	if out.Threads, err = s.build(ctx, a, recs, f.At); err != nil {
		return ThreadList{}, err
	}
	return out, nil
}

// CreateThread starts a thread with its first comment.
func (s *Service) CreateThread(ctx context.Context, a Actor, repoID int64, in NewThread) (Thread, error) {
	if repoID <= 0 {
		return Thread{}, invalid("repo_id")
	}
	if err := in.Validate(); err != nil {
		return Thread{}, err
	}
	if err := s.allowWrite(a); err != nil {
		return Thread{}, err
	}
	perm, err := s.permission(ctx, a, repoID)
	if err != nil {
		return Thread{}, err
	}

	now := s.cfg.Clock.Now().UTC()
	t := ThreadRecord{
		ID:             s.cfg.NewID(),
		RepoID:         repoID,
		RepoFullName:   perm.FullName,
		Path:           in.Path,
		CommitSHA:      in.CommitSHA,
		Range:          in.Range,
		Position:       Position{CommitSHA: in.CommitSHA, Range: in.Range, State: AnchorExact},
		Origin:         in.Origin,
		Status:         StatusOpen,
		CreatedBy:      a.UserID,
		CreatedByLogin: a.Login,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	for _, f := range []struct {
		dst   *string
		plain string
		field string
	}{
		{&t.QuoteExact, in.Quote.Exact, "quote_exact"},
		{&t.QuotePrefix, in.Quote.Prefix, "quote_prefix"},
		{&t.QuoteSuffix, in.Quote.Suffix, "quote_suffix"},
	} {
		if f.plain == "" {
			continue
		}
		if *f.dst, err = s.seal(f.plain, threadAAD(t, f.field)); err != nil {
			return Thread{}, err
		}
	}
	c, err := s.newComment(a, t.ID, in.CommitSHA, NewComment{Body: in.Body, Suggestion: in.Suggestion}, now)
	if err != nil {
		return Thread{}, err
	}
	if err := s.cfg.Store.CreateThread(ctx, t, c); err != nil {
		return Thread{}, storeErr(err)
	}
	return s.thread(ctx, a, t.ID, "")
}

// GetThread returns a thread with its comments.
func (s *Service) GetThread(ctx context.Context, a Actor, id string) (Thread, error) {
	if _, err := s.visibleThread(ctx, a, id); err != nil {
		return Thread{}, err
	}
	return s.thread(ctx, a, id, "")
}

// Reply adds a comment to a thread.
func (s *Service) Reply(ctx context.Context, a Actor, threadID string, in NewComment) (Comment, error) {
	if !ValidID(threadID) {
		return Comment{}, ErrNotFound
	}
	if err := in.Validate(); err != nil {
		return Comment{}, err
	}
	if err := s.allowWrite(a); err != nil {
		return Comment{}, err
	}
	t, err := s.visibleThread(ctx, a, threadID)
	if err != nil {
		return Comment{}, err
	}
	rec, err := s.newComment(a, t.ID, t.CommitSHA, in, s.cfg.Clock.Now().UTC())
	if err != nil {
		return Comment{}, err
	}
	if err := s.cfg.Store.AddComment(ctx, rec); err != nil {
		return Comment{}, storeErr(err)
	}
	return s.openComment(a, rec)
}

// EditComment replaces the body and suggestion of the actor's own comment.
func (s *Service) EditComment(ctx context.Context, a Actor, id string, in NewComment) (Comment, error) {
	if !ValidID(id) {
		return Comment{}, ErrNotFound
	}
	if err := in.Validate(); err != nil {
		return Comment{}, err
	}
	if err := s.allowWrite(a); err != nil {
		return Comment{}, err
	}
	rec, t, err := s.ownComment(ctx, a, id)
	if err != nil {
		return Comment{}, err
	}
	if err := s.sealContent(&rec, t.CommitSHA, in); err != nil {
		return Comment{}, err
	}
	rec.EditedAt = s.cfg.Clock.Now().UTC()
	if err := s.cfg.Store.UpdateComment(ctx, rec); err != nil {
		return Comment{}, storeErr(err)
	}
	return s.openComment(a, rec)
}

// DeleteComment deletes the actor's own comment, and the thread with it when
// it was the last one.
func (s *Service) DeleteComment(ctx context.Context, a Actor, id string) error {
	if !ValidID(id) {
		return ErrNotFound
	}
	if err := s.allowWrite(a); err != nil {
		return err
	}
	if _, _, err := s.ownComment(ctx, a, id); err != nil {
		return err
	}
	if _, err := s.cfg.Store.DeleteComment(ctx, id, s.cfg.Clock.Now().UTC()); err != nil {
		return storeErr(err)
	}
	return nil
}

// Resolve marks an open thread resolved. It needs push.
func (s *Service) Resolve(ctx context.Context, a Actor, id string) (Thread, error) {
	return s.setStatus(ctx, a, id, StatusOpen, StatusResolved)
}

// Reopen reopens a resolved thread. It needs push.
func (s *Service) Reopen(ctx context.Context, a Actor, id string) (Thread, error) {
	return s.setStatus(ctx, a, id, StatusResolved, StatusOpen)
}

// MarkRead records that the actor has read the thread now. It is not rate
// limited: the UI calls it whenever a thread is opened, and it overwrites a
// single marker per user and thread.
func (s *Service) MarkRead(ctx context.Context, a Actor, id string) error {
	t, err := s.visibleThread(ctx, a, id)
	if err != nil {
		return err
	}
	if err := s.cfg.Store.MarkRead(ctx, a.UserID, t.ID, s.cfg.Clock.Now().UTC()); err != nil {
		return storeErr(err)
	}
	return nil
}

// Unread counts the comments by others the actor has not read in a repo.
func (s *Service) Unread(ctx context.Context, a Actor, repoID int64) (Unread, error) {
	if repoID <= 0 {
		return Unread{}, invalid("repo_id")
	}
	if _, err := s.permission(ctx, a, repoID); err != nil {
		return Unread{}, err
	}
	by, err := s.cfg.Store.UnreadCounts(ctx, a.UserID, repoID)
	if err != nil {
		return Unread{}, storeErr(err)
	}
	u := Unread{RepoID: repoID, ByThread: map[string]int{}}
	for id, n := range by {
		if n > 0 {
			u.ByThread[id] = n
			u.Threads++
			u.Comments += n
		}
	}
	return u, nil
}

func (s *Service) setStatus(ctx context.Context, a Actor, id string, from, to Status) (Thread, error) {
	if !ValidID(id) {
		return Thread{}, ErrNotFound
	}
	if err := s.allowWrite(a); err != nil {
		return Thread{}, err
	}
	t, err := s.cfg.Store.Thread(ctx, id)
	if err != nil {
		return Thread{}, storeErr(err)
	}
	perm, err := s.permission(ctx, a, t.RepoID)
	if errors.Is(err, ErrForbidden) {
		return Thread{}, ErrNotFound
	}
	if err != nil {
		return Thread{}, err
	}
	if !perm.Push {
		return Thread{}, ErrForbidden
	}
	if err := s.cfg.Store.SetThreadStatus(ctx, id, from, to, a, s.cfg.Clock.Now().UTC()); err != nil {
		return Thread{}, storeErr(err)
	}
	return s.thread(ctx, a, id, "")
}

// permission checks pull on the repository and returns the permission.
func (s *Service) permission(ctx context.Context, a Actor, repoID int64) (RepoPermission, error) {
	if a.UserID == "" {
		return RepoPermission{}, ErrUnauthenticated
	}
	perm, err := s.cfg.Access.Permission(ctx, a.UserID, repoID)
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrUnauthenticated), errors.Is(err, ErrRateLimited):
		return RepoPermission{}, err
	case err != nil:
		return RepoPermission{}, fmt.Errorf("%w: %w", ErrUnavailable, err)
	case !perm.Pull:
		return RepoPermission{}, ErrForbidden
	}
	return perm, nil
}

// visibleThread loads a thread the actor may read; others are ErrNotFound.
func (s *Service) visibleThread(ctx context.Context, a Actor, id string) (ThreadRecord, error) {
	if !ValidID(id) {
		return ThreadRecord{}, ErrNotFound
	}
	t, err := s.cfg.Store.Thread(ctx, id)
	if err != nil {
		return ThreadRecord{}, storeErr(err)
	}
	if _, err := s.permission(ctx, a, t.RepoID); err != nil {
		if errors.Is(err, ErrForbidden) {
			return ThreadRecord{}, ErrNotFound
		}
		return ThreadRecord{}, err
	}
	return t, nil
}

// ownComment loads a comment of a visible thread written by the actor.
func (s *Service) ownComment(ctx context.Context, a Actor, id string) (CommentRecord, ThreadRecord, error) {
	c, err := s.cfg.Store.Comment(ctx, id)
	if err != nil {
		return CommentRecord{}, ThreadRecord{}, storeErr(err)
	}
	t, err := s.visibleThread(ctx, a, c.ThreadID)
	if err != nil {
		return CommentRecord{}, ThreadRecord{}, err
	}
	if c.AuthorUser == "" || c.AuthorUser != a.UserID {
		return CommentRecord{}, ThreadRecord{}, ErrForbidden
	}
	return c, t, nil
}

func (s *Service) allowWrite(a Actor) error {
	if a.UserID == "" {
		return ErrUnauthenticated
	}
	if !s.cfg.Limiter.Allow(a.UserID) {
		return ErrRateLimited
	}
	return nil
}

func (s *Service) newComment(a Actor, threadID, baseSHA string, in NewComment, at time.Time) (CommentRecord, error) {
	c := CommentRecord{
		ID:          s.cfg.NewID(),
		ThreadID:    threadID,
		AuthorKind:  AuthorHuman,
		AuthorUser:  a.UserID,
		AuthorLogin: a.Login,
		CreatedAt:   at,
	}
	if err := s.sealContent(&c, baseSHA, in); err != nil {
		return CommentRecord{}, err
	}
	return c, nil
}

// sealContent sets the sealed body and suggestion of c, bound to c.ID.
func (s *Service) sealContent(c *CommentRecord, baseSHA string, in NewComment) error {
	var err error
	if c.Body, err = s.seal(in.Body, commentAAD(*c, "body")); err != nil {
		return err
	}
	c.Suggestion, c.SuggestionBaseSHA = "", ""
	if in.Suggestion != nil {
		if c.Suggestion, err = s.seal(*in.Suggestion, commentAAD(*c, "suggestion")); err != nil {
			return err
		}
		c.SuggestionBaseSHA = baseSHA
	}
	return nil
}

func (s *Service) thread(ctx context.Context, a Actor, id, at string) (Thread, error) {
	t, err := s.cfg.Store.Thread(ctx, id)
	if err != nil {
		return Thread{}, storeErr(err)
	}
	out, err := s.build(ctx, a, []ThreadRecord{t}, at)
	if err != nil {
		return Thread{}, err
	}
	return out[0], nil
}

// build opens threads and attaches their comments.
func (s *Service) build(ctx context.Context, a Actor, recs []ThreadRecord, at string) ([]Thread, error) {
	threads := make([]Thread, 0, len(recs))
	if len(recs) == 0 {
		return threads, nil
	}
	ids := make([]string, len(recs))
	for i, r := range recs {
		ids[i] = r.ID
	}
	crecs, err := s.cfg.Store.Comments(ctx, ids)
	if err != nil {
		return nil, storeErr(err)
	}
	byThread := map[string][]Comment{}
	for _, cr := range crecs {
		c, err := s.openComment(a, cr)
		if err != nil {
			return nil, err
		}
		byThread[cr.ThreadID] = append(byThread[cr.ThreadID], c)
	}
	for _, r := range recs {
		t, err := s.openThread(ctx, r, at)
		if err != nil {
			return nil, err
		}
		t.Comments = byThread[r.ID]
		if t.Comments == nil {
			t.Comments = []Comment{}
		}
		threads = append(threads, t)
	}
	return threads, nil
}

func (s *Service) openThread(ctx context.Context, r ThreadRecord, at string) (Thread, error) {
	var q Quote
	var err error
	for _, f := range []struct {
		dst    *string
		sealed string
		field  string
	}{
		{&q.Exact, r.QuoteExact, "quote_exact"},
		{&q.Prefix, r.QuotePrefix, "quote_prefix"},
		{&q.Suffix, r.QuoteSuffix, "quote_suffix"},
	} {
		if f.sealed == "" {
			continue
		}
		if *f.dst, err = s.open(f.sealed, threadAAD(r, f.field)); err != nil {
			return Thread{}, err
		}
	}
	pos, err := s.cfg.Reanchorer.Position(ctx, r, q, at)
	if err != nil {
		return Thread{}, fmt.Errorf("%w: re-anchor: %w", ErrUnavailable, err)
	}
	return Thread{
		ID:           r.ID,
		RepoID:       r.RepoID,
		RepoFullName: r.RepoFullName,
		Anchor:       Anchor{Path: r.Path, CommitSHA: r.CommitSHA, Range: r.Range, Quote: q},
		Position:     pos,
		Origin:       r.Origin,
		Status:       r.Status,
		CreatedBy:    r.CreatedByLogin,
		CreatedAt:    r.CreatedAt,
		UpdatedAt:    r.UpdatedAt,
		ResolvedBy:   r.ResolvedByLogin,
		ResolvedAt:   r.ResolvedAt,
	}, nil
}

func (s *Service) openComment(a Actor, r CommentRecord) (Comment, error) {
	body, err := s.open(r.Body, commentAAD(r, "body"))
	if err != nil {
		return Comment{}, err
	}
	c := Comment{
		ID:          r.ID,
		ThreadID:    r.ThreadID,
		AuthorKind:  r.AuthorKind,
		AuthorLogin: r.AuthorLogin,
		AIClient:    r.AIClient,
		AIModel:     r.AIModel,
		Mine:        r.AuthorUser != "" && r.AuthorUser == a.UserID,
		Body:        body,
		CreatedAt:   r.CreatedAt,
		EditedAt:    r.EditedAt,
	}
	if r.Suggestion != "" {
		text, err := s.open(r.Suggestion, commentAAD(r, "suggestion"))
		if err != nil {
			return Comment{}, err
		}
		c.Suggestion = &Suggestion{Text: text, BaseSHA: r.SuggestionBaseSHA}
	}
	return c, nil
}

func (s *Service) seal(plain string, aad []byte) (string, error) {
	out, err := s.cfg.Sealer.Seal([]byte(plain), aad)
	if err != nil {
		return "", fmt.Errorf("comments: seal: %w", err)
	}
	return out, nil
}

// open fails for a value moved to another record or field, because the
// associated data binds each value to its record id and field name.
func (s *Service) open(sealed string, aad []byte) (string, error) {
	out, err := s.cfg.Sealer.Open(sealed, aad)
	if err != nil {
		return "", errors.New("comments: a stored value does not authenticate")
	}
	return string(out), nil
}

// threadAAD binds a sealed thread field to the record, the field, the
// repository and the path, so a quote moved to another record, field,
// repository or file does not open. The id has a fixed length, the field and
// repository id contain no "/", and the path comes last, so the encoding is
// unambiguous.
func threadAAD(t ThreadRecord, field string) []byte {
	return []byte("galley/v2/thread/" + t.ID + "/" + field + "/" + strconv.FormatInt(t.RepoID, 10) + "/" + t.Path)
}

// commentAAD binds a sealed comment field to the record, the field and the
// thread.
func commentAAD(c CommentRecord, field string) []byte {
	return []byte("galley/v2/comment/" + c.ID + "/" + field + "/" + c.ThreadID)
}

// storeErr keeps the sentinel errors a Store may return and marks the rest
// as unavailable.
func storeErr(err error) error {
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrConflict) {
		return err
	}
	return fmt.Errorf("%w: store: %w", ErrUnavailable, err)
}

const idAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

// NewID returns a random record id (IDLength characters of [a-z0-9]).
func NewID() string { return randomID() }

// randomID returns IDLength characters of idAlphabet from crypto/rand.
func randomID() string {
	out := make([]byte, 0, IDLength)
	buf := make([]byte, 32)
	for len(out) < IDLength {
		_, _ = rand.Read(buf) // crypto/rand.Read never fails
		for _, b := range buf {
			// 252 is the largest multiple of 36 below 256: no modulo bias.
			if b < 252 && len(out) < IDLength {
				out = append(out, idAlphabet[b%36])
			}
		}
	}
	return string(out)
}

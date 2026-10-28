package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// GuardConfig wires a Guard.
type GuardConfig struct {
	// Inner answers the user's GitHub permission (comments.CachedAccess).
	Inner comments.RepoAccess
	Store Store
	// Users returns the GitHub identity of a galley user.
	Users func(ctx context.Context, userID string) (Identity, error)
	Clock comments.Clock
	// TouchEvery throttles activity writes (default DefaultTouchEvery).
	TouchEvery time.Duration
	// AllowlistTTL is how long allowlists are cached (default
	// DefaultAllowlistTTL). Changes made through Service apply at once.
	AllowlistTTL time.Duration
	Logger       *slog.Logger
}

// maxTracked bounds the in-memory throttle and allowlist caches.
const maxTracked = 50_000

// Guard is the comments.RepoAccess every repository-scoped galley API uses.
// It wraps the GitHub permission check, records the user's activity on the
// repository (throttled), and enforces the repository's allowlist: a user
// who is not on a non-empty allowlist gets a permission without pull, so
// comments, drafts and chat refuse them with ErrForbidden. Repository admins
// are never blocked, so an admin cannot lock themselves out.
type Guard struct {
	cfg GuardConfig

	mu       sync.Mutex
	touched  map[string]touch
	allowed  map[int64]allowCache
	allowGen map[int64]uint64
}

type touch struct {
	at    time.Time
	level Level
}

type allowCache struct {
	entries []AllowEntry
	exp     time.Time
	gen     uint64
}

var _ comments.RepoAccess = (*Guard)(nil)

// NewGuard validates cfg and returns a Guard.
func NewGuard(cfg GuardConfig) (*Guard, error) {
	if cfg.Inner == nil || cfg.Store == nil || cfg.Users == nil {
		return nil, errors.New("admin: inner access, store and users are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.TouchEvery <= 0 {
		cfg.TouchEvery = DefaultTouchEvery
	}
	if cfg.AllowlistTTL <= 0 {
		cfg.AllowlistTTL = DefaultAllowlistTTL
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Guard{cfg: cfg, touched: map[string]touch{}, allowed: map[int64]allowCache{}, allowGen: map[int64]uint64{}}, nil
}

// Permission implements comments.RepoAccess.
func (g *Guard) Permission(ctx context.Context, userID string, repoID int64) (comments.RepoPermission, error) {
	p, blocked, err := g.Check(ctx, userID, repoID)
	if err != nil {
		return comments.RepoPermission{}, err
	}
	if blocked {
		return comments.RepoPermission{FullName: p.FullName}, nil
	}
	return p, nil
}

// Check returns the user's GitHub permission and whether the allowlist
// blocks them. It records activity for users with pull.
func (g *Guard) Check(ctx context.Context, userID string, repoID int64) (comments.RepoPermission, bool, error) {
	return g.check(ctx, userID, repoID, false)
}

// CheckFresh is Check with the GitHub permission asked again, bypassing
// the cache, when the inner access supports it (FreshAccess); the fresh
// answer also refreshes the cache.
func (g *Guard) CheckFresh(ctx context.Context, userID string, repoID int64) (comments.RepoPermission, bool, error) {
	return g.check(ctx, userID, repoID, true)
}

func (g *Guard) check(ctx context.Context, userID string, repoID int64, fresh bool) (comments.RepoPermission, bool, error) {
	var p comments.RepoPermission
	var err error
	if f, ok := g.cfg.Inner.(FreshAccess); ok && fresh {
		p, err = f.FreshPermission(ctx, userID, repoID)
	} else {
		p, err = g.cfg.Inner.Permission(ctx, userID, repoID)
	}
	if err != nil || !p.Pull {
		return p, false, err
	}
	g.touch(ctx, userID, repoID, LevelOf(p))
	if p.Admin {
		return p, false, nil
	}
	list, err := g.allowlist(ctx, repoID)
	if err != nil {
		// Fail closed: an unreadable allowlist blocks nobody silently.
		return comments.RepoPermission{}, false, fmt.Errorf("%w: allowlist: %w", comments.ErrUnavailable, err)
	}
	if len(list) == 0 {
		return p, false, nil
	}
	id, err := g.cfg.Users(ctx, userID)
	if err != nil {
		return comments.RepoPermission{}, false, fmt.Errorf("%w: user: %w", comments.ErrUnavailable, err)
	}
	return p, !allowed(list, id), nil
}

func allowed(list []AllowEntry, id Identity) bool {
	for _, e := range list {
		if e.Matches(id) {
			return true
		}
	}
	return false
}

// touch writes the activity when the last write is older than TouchEvery or
// the level changed. Failures are logged and do not fail the request.
func (g *Guard) touch(ctx context.Context, userID string, repoID int64, level Level) {
	key := userID + "/" + strconv.FormatInt(repoID, 10)
	now := g.cfg.Clock.Now().UTC()
	g.mu.Lock()
	last, ok := g.touched[key]
	if ok && last.level == level && now.Sub(last.at) < g.cfg.TouchEvery {
		g.mu.Unlock()
		return
	}
	if len(g.touched) >= maxTracked {
		for k, t := range g.touched {
			if now.Sub(t.at) >= g.cfg.TouchEvery {
				delete(g.touched, k)
			}
		}
		if len(g.touched) >= maxTracked {
			g.touched = map[string]touch{}
		}
	}
	g.touched[key] = touch{at: now, level: level}
	g.mu.Unlock()

	err := g.cfg.Store.TouchActivity(ctx, Activity{UserID: userID, RepoID: repoID, Level: level, FirstSeen: now, LastSeen: now})
	if err != nil {
		g.mu.Lock()
		delete(g.touched, key)
		g.mu.Unlock()
		g.cfg.Logger.Error("admin: record activity failed", "error", err)
	}
}

func (g *Guard) allowlist(ctx context.Context, repoID int64) ([]AllowEntry, error) {
	now := g.cfg.Clock.Now()
	g.mu.Lock()
	c, ok := g.allowed[repoID]
	gen := g.allowGen[repoID]
	g.mu.Unlock()
	if ok && c.gen == gen && now.Before(c.exp) {
		return c.entries, nil
	}
	list, err := g.cfg.Store.Allowlist(ctx, repoID, MaxAllowlist)
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.allowGen[repoID] == gen {
		if len(g.allowed) >= maxTracked {
			g.allowed = map[int64]allowCache{}
		}
		g.allowed[repoID] = allowCache{entries: list, exp: now.Add(g.cfg.AllowlistTTL), gen: gen}
	}
	return list, nil
}

// invalidate drops the repository's cached allowlist; a fetch in flight
// started before it is not stored.
func (g *Guard) invalidate(repoID int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.allowed, repoID)
	if len(g.allowGen) >= maxTracked {
		g.allowGen = map[int64]uint64{}
	}
	g.allowGen[repoID]++
}

func lower(s string) string { return strings.ToLower(s) }

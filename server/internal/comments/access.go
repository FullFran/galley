package comments

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// UserToken is a GitHub user access token and its expiry.
type UserToken struct {
	Token     string
	ExpiresAt time.Time
}

// TokenMinter returns a fresh GitHub user access token for a galley user,
// minted server-side from the stored refresh token (which rotates it). It
// returns ErrUnauthenticated when the user must sign in again.
type TokenMinter func(ctx context.Context, userID string) (UserToken, error)

// RepoLister lists the repositories, with the user's permission on each, in
// the galley app installations the token's user can access. Only those
// repositories are commentable: a repository the user can read on GitHub
// without galley installed is not listed. ErrUnauthenticated means GitHub
// rejected the token.
type RepoLister interface {
	InstalledRepos(ctx context.Context, token string) (map[int64]RepoPermission, error)
}

// Defaults for AccessConfig.
const (
	DefaultAccessTTL   = 5 * time.Minute
	DefaultTokenMargin = 5 * time.Minute
	DefaultMaxUsers    = 10_000
	DefaultMissBurst   = 20
	DefaultMissEvery   = 3 * time.Second
)

// AccessConfig wires a CachedAccess.
type AccessConfig struct {
	Mint  TokenMinter
	Repos RepoLister
	// TTL is how long a user's repository list is trusted.
	TTL time.Duration
	// TokenMargin: a cached token is reused until this long before expiry.
	TokenMargin time.Duration
	// MaxUsers bounds the users kept; expired users are evicted first.
	MaxUsers int
	// MissLimiter limits cache misses (GitHub listings) per user; defaults to
	// DefaultMissBurst at once and one more every DefaultMissEvery.
	MissLimiter *RateLimiter
	Clock       Clock
}

// CachedAccess implements RepoAccess. Per user it keeps the installed
// repository list for TTL and the last unscoped access token until shortly
// before it expires, so permission checks rotate the refresh token at most
// once per token lifetime. Tokens the browser obtains through auth are fed in
// with TokenIssued, so the browser and the server do not keep rotating the
// pair against each other.
type CachedAccess struct {
	cfg AccessConfig

	mu    sync.Mutex
	users map[string]*userAccess
}

type userAccess struct {
	fetch sync.Mutex // serializes misses: concurrent misses share one fetch

	// Guarded by CachedAccess.mu.
	repos    map[int64]RepoPermission
	reposExp time.Time
	token    UserToken
	gen      uint64 // bumped on invalidation; stale fetches are not stored
}

var _ RepoAccess = (*CachedAccess)(nil)

// NewCachedAccess returns a CachedAccess; zero fields take the defaults.
func NewCachedAccess(cfg AccessConfig) *CachedAccess {
	if cfg.Clock == nil {
		cfg.Clock = ClockFunc(time.Now)
	}
	if cfg.TTL <= 0 {
		cfg.TTL = DefaultAccessTTL
	}
	if cfg.TokenMargin <= 0 {
		cfg.TokenMargin = DefaultTokenMargin
	}
	if cfg.MaxUsers <= 0 {
		cfg.MaxUsers = DefaultMaxUsers
	}
	if cfg.MissLimiter == nil {
		cfg.MissLimiter = NewRateLimiter(DefaultMissBurst, DefaultMissEvery, cfg.Clock)
	}
	return &CachedAccess{cfg: cfg, users: map[string]*userAccess{}}
}

// Permission implements RepoAccess.
func (a *CachedAccess) Permission(ctx context.Context, userID string, repoID int64) (RepoPermission, error) {
	u := a.user(userID)
	if p, err, ok := a.lookup(u, repoID); ok {
		return p, err
	}

	u.fetch.Lock()
	defer u.fetch.Unlock()
	if p, err, ok := a.lookup(u, repoID); ok {
		return p, err
	}
	return a.fetchLocked(ctx, u, userID, repoID)
}

// FreshPermission answers from a new GitHub listing, bypassing the cached
// list (for privileged actions such as admin changes), and stores the
// result in the cache. It counts against the same per-user miss limiter.
func (a *CachedAccess) FreshPermission(ctx context.Context, userID string, repoID int64) (RepoPermission, error) {
	u := a.user(userID)
	u.fetch.Lock()
	defer u.fetch.Unlock()
	return a.fetchLocked(ctx, u, userID, repoID)
}

// fetchLocked lists the user's repositories and caches them; u.fetch is
// held.
func (a *CachedAccess) fetchLocked(ctx context.Context, u *userAccess, userID string, repoID int64) (RepoPermission, error) {
	if !a.cfg.MissLimiter.Allow(userID) {
		return RepoPermission{}, ErrRateLimited
	}

	a.mu.Lock()
	gen, tok := u.gen, u.token
	a.mu.Unlock()
	cached := tok.Token != "" && a.cfg.Clock.Now().Before(tok.ExpiresAt.Add(-a.cfg.TokenMargin))
	if !cached {
		var err error
		if tok, err = a.mint(ctx, u, userID); err != nil {
			return RepoPermission{}, err
		}
	}
	repos, err := a.cfg.Repos.InstalledRepos(ctx, tok.Token)
	if errors.Is(err, ErrUnauthenticated) && cached {
		// The cached token was revoked or replaced: mint once more.
		if tok, err = a.mint(ctx, u, userID); err != nil {
			return RepoPermission{}, err
		}
		repos, err = a.cfg.Repos.InstalledRepos(ctx, tok.Token)
	}
	switch {
	case errors.Is(err, ErrUnauthenticated):
		return RepoPermission{}, ErrUnauthenticated
	case err != nil:
		return RepoPermission{}, fmt.Errorf("comments: installed repositories: %w", err)
	}

	a.mu.Lock()
	if u.gen == gen {
		u.repos, u.reposExp = repos, a.cfg.Clock.Now().Add(a.cfg.TTL)
	}
	a.mu.Unlock()
	if p, ok := repos[repoID]; ok {
		return p, nil
	}
	return RepoPermission{}, ErrNotFound
}

func (a *CachedAccess) mint(ctx context.Context, u *userAccess, userID string) (UserToken, error) {
	tok, err := a.cfg.Mint(ctx, userID)
	if errors.Is(err, ErrUnauthenticated) {
		return UserToken{}, ErrUnauthenticated
	}
	if err != nil {
		return UserToken{}, fmt.Errorf("comments: mint token: %w", err)
	}
	a.mu.Lock()
	u.token = tok
	a.mu.Unlock()
	return tok, nil
}

// TokenIssued records a token issued for the user elsewhere (the browser's
// refresh). An unscoped token replaces the cached one; a repository-scoped
// token is never reused, and drops the cached token because the rotation may
// have replaced it.
func (a *CachedAccess) TokenIssued(userID string, tok UserToken, scoped bool) {
	u := a.user(userID)
	a.mu.Lock()
	defer a.mu.Unlock()
	if scoped {
		u.token = UserToken{}
		return
	}
	u.token = tok
}

// Invalidate forgets everything about a user (after revocation).
func (a *CachedAccess) Invalidate(userID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if u, ok := a.users[userID]; ok {
		u.gen++
		u.repos, u.reposExp, u.token = nil, time.Time{}, UserToken{}
		delete(a.users, userID)
	}
}

// InvalidateAll drops every repository list but keeps tokens (after
// installation or membership webhooks, whose effect on each user is unknown).
func (a *CachedAccess) InvalidateAll() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, u := range a.users {
		u.gen++
		u.repos, u.reposExp = nil, time.Time{}
	}
}

// Users reports how many users are cached.
func (a *CachedAccess) Users() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.users)
}

func (a *CachedAccess) lookup(u *userAccess, repoID int64) (RepoPermission, error, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if u.repos == nil || !a.cfg.Clock.Now().Before(u.reposExp) {
		return RepoPermission{}, nil, false
	}
	if p, ok := u.repos[repoID]; ok {
		return p, nil, true
	}
	return RepoPermission{}, ErrNotFound, true
}

// user returns the user's entry, evicting idle users when the map is full.
func (a *CachedAccess) user(userID string) *userAccess {
	a.mu.Lock()
	defer a.mu.Unlock()
	if u, ok := a.users[userID]; ok {
		return u
	}
	if len(a.users) >= a.cfg.MaxUsers {
		a.evictLocked()
	}
	u := &userAccess{}
	a.users[userID] = u
	return u
}

// evictLocked drops users whose list and token have both expired and that
// have no fetch in flight; if none qualify, it drops users with an expired
// list, keeping the rest.
func (a *CachedAccess) evictLocked() {
	now := a.cfg.Clock.Now()
	idle := func(u *userAccess) bool {
		if !u.fetch.TryLock() {
			return false
		}
		u.fetch.Unlock()
		return true
	}
	for id, u := range a.users {
		if !now.Before(u.reposExp) && !now.Before(u.token.ExpiresAt) && idle(u) {
			delete(a.users, id)
		}
	}
	if len(a.users) < a.cfg.MaxUsers {
		return
	}
	for id, u := range a.users {
		if !now.Before(u.reposExp) && idle(u) {
			delete(a.users, id)
			if len(a.users) < a.cfg.MaxUsers {
				return
			}
		}
	}
}

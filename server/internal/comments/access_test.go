package comments_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// fakeGitHub mints tokens (each mint stands for one refresh-token rotation)
// and lists the repositories of the user's app installations.
type fakeGitHub struct {
	mu       sync.Mutex
	clock    *fakeClock
	lifetime time.Duration
	mints    int
	lists    int
	mintErr  error
	listErr  error
	repos    map[int64]comments.RepoPermission // installed repositories
	revoked  map[string]bool                   // tokens GitHub now rejects
	gotToken string
}

func newGitHub(clock *fakeClock) *fakeGitHub {
	return &fakeGitHub{clock: clock, lifetime: 8 * time.Hour, repos: map[int64]comments.RepoPermission{}, revoked: map[string]bool{}}
}

func (g *fakeGitHub) mint(_ context.Context, userID string) (comments.UserToken, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.mintErr != nil {
		return comments.UserToken{}, g.mintErr
	}
	g.mints++
	return comments.UserToken{Token: fmt.Sprintf("ghu_%s_%d", userID, g.mints), ExpiresAt: g.clock.Now().Add(g.lifetime)}, nil
}

func (g *fakeGitHub) InstalledRepos(_ context.Context, token string) (map[int64]comments.RepoPermission, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.lists++
	g.gotToken = token
	if g.revoked[token] {
		return nil, comments.ErrUnauthenticated
	}
	if g.listErr != nil {
		return nil, g.listErr
	}
	out := make(map[int64]comments.RepoPermission, len(g.repos))
	for k, v := range g.repos {
		out[k] = v
	}
	return out, nil
}

func (g *fakeGitHub) counts() (mints, lists int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.mints, g.lists
}

func newAccess(gh *fakeGitHub, clock *fakeClock, opts ...func(*comments.AccessConfig)) *comments.CachedAccess {
	cfg := comments.AccessConfig{Mint: gh.mint, Repos: gh, TTL: 5 * time.Minute, Clock: clock}
	for _, o := range opts {
		o(&cfg)
	}
	return comments.NewCachedAccess(cfg)
}

func TestCachedAccessUsesInstalledRepositories(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{FullName: "o/r", Pull: true, Push: true}
	gh.repos[8] = comments.RepoPermission{FullName: "o/s", Pull: true}
	a := newAccess(gh, clock)

	p, err := a.Permission(ctx, "u1", 7)
	if err != nil || !p.Push || p.FullName != "o/r" {
		t.Fatalf("permission = %+v, %v", p, err)
	}
	if gh.gotToken != "ghu_u1_1" {
		t.Errorf("listed with token %q, want the user's own", gh.gotToken)
	}
	if p, _ := a.Permission(ctx, "u1", 8); p.Push || !p.Pull {
		t.Errorf("repo 8 = %+v", p)
	}
	// A repository outside the installations (a public repository, say) is
	// not found, even though the user could pull it on GitHub.
	if _, err := a.Permission(ctx, "u1", 99); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("uninstalled repo err = %v", err)
	}
	if m, l := gh.counts(); m != 1 || l != 1 {
		t.Errorf("mints, lists = %d, %d; want 1, 1 (one listing serves every repo)", m, l)
	}

	if _, err := a.Permission(ctx, "u2", 7); err != nil {
		t.Fatal(err)
	}
	if m, _ := gh.counts(); m != 2 {
		t.Errorf("cache shared across users: mints = %d", m)
	}

	clock.Advance(5*time.Minute + time.Second)
	_, _ = a.Permission(ctx, "u1", 7)
	if m, l := gh.counts(); l != 3 || m != 2 {
		t.Errorf("after TTL: mints, lists = %d, %d; want 2, 3 (relist, reuse token)", m, l)
	}
}

func TestCachedAccessRotatesAtMostOncePerTokenLifetime(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.lifetime = time.Hour
	for r := int64(1); r <= 10; r++ {
		gh.repos[r] = comments.RepoPermission{Pull: true}
	}
	a := newAccess(gh, clock)
	// 100 minutes of checks across 10 repositories, one per minute: the
	// repository list expires 20 times, the token (1 h, reused until 5 min
	// before expiry) only once.
	for i := range 100 {
		if _, err := a.Permission(ctx, "u1", int64(i%10+1)); err != nil {
			t.Fatal(err)
		}
		clock.Advance(time.Minute)
	}
	if m, l := gh.counts(); m != 2 || l < 15 {
		t.Errorf("mints, lists = %d, %d; want 2 mints for 100 minutes of 1-hour tokens", m, l)
	}
}

func TestCachedAccessSharesBrowserTokens(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true}
	a := newAccess(gh, clock)

	// The browser refreshed (unscoped): the server reuses that token.
	a.TokenIssued("u1", comments.UserToken{Token: "ghu_browser", ExpiresAt: clock.Now().Add(8 * time.Hour)}, false)
	if _, err := a.Permission(ctx, "u1", 7); err != nil {
		t.Fatal(err)
	}
	if m, _ := gh.counts(); m != 0 || gh.gotToken != "ghu_browser" {
		t.Errorf("mints = %d, token %q; want the browser's token", m, gh.gotToken)
	}

	// A repository-scoped browser token is never reused; the cached one is
	// dropped because the rotation may have replaced it.
	a.TokenIssued("u1", comments.UserToken{Token: "ghu_scoped", ExpiresAt: clock.Now().Add(8 * time.Hour)}, true)
	a.InvalidateAll()
	_, _ = a.Permission(ctx, "u1", 7)
	if m, _ := gh.counts(); m != 1 || gh.gotToken == "ghu_scoped" {
		t.Errorf("mints = %d, token %q", m, gh.gotToken)
	}

	// A cached token GitHub rejects is replaced once, not reported as a
	// sign-out.
	gh.mu.Lock()
	gh.revoked[gh.gotToken] = true
	gh.mu.Unlock()
	a.InvalidateAll()
	if _, err := a.Permission(ctx, "u1", 7); err != nil {
		t.Fatalf("rejected cached token: %v", err)
	}
	if m, _ := gh.counts(); m != 2 {
		t.Errorf("mints = %d, want 2", m)
	}
}

func TestCachedAccessFailures(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true}
	gh.listErr = errors.New("github down")
	a := newAccess(gh, clock)
	if _, err := a.Permission(ctx, "u1", 7); err == nil || errors.Is(err, comments.ErrNotFound) {
		t.Fatalf("err = %v, want a transient error", err)
	}
	gh.mu.Lock()
	gh.listErr = nil
	gh.mu.Unlock()
	if p, err := a.Permission(ctx, "u1", 7); err != nil || !p.Pull {
		t.Fatalf("failures must not be cached: %+v, %v", p, err)
	}
	gh.mintErr = comments.ErrUnauthenticated
	if _, err := a.Permission(ctx, "u3", 7); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("mint failure err = %v", err)
	}
}

func TestCachedAccessLimitsMissesPerUser(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true}
	a := newAccess(gh, clock, func(c *comments.AccessConfig) {
		c.MissLimiter = comments.NewRateLimiter(2, 3*time.Second, clock)
	})
	for range 2 {
		_, _ = a.Permission(ctx, "u1", 7)
		a.Invalidate("u1")
	}
	if _, err := a.Permission(ctx, "u1", 7); !errors.Is(err, comments.ErrRateLimited) {
		t.Fatalf("third miss err = %v, want rate limited", err)
	}
	if _, err := a.Permission(ctx, "u2", 7); err != nil {
		t.Errorf("other users are not limited: %v", err)
	}
	clock.Advance(3 * time.Second)
	if _, err := a.Permission(ctx, "u1", 7); err != nil {
		t.Errorf("after refill: %v", err)
	}
	// Hits are never limited.
	for range 50 {
		if _, err := a.Permission(ctx, "u1", 7); err != nil {
			t.Fatalf("cached hit limited: %v", err)
		}
	}
}

func TestCachedAccessInvalidation(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true, Push: true}
	a := newAccess(gh, clock)
	for _, u := range []string{"u1", "u2"} {
		if _, err := a.Permission(ctx, u, 7); err != nil {
			t.Fatal(err)
		}
	}
	a.Invalidate("u1") // revocation: drop the repositories and the token
	_, _ = a.Permission(ctx, "u1", 7)
	_, _ = a.Permission(ctx, "u2", 7)
	if m, l := gh.counts(); m != 3 || l != 3 {
		t.Errorf("mints, lists = %d, %d; want only u1 refetched with a new token", m, l)
	}

	// Installation webhooks drop every repository list but keep tokens.
	gh.mu.Lock()
	gh.repos[7] = comments.RepoPermission{Pull: true}
	gh.mu.Unlock()
	a.InvalidateAll()
	if p, _ := a.Permission(ctx, "u2", 7); p.Push {
		t.Error("stale push permission after InvalidateAll")
	}
	if m, _ := gh.counts(); m != 3 {
		t.Errorf("InvalidateAll re-minted tokens: mints = %d", m)
	}
}

func TestCachedAccessBoundsUsers(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true}
	a := newAccess(gh, clock, func(c *comments.AccessConfig) { c.MaxUsers = 10 })
	for i := range 10 {
		_, _ = a.Permission(ctx, fmt.Sprintf("old%d", i), 7)
	}
	clock.Advance(9 * time.Hour) // old entries and tokens expired
	_, _ = a.Permission(ctx, "fresh", 7)
	if n := a.Users(); n > 10 {
		t.Errorf("users = %d, want at most 10", n)
	}
	_, l := gh.counts()
	_, _ = a.Permission(ctx, "fresh", 7)
	if _, l2 := gh.counts(); l2 != l {
		t.Error("eviction dropped the live user instead of expired ones")
	}
}

func TestCachedAccessCoalescesConcurrentMisses(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true}
	a := newAccess(gh, clock)
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := a.Permission(ctx, "u1", 7); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if m, l := gh.counts(); m != 1 || l != 1 {
		t.Errorf("mints, lists = %d, %d; want 1, 1", m, l)
	}
}

func TestCachedAccessFreshPermissionBypassesAndRefreshesTheCache(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{FullName: "o/r", Pull: true, Push: true, Admin: true}
	a := newAccess(gh, clock)
	if p, err := a.Permission(ctx, "u1", 7); err != nil || !p.Admin {
		t.Fatalf("cached = %+v, %v", p, err)
	}
	// Demoted on GitHub: the cache still says admin, a fresh check does not.
	gh.mu.Lock()
	gh.repos[7] = comments.RepoPermission{FullName: "o/r", Pull: true}
	gh.mu.Unlock()
	if p, _ := a.Permission(ctx, "u1", 7); !p.Admin {
		t.Fatal("cache already refreshed")
	}
	p, err := a.FreshPermission(ctx, "u1", 7)
	if err != nil || p.Admin || !p.Pull {
		t.Fatalf("fresh = %+v, %v", p, err)
	}
	if _, l := gh.counts(); l != 2 {
		t.Errorf("lists = %d, want 2", l)
	}
	// The fresh result replaced the cached list.
	if p, _ := a.Permission(ctx, "u1", 7); p.Admin {
		t.Error("cache not refreshed by the fresh check")
	}
	if _, l := gh.counts(); l != 2 {
		t.Errorf("lists after = %d, want 2", l)
	}
}

func TestCachedAccessFreshPermissionIsRateLimited(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	gh.repos[7] = comments.RepoPermission{Pull: true}
	a := newAccess(gh, clock, func(c *comments.AccessConfig) {
		c.MissLimiter = comments.NewRateLimiter(1, time.Hour, clock)
	})
	if _, err := a.FreshPermission(ctx, "u1", 7); err != nil {
		t.Fatal(err)
	}
	if _, err := a.FreshPermission(ctx, "u1", 7); !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("second fresh check = %v, want rate limited", err)
	}
}

func TestCachedAccessTokenIsReusedUntilTheMargin(t *testing.T) {
	clock := newClock()
	gh := newGitHub(clock)
	a := newAccess(gh, clock)
	t1, err := a.Token(ctx, "u1")
	if err != nil {
		t.Fatal(err)
	}
	t2, _ := a.Token(ctx, "u1")
	if t1 != t2 {
		t.Error("token not reused")
	}
	if m, _ := gh.counts(); m != 1 {
		t.Errorf("mints = %d", m)
	}
	clock.Advance(gh.lifetime - time.Minute) // inside the 5-minute margin
	if t3, _ := a.Token(ctx, "u1"); t3 == t1 {
		t.Error("token near expiry reused")
	}
	gh.mintErr = comments.ErrUnauthenticated
	a.Invalidate("u1")
	if _, err := a.Token(ctx, "u1"); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("mint failure err = %v", err)
	}
}

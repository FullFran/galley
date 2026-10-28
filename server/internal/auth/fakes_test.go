package auth_test

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
)

// fakeProvider imitates GitHub: every refresh rotates the pair and
// invalidates the previous refresh token.
type fakeProvider struct {
	mu           sync.Mutex
	validRefresh string
	rotations    int
	exchanged    []string // "code|verifier"
	lastRepoID   int64
	user         auth.GitHubUser
	refreshDelay time.Duration
	now          func() time.Time
	// afterRotate, when set, runs after GitHub has rotated the pair and before
	// the response is returned; a cancelled ctx then loses the response.
	afterRotate func(ctx context.Context)
}

func (p *fakeProvider) AuthorizeURL(state, challenge string) string {
	return "https://github.test/authorize?state=" + state + "&code_challenge=" + challenge
}

func (p *fakeProvider) Exchange(_ context.Context, code, verifier string) (auth.TokenSet, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.exchanged = append(p.exchanged, code+"|"+verifier)
	return p.rotateLocked(), nil
}

func (p *fakeProvider) Refresh(ctx context.Context, rt string, repoID int64) (auth.TokenSet, error) {
	p.mu.Lock()
	valid := p.validRefresh
	p.mu.Unlock()
	if rt != valid {
		return auth.TokenSet{}, auth.ErrTokenRevoked
	}
	time.Sleep(p.refreshDelay) // widen the race window for concurrency tests
	p.mu.Lock()
	defer p.mu.Unlock()
	if rt != p.validRefresh {
		return auth.TokenSet{}, auth.ErrTokenRevoked
	}
	p.lastRepoID = repoID
	set := p.rotateLocked()
	if p.afterRotate != nil {
		p.afterRotate(ctx)
		if err := ctx.Err(); err != nil {
			return auth.TokenSet{}, err
		}
	}
	return set, nil
}

func (p *fakeProvider) rotateLocked() auth.TokenSet {
	p.rotations++
	n := strconv.Itoa(p.rotations)
	p.validRefresh = "ghr_" + n
	return auth.TokenSet{
		AccessToken:      "ghu_" + n,
		AccessExpiresAt:  p.now().Add(8 * time.Hour),
		RefreshToken:     p.validRefresh,
		RefreshExpiresAt: p.now().Add(180 * 24 * time.Hour),
	}
}

func (p *fakeProvider) FetchUser(context.Context, string) (auth.GitHubUser, error) {
	return p.user, nil
}

// memStore implements both UserTokenStore and SessionStore in memory.
type memStore struct {
	mu       sync.Mutex
	users    map[int64]auth.User
	tokens   map[string]auth.StoredToken
	sessions map[string]auth.Session
	// failSaves makes the next n SaveRefreshToken calls fail.
	failSaves int
}

func newMemStore() *memStore {
	return &memStore{users: map[int64]auth.User{}, tokens: map[string]auth.StoredToken{}, sessions: map[string]auth.Session{}}
}

func (s *memStore) UpsertUser(_ context.Context, u auth.GitHubUser) (auth.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.users[u.ID]
	if !ok {
		existing = auth.User{ID: fmt.Sprintf("u%d", len(s.users)+1), GitHubID: u.ID}
	}
	existing.Login = u.Login
	s.users[u.ID] = existing
	return existing, nil
}

func (s *memStore) UserByGitHubID(_ context.Context, id int64) (auth.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok {
		return auth.User{}, auth.ErrNotFound
	}
	return u, nil
}

func (s *memStore) SaveRefreshToken(ctx context.Context, userID string, t auth.StoredToken) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failSaves > 0 {
		s.failSaves--
		return errors.New("store unavailable")
	}
	s.tokens[userID] = t
	return nil
}

func (s *memStore) LoadRefreshToken(_ context.Context, userID string) (auth.StoredToken, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[userID]
	if !ok {
		return auth.StoredToken{}, auth.ErrNotFound
	}
	return t, nil
}

func (s *memStore) DeleteRefreshToken(_ context.Context, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tokens, userID)
	return nil
}

func (s *memStore) CreateSession(_ context.Context, sess auth.Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[sess.TokenHash] = sess
	return nil
}

func (s *memStore) SessionByHash(_ context.Context, h string) (auth.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[h]
	if !ok {
		return auth.Session{}, auth.ErrNotFound
	}
	return sess, nil
}

func (s *memStore) DeleteSession(_ context.Context, h string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, h)
	return nil
}

func (s *memStore) DeleteUserSessions(_ context.Context, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for h, sess := range s.sessions {
		if sess.UserID == userID {
			delete(s.sessions, h)
		}
	}
	return nil
}

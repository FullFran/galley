package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/FullFran/galley/server/internal/secret"
)

// loginCookieAAD binds sealed login cookies to their purpose.
var loginCookieAAD = []byte("galley-oauth-login-v1")

// Config wires a Service.
type Config struct {
	Provider OAuthProvider
	Users    UserTokenStore
	Sessions SessionStore
	Sealer   *secret.Sealer
	// SessionTTL is the absolute lifetime of a browser session.
	SessionTTL time.Duration
	// LoginTTL bounds the time between StartLogin and Callback.
	LoginTTL time.Duration
	// RefreshTimeout bounds a refresh and the save of the rotated token,
	// which run detached from the request. Defaults to 30 seconds.
	RefreshTimeout time.Duration
	// Now defaults to time.Now.
	Now func() time.Time
	// OnRevoke, when set, is called with the galley user id whenever the
	// user's GitHub authorization is gone (revocation webhook, rejected,
	// expired or unreadable refresh token), so caches of the user's GitHub
	// permissions can be dropped. reason tells real revocations from tokens
	// that only became unusable. It must not block.
	OnRevoke func(userID string, reason RevokeReason)
	// OnTokenIssued, when set, is called after every successful refresh with
	// the new access token, so a server-side token cache can follow
	// rotations. It runs under the user's lock and must not block or call
	// back into the Service.
	OnTokenIssued func(userID string, tok AccessToken)
}

// tokenReuseMargin is how long before expiry a current access token stops
// being handed out. It must exceed the browser's own refresh margin.
const tokenReuseMargin = 5 * time.Minute

// Service runs the sign-in use cases.
type Service struct {
	cfg   Config
	locks keyedMutex
	// current holds each user's latest access token (userID → AccessToken).
	// Every refresh rotates the pair and kills the previous access token at
	// GitHub, so all tabs, devices and server-side calls share this one.
	current sync.Map
}

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Provider == nil || cfg.Users == nil || cfg.Sessions == nil || cfg.Sealer == nil {
		return nil, errors.New("auth: provider, stores and sealer are required")
	}
	if cfg.SessionTTL <= 0 || cfg.LoginTTL <= 0 {
		return nil, errors.New("auth: session and login lifetimes must be positive")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.RefreshTimeout <= 0 {
		cfg.RefreshTimeout = 30 * time.Second
	}
	return &Service{cfg: cfg}, nil
}

// Login is the result of StartLogin: where to send the browser and the sealed
// value to keep in a short-lived cookie until the callback.
type Login struct {
	URL    string
	Cookie string
}

// NewSession is an opaque session token for the browser cookie.
type NewSession struct {
	Token     string
	ExpiresAt time.Time
}

// AccessToken is a GitHub user access token handed to the browser.
type AccessToken struct {
	Token     string
	ExpiresAt time.Time
}

type loginState struct {
	State    string `json:"s"`
	Verifier string `json:"v"`
	IssuedAt int64  `json:"t"`
}

// PKCEChallenge returns the S256 code challenge for a verifier (RFC 7636).
func PKCEChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// StartLogin creates a fresh state and PKCE verifier.
func (s *Service) StartLogin() (Login, error) {
	state, err := secret.RandomToken()
	if err != nil {
		return Login{}, err
	}
	verifier, err := secret.RandomToken() // 43 base64url chars, within RFC 7636 limits
	if err != nil {
		return Login{}, err
	}
	payload, err := json.Marshal(loginState{State: state, Verifier: verifier, IssuedAt: s.cfg.Now().Unix()})
	if err != nil {
		return Login{}, err
	}
	cookie, err := s.cfg.Sealer.Seal(payload, loginCookieAAD)
	if err != nil {
		return Login{}, err
	}
	return Login{URL: s.cfg.Provider.AuthorizeURL(state, PKCEChallenge(verifier)), Cookie: cookie}, nil
}

// Callback completes a login: it checks the state against the sealed cookie,
// exchanges the code, stores the encrypted refresh token and opens a session.
func (s *Service) Callback(ctx context.Context, cookie, state, code string) (NewSession, error) {
	ls, err := s.openLogin(cookie)
	if err != nil {
		return NewSession{}, err
	}
	if state == "" || code == "" || subtle.ConstantTimeCompare([]byte(state), []byte(ls.State)) != 1 {
		return NewSession{}, ErrInvalidLogin
	}

	tokens, err := s.cfg.Provider.Exchange(ctx, code, ls.Verifier)
	if err != nil {
		return NewSession{}, fmt.Errorf("auth: exchange code: %w", err)
	}
	ghUser, err := s.cfg.Provider.FetchUser(ctx, tokens.AccessToken)
	if err != nil {
		return NewSession{}, fmt.Errorf("auth: fetch user: %w", err)
	}
	user, err := s.cfg.Users.UpsertUser(ctx, ghUser)
	if err != nil {
		return NewSession{}, fmt.Errorf("auth: upsert user: %w", err)
	}

	unlock := s.locks.lock(user.ID)
	err = s.saveRefresh(ctx, user.ID, tokens)
	// A new authorization starts over: the next request refreshes from it
	// instead of serving the previous authorization's token.
	s.current.Delete(user.ID)
	unlock()
	if err != nil {
		return NewSession{}, err
	}

	token, err := secret.RandomToken()
	if err != nil {
		return NewSession{}, err
	}
	expires := s.cfg.Now().Add(s.cfg.SessionTTL)
	if err := s.cfg.Sessions.CreateSession(ctx, Session{TokenHash: secret.HashToken(token), UserID: user.ID, ExpiresAt: expires}); err != nil {
		return NewSession{}, fmt.Errorf("auth: create session: %w", err)
	}
	return NewSession{Token: token, ExpiresAt: expires}, nil
}

func (s *Service) openLogin(cookie string) (loginState, error) {
	if cookie == "" {
		return loginState{}, ErrInvalidLogin
	}
	raw, err := s.cfg.Sealer.Open(cookie, loginCookieAAD)
	if err != nil {
		return loginState{}, ErrInvalidLogin
	}
	var ls loginState
	if err := json.Unmarshal(raw, &ls); err != nil || ls.State == "" || ls.Verifier == "" {
		return loginState{}, ErrInvalidLogin
	}
	age := s.cfg.Now().Sub(time.Unix(ls.IssuedAt, 0))
	if age < 0 || age > s.cfg.LoginTTL {
		return loginState{}, ErrInvalidLogin
	}
	return ls, nil
}

// IssueToken returns the session user's GitHub access token (see
// UserAccessToken). rejected is a token the browser saw GitHub refuse.
func (s *Service) IssueToken(ctx context.Context, sessionToken, rejected string) (AccessToken, error) {
	sess, err := s.session(ctx, sessionToken)
	if err != nil {
		return AccessToken{}, err
	}
	return s.UserAccessToken(ctx, sess.UserID, rejected)
}

// Authenticate resolves a session token to its user without touching GitHub.
func (s *Service) Authenticate(ctx context.Context, sessionToken string) (User, error) {
	sess, err := s.session(ctx, sessionToken)
	if err != nil {
		return User{}, err
	}
	u, err := s.cfg.Users.UserByID(ctx, sess.UserID)
	if errors.Is(err, ErrNotFound) {
		return User{}, ErrUnauthenticated
	}
	if err != nil {
		return User{}, fmt.Errorf("auth: load user: %w", err)
	}
	return u, nil
}

// UserAccessToken returns the user's current GitHub access token, for the
// browser and for server-side calls alike. It refreshes the stored pair only
// when the current token is missing, close to expiry, or is rejected (the
// token a caller saw GitHub refuse; a stale report changes nothing). Each
// refresh kills the previous access token, so refreshing on every call made
// tabs, devices and the server sign each other out. Tokens are not scoped to
// a repository for the same reason. Refreshes for one user are serialized.
// ErrUnauthenticated means the user must sign in again.
func (s *Service) UserAccessToken(ctx context.Context, userID, rejected string) (AccessToken, error) {
	if userID == "" {
		return AccessToken{}, ErrUnauthenticated
	}
	unlock := s.locks.lock(userID)
	defer unlock()
	if v, ok := s.current.Load(userID); ok {
		tok := v.(AccessToken)
		if tok.Token != rejected && s.cfg.Now().Add(tokenReuseMargin).Before(tok.ExpiresAt) {
			return tok, nil
		}
		s.current.Delete(userID)
	}

	stored, err := s.cfg.Users.LoadRefreshToken(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return AccessToken{}, ErrUnauthenticated
	}
	if err != nil {
		return AccessToken{}, fmt.Errorf("auth: load refresh token: %w", err)
	}
	if !stored.ExpiresAt.IsZero() && !s.cfg.Now().Before(stored.ExpiresAt) {
		_ = s.cfg.Users.DeleteRefreshToken(ctx, userID)
		s.notifyRevoked(userID, RevokeExpired)
		return AccessToken{}, ErrUnauthenticated
	}
	refresh, err := s.cfg.Sealer.Open(stored.Ciphertext, []byte(userID))
	if err != nil {
		// Unreadable (for example after a key change): it can never be used.
		_ = s.cfg.Users.DeleteRefreshToken(ctx, userID)
		s.notifyRevoked(userID, RevokeUnreadable)
		return AccessToken{}, ErrUnauthenticated
	}

	// GitHub invalidates the old pair as soon as it rotates, so a refresh that
	// succeeded must be persisted even if the browser aborts the request.
	// Refresh and save therefore run detached from the request, bounded by
	// RefreshTimeout.
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.cfg.RefreshTimeout)
	defer cancel()

	tokens, err := s.cfg.Provider.Refresh(dctx, string(refresh), 0)
	if errors.Is(err, ErrTokenRevoked) {
		s.notifyRevoked(userID, RevokeRejected)
		if delErr := s.cfg.Users.DeleteRefreshToken(dctx, userID); delErr != nil {
			return AccessToken{}, fmt.Errorf("auth: delete rejected refresh token: %w", delErr)
		}
		return AccessToken{}, ErrUnauthenticated
	}
	if err != nil {
		return AccessToken{}, fmt.Errorf("auth: refresh: %w", err)
	}
	if err := s.saveRefresh(dctx, userID, tokens); err != nil {
		if err = s.saveRefresh(dctx, userID, tokens); err != nil {
			return AccessToken{}, err
		}
	}
	tok := AccessToken{Token: tokens.AccessToken, ExpiresAt: tokens.AccessExpiresAt}
	s.current.Store(userID, tok)
	if s.cfg.OnTokenIssued != nil {
		s.cfg.OnTokenIssued(userID, tok)
	}
	return tok, nil
}

// Logout deletes the session. Unknown sessions are not an error.
func (s *Service) Logout(ctx context.Context, sessionToken string) error {
	if sessionToken == "" {
		return nil
	}
	err := s.cfg.Sessions.DeleteSession(ctx, secret.HashToken(sessionToken))
	if err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("auth: delete session: %w", err)
	}
	return nil
}

// Revoke deletes the stored token and all sessions of a GitHub user, after
// the user revoked the app's authorization. Unknown users are not an error.
func (s *Service) Revoke(ctx context.Context, githubID int64) error {
	user, err := s.cfg.Users.UserByGitHubID(ctx, githubID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("auth: find user: %w", err)
	}
	unlock := s.locks.lock(user.ID)
	defer unlock()
	if err := s.cfg.Users.DeleteRefreshToken(ctx, user.ID); err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("auth: delete refresh token: %w", err)
	}
	s.notifyRevoked(user.ID, RevokeWebhook)
	if err := s.cfg.Sessions.DeleteUserSessions(ctx, user.ID); err != nil {
		return fmt.Errorf("auth: delete sessions: %w", err)
	}
	return nil
}

// RevokeReason says why a user's GitHub authorization is gone.
type RevokeReason string

// Revocation reasons.
const (
	// RevokeWebhook: the user revoked the app (github_app_authorization).
	RevokeWebhook RevokeReason = "webhook"
	// RevokeRejected: GitHub answered bad_refresh_token. It also follows a
	// lost rotation, so it is not treated as the user's choice.
	RevokeRejected RevokeReason = "bad_refresh_token"
	// RevokeExpired: the stored refresh token passed its expiry.
	RevokeExpired RevokeReason = "expired"
	// RevokeUnreadable: the stored refresh token no longer opens (key change).
	RevokeUnreadable RevokeReason = "unreadable"
)

// Revoked reports that the user revoked the app (the webhook), as opposed to
// a token galley can no longer use: expired, unreadable after a key change,
// or rejected by GitHub (which a lost rotation also causes).
func (r RevokeReason) Revoked() bool { return r == RevokeWebhook }

func (s *Service) notifyRevoked(userID string, reason RevokeReason) {
	s.current.Delete(userID)
	if s.cfg.OnRevoke != nil {
		s.cfg.OnRevoke(userID, reason)
	}
}

func (s *Service) session(ctx context.Context, token string) (Session, error) {
	if token == "" {
		return Session{}, ErrUnauthenticated
	}
	hash := secret.HashToken(token)
	sess, err := s.cfg.Sessions.SessionByHash(ctx, hash)
	if errors.Is(err, ErrNotFound) {
		return Session{}, ErrUnauthenticated
	}
	if err != nil {
		return Session{}, fmt.Errorf("auth: load session: %w", err)
	}
	if !s.cfg.Now().Before(sess.ExpiresAt) {
		_ = s.cfg.Sessions.DeleteSession(ctx, hash)
		return Session{}, ErrUnauthenticated
	}
	return sess, nil
}

func (s *Service) saveRefresh(ctx context.Context, userID string, tokens TokenSet) error {
	if tokens.RefreshToken == "" {
		return errors.New("auth: provider returned no refresh token")
	}
	sealed, err := s.cfg.Sealer.Seal([]byte(tokens.RefreshToken), []byte(userID))
	if err != nil {
		return err
	}
	if err := s.cfg.Users.SaveRefreshToken(ctx, userID, StoredToken{Ciphertext: sealed, ExpiresAt: tokens.RefreshExpiresAt}); err != nil {
		return fmt.Errorf("auth: save refresh token: %w", err)
	}
	return nil
}

// keyedMutex hands out one mutex per key. Entries are never removed; the
// number of keys is bounded by the number of users.
type keyedMutex struct {
	mu sync.Mutex
	m  map[string]*sync.Mutex
}

func (k *keyedMutex) lock(key string) (unlock func()) {
	k.mu.Lock()
	if k.m == nil {
		k.m = map[string]*sync.Mutex{}
	}
	m, ok := k.m[key]
	if !ok {
		m = &sync.Mutex{}
		k.m[key] = m
	}
	k.mu.Unlock()
	m.Lock()
	return m.Unlock
}

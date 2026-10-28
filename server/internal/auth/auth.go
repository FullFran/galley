// Package auth implements galley's GitHub App sign-in: OAuth state and PKCE,
// server-side code exchange and refresh, encrypted refresh-token storage, and
// opaque browser sessions. Infrastructure lives behind the ports below.
package auth

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrInvalidLogin means the OAuth callback did not match a login started
	// by this browser (missing, expired or tampered cookie, or state mismatch).
	ErrInvalidLogin = errors.New("auth: invalid login attempt")
	// ErrUnauthenticated means there is no usable session or stored token.
	ErrUnauthenticated = errors.New("auth: unauthenticated")
	// ErrTokenRevoked is returned by an OAuthProvider when GitHub rejects the
	// refresh token (revoked, expired or already rotated).
	ErrTokenRevoked = errors.New("auth: refresh token rejected")
	// ErrNotFound is returned by stores when a record does not exist.
	ErrNotFound = errors.New("auth: not found")
)

// GitHubUser is the identity GitHub reports for a user access token.
type GitHubUser struct {
	ID    int64
	Login string
}

// User is a galley user, keyed by its GitHub id.
type User struct {
	ID       string
	GitHubID int64
	Login    string
}

// TokenSet is a user access token and its rotating refresh token.
type TokenSet struct {
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string
	RefreshExpiresAt time.Time
}

// StoredToken is an encrypted refresh token as persisted.
type StoredToken struct {
	Ciphertext string
	ExpiresAt  time.Time
}

// Session is a browser session. Only the hash of the session token is stored.
type Session struct {
	TokenHash string
	UserID    string
	ExpiresAt time.Time
}

// OAuthProvider talks to GitHub's OAuth endpoints.
type OAuthProvider interface {
	// AuthorizeURL returns the URL that starts the authorization flow.
	AuthorizeURL(state, codeChallenge string) string
	// Exchange trades an authorization code and PKCE verifier for tokens.
	Exchange(ctx context.Context, code, codeVerifier string) (TokenSet, error)
	// Refresh rotates a refresh token. repositoryID, when non-zero, asks
	// GitHub to limit the new access token to that repository.
	Refresh(ctx context.Context, refreshToken string, repositoryID int64) (TokenSet, error)
	// FetchUser returns the user that owns accessToken.
	FetchUser(ctx context.Context, accessToken string) (GitHubUser, error)
}

// UserTokenStore persists users and their encrypted refresh tokens.
type UserTokenStore interface {
	UpsertUser(ctx context.Context, u GitHubUser) (User, error)
	UserByGitHubID(ctx context.Context, githubID int64) (User, error)
	SaveRefreshToken(ctx context.Context, userID string, t StoredToken) error
	LoadRefreshToken(ctx context.Context, userID string) (StoredToken, error)
	DeleteRefreshToken(ctx context.Context, userID string) error
}

// SessionStore persists browser sessions by token hash.
type SessionStore interface {
	CreateSession(ctx context.Context, s Session) error
	SessionByHash(ctx context.Context, tokenHash string) (Session, error)
	DeleteSession(ctx context.Context, tokenHash string) error
	DeleteUserSessions(ctx context.Context, userID string) error
}

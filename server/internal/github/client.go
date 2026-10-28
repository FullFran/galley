// Package github is the HTTP adapter for GitHub App user authorization. It
// implements auth.OAuthProvider.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
)

// Default base URLs.
const (
	DefaultOAuthBaseURL = "https://github.com"
	DefaultAPIBaseURL   = "https://api.github.com"
)

const (
	maxResponseBytes = 1 << 20
	// requestTimeout bounds every call, even with an HTTPClient that has no
	// timeout, because the auth service runs refreshes detached from the
	// request context.
	requestTimeout = 15 * time.Second
)

// Client calls GitHub's OAuth and REST endpoints. Base URLs are configurable
// so tests can point it at an httptest server.
type Client struct {
	ClientID     string
	ClientSecret string
	// RedirectURI is the registered callback URL of the GitHub App.
	RedirectURI  string
	OAuthBaseURL string
	APIBaseURL   string
	HTTPClient   *http.Client
	// Now defaults to time.Now; used to turn expires_in into a timestamp.
	Now func() time.Time
}

var _ auth.OAuthProvider = (*Client)(nil)

// AuthorizeURL implements auth.OAuthProvider.
func (c *Client) AuthorizeURL(state, codeChallenge string) string {
	q := url.Values{
		"client_id":             {c.ClientID},
		"redirect_uri":          {c.RedirectURI},
		"state":                 {state},
		"code_challenge":        {codeChallenge},
		"code_challenge_method": {"S256"},
	}
	return strings.TrimRight(c.oauthBase(), "/") + "/login/oauth/authorize?" + q.Encode()
}

// Exchange implements auth.OAuthProvider.
func (c *Client) Exchange(ctx context.Context, code, codeVerifier string) (auth.TokenSet, error) {
	return c.token(ctx, url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"code":          {code},
		"code_verifier": {codeVerifier},
		"redirect_uri":  {c.RedirectURI},
	})
}

// Refresh implements auth.OAuthProvider. GitHub documents repository_id for
// the code exchange; for refresh it is sent as a best-effort hint and GitHub
// may ignore it.
func (c *Client) Refresh(ctx context.Context, refreshToken string, repositoryID int64) (auth.TokenSet, error) {
	form := url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}
	if repositoryID > 0 {
		form.Set("repository_id", strconv.FormatInt(repositoryID, 10))
	}
	return c.token(ctx, form)
}

type tokenResponse struct {
	AccessToken           string `json:"access_token"`
	ExpiresIn             int64  `json:"expires_in"`
	RefreshToken          string `json:"refresh_token"`
	RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
	Error                 string `json:"error"`
}

// token posts to the token endpoint. GitHub reports OAuth errors with HTTP
// 200 and an "error" field, so the body is checked regardless of status.
// Error messages carry only the error code, never tokens or descriptions.
func (c *Client) token(ctx context.Context, form url.Values) (auth.TokenSet, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	endpoint := strings.TrimRight(c.oauthBase(), "/") + "/login/oauth/access_token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return auth.TokenSet{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return auth.TokenSet{}, fmt.Errorf("github: token request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return auth.TokenSet{}, fmt.Errorf("github: token endpoint status %d", resp.StatusCode)
	}

	var body tokenResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&body); err != nil {
		return auth.TokenSet{}, errors.New("github: token endpoint returned an invalid body")
	}
	switch {
	case body.Error == "bad_refresh_token":
		return auth.TokenSet{}, auth.ErrTokenRevoked
	case body.Error != "":
		return auth.TokenSet{}, fmt.Errorf("github: token error %q", body.Error)
	case body.AccessToken == "" || body.RefreshToken == "":
		// galley requires expiring user tokens (the default for GitHub Apps).
		return auth.TokenSet{}, errors.New("github: token response without an access or refresh token")
	}

	now := c.now()
	set := auth.TokenSet{AccessToken: body.AccessToken, RefreshToken: body.RefreshToken}
	if body.ExpiresIn > 0 {
		set.AccessExpiresAt = now.Add(time.Duration(body.ExpiresIn) * time.Second)
	}
	if body.RefreshTokenExpiresIn > 0 {
		set.RefreshExpiresAt = now.Add(time.Duration(body.RefreshTokenExpiresIn) * time.Second)
	}
	return set, nil
}

// FetchUser implements auth.OAuthProvider.
func (c *Client) FetchUser(ctx context.Context, accessToken string) (auth.GitHubUser, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	endpoint := strings.TrimRight(c.apiBase(), "/") + "/user"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return auth.GitHubUser{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := c.httpClient().Do(req)
	if err != nil {
		return auth.GitHubUser{}, fmt.Errorf("github: user request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return auth.GitHubUser{}, fmt.Errorf("github: user endpoint status %d", resp.StatusCode)
	}
	var body struct {
		ID    int64  `json:"id"`
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&body); err != nil || body.ID == 0 || body.Login == "" {
		return auth.GitHubUser{}, errors.New("github: user endpoint returned an invalid body")
	}
	return auth.GitHubUser{ID: body.ID, Login: body.Login}, nil
}

func (c *Client) oauthBase() string {
	if c.OAuthBaseURL == "" {
		return DefaultOAuthBaseURL
	}
	return c.OAuthBaseURL
}

func (c *Client) apiBase() string {
	if c.APIBaseURL == "" {
		return DefaultAPIBaseURL
	}
	return c.APIBaseURL
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient == nil {
		return &http.Client{Timeout: requestTimeout}
	}
	return c.HTTPClient
}

func (c *Client) now() time.Time {
	if c.Now == nil {
		return time.Now()
	}
	return c.Now()
}

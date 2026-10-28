package github_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/github"
)

var now = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

func newClient(t *testing.T, h http.HandlerFunc) *github.Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &github.Client{
		ClientID:     "Iv1.client",
		ClientSecret: "shh",
		RedirectURI:  "https://api.test/api/galley/auth/callback",
		OAuthBaseURL: srv.URL,
		APIBaseURL:   srv.URL,
		HTTPClient:   srv.Client(),
		Now:          func() time.Time { return now },
	}
}

const okTokens = `{"access_token":"ghu_a","expires_in":28800,"refresh_token":"ghr_b","refresh_token_expires_in":15897600,"token_type":"bearer","scope":""}`

func TestAuthorizeURL(t *testing.T) {
	c := &github.Client{ClientID: "Iv1.client", RedirectURI: "https://api.test/cb", OAuthBaseURL: "https://github.com"}
	u, err := url.Parse(c.AuthorizeURL("st", "ch"))
	if err != nil {
		t.Fatal(err)
	}
	if u.Host != "github.com" || u.Path != "/login/oauth/authorize" {
		t.Errorf("url = %s", u)
	}
	want := map[string]string{"client_id": "Iv1.client", "redirect_uri": "https://api.test/cb", "state": "st", "code_challenge": "ch", "code_challenge_method": "S256"}
	for k, v := range want {
		if got := u.Query().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

func TestExchange(t *testing.T) {
	var form url.Values
	c := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/login/oauth/access_token" || r.Header.Get("Accept") != "application/json" {
			t.Errorf("request %s %s Accept=%q", r.Method, r.URL.Path, r.Header.Get("Accept"))
		}
		_ = r.ParseForm()
		form = r.PostForm
		_, _ = w.Write([]byte(okTokens))
	})
	got, err := c.Exchange(context.Background(), "code-1", "verifier-1")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"client_id": "Iv1.client", "client_secret": "shh", "code": "code-1", "code_verifier": "verifier-1", "redirect_uri": "https://api.test/api/galley/auth/callback"}
	for k, v := range want {
		if form.Get(k) != v {
			t.Errorf("form %s = %q, want %q", k, form.Get(k), v)
		}
	}
	if got.AccessToken != "ghu_a" || got.RefreshToken != "ghr_b" ||
		!got.AccessExpiresAt.Equal(now.Add(8*time.Hour)) || !got.RefreshExpiresAt.Equal(now.Add(15897600*time.Second)) {
		t.Errorf("tokens = %+v", got)
	}
}

func TestRefresh(t *testing.T) {
	tests := []struct {
		name     string
		repoID   int64
		wantRepo string
	}{
		{name: "without repository", repoID: 0, wantRepo: ""},
		{name: "scoped to repository", repoID: 123, wantRepo: "123"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var form url.Values
			c := newClient(t, func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				form = r.PostForm
				_, _ = w.Write([]byte(okTokens))
			})
			if _, err := c.Refresh(context.Background(), "ghr_old", tt.repoID); err != nil {
				t.Fatal(err)
			}
			if form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "ghr_old" || form.Get("client_secret") != "shh" {
				t.Errorf("form = %v", form)
			}
			if form.Get("repository_id") != tt.wantRepo {
				t.Errorf("repository_id = %q, want %q", form.Get("repository_id"), tt.wantRepo)
			}
		})
	}
}

func TestTokenErrors(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		body        string
		wantRevoked bool
	}{
		{name: "200 with bad_refresh_token", status: 200, body: `{"error":"bad_refresh_token","error_description":"The refresh token passed is incorrect or expired."}`, wantRevoked: true},
		{name: "200 with another error", status: 200, body: `{"error":"incorrect_client_credentials"}`},
		{name: "missing refresh token (non-expiring tokens)", status: 200, body: `{"access_token":"ghu_a","token_type":"bearer"}`},
		{name: "server error", status: 502, body: `oops`},
		{name: "not json", status: 200, body: `access_token=ghu_a`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := newClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			})
			_, err := c.Refresh(context.Background(), "ghr_old", 0)
			if err == nil {
				t.Fatal("err = nil")
			}
			if errors.Is(err, auth.ErrTokenRevoked) != tt.wantRevoked {
				t.Errorf("err = %v, revoked want %v", err, tt.wantRevoked)
			}
		})
	}
}

func TestFetchUser(t *testing.T) {
	c := newClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user" || r.Header.Get("Authorization") != "Bearer ghu_a" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"id":42,"login":"octo","name":"Octo Cat"}`))
	})
	u, err := c.FetchUser(context.Background(), "ghu_a")
	if err != nil {
		t.Fatal(err)
	}
	if u.ID != 42 || u.Login != "octo" {
		t.Errorf("user = %+v", u)
	}
	if _, err := c.FetchUser(context.Background(), "wrong"); err == nil {
		t.Error("401 from GitHub was accepted")
	}
}

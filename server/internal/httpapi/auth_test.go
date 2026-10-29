package httpapi_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/httpapi"
)

const (
	frontend      = "https://galley.fullfran.com"
	webhookSecret = "hook-secret"
)

var expiry = time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)

// fakeAuth records calls and returns canned results.
type fakeAuth struct {
	mu          sync.Mutex
	callbackErr error
	issueErr    error
	gotCookie   string
	gotState    string
	gotSession  string
	gotRejected string
	loggedOut   []string
	revoked     []int64
	issueCalls  int
	authErr     error
}

func (f *fakeAuth) Authenticate(_ context.Context, sessionToken string) (auth.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gotSession = sessionToken
	if f.authErr != nil {
		return auth.User{}, f.authErr
	}
	return auth.User{ID: "u1", GitHubID: 42, Login: "octo"}, nil
}

func (f *fakeAuth) StartLogin() (auth.Login, error) {
	return auth.Login{URL: "https://github.com/login/oauth/authorize?state=s1", Cookie: "sealed-login"}, nil
}

func (f *fakeAuth) Callback(_ context.Context, cookie, state, _ string) (auth.NewSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gotCookie, f.gotState = cookie, state
	if f.callbackErr != nil {
		return auth.NewSession{}, f.callbackErr
	}
	return auth.NewSession{Token: "session-token", ExpiresAt: expiry}, nil
}

func (f *fakeAuth) IssueToken(_ context.Context, sessionToken, rejected string) (auth.AccessToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issueCalls++
	f.gotSession, f.gotRejected = sessionToken, rejected
	if f.issueErr != nil {
		return auth.AccessToken{}, f.issueErr
	}
	return auth.AccessToken{Token: "ghu_x", ExpiresAt: expiry}, nil
}

func (f *fakeAuth) Logout(_ context.Context, sessionToken string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.loggedOut = append(f.loggedOut, sessionToken)
	return nil
}

func (f *fakeAuth) Revoke(_ context.Context, githubID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, githubID)
	return nil
}

func testDeps(f *fakeAuth) httpapi.Deps {
	return httpapi.Deps{Auth: f, FrontendOrigin: frontend, WebhookSecret: []byte(webhookSecret)}
}

func do(t *testing.T, h http.Handler, req *http.Request) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Result()
}

func cookieNamed(resp *http.Response, name string) *http.Cookie {
	for _, c := range resp.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func browserPost(path, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Origin", frontend)
	req.Header.Set("X-Galley-CSRF", "1")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: httpapi.SessionCookie, Value: "session-token"})
	return req
}

func TestLoginRedirectsWithSealedCookie(t *testing.T) {
	resp := do(t, newTestHandler(t, testDeps(&fakeAuth{})), httptest.NewRequest(http.MethodGet, "/api/galley/auth/login", nil))
	if resp.StatusCode != http.StatusFound || !strings.HasPrefix(resp.Header.Get("Location"), "https://github.com/login/oauth/authorize") {
		t.Fatalf("status %d location %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	c := cookieNamed(resp, httpapi.LoginCookie)
	if c == nil {
		t.Fatal("no login cookie")
	}
	if c.Name != "__Host-galley_oauth" || c.Value != "sealed-login" || c.MaxAge != 600 || !c.Secure || !c.HttpOnly ||
		c.Path != "/" || c.Domain != "" || c.SameSite != http.SameSiteLaxMode {
		t.Errorf("login cookie = %+v", c)
	}
}

func TestCallback(t *testing.T) {
	t.Run("success sets session cookie and redirects without tokens", func(t *testing.T) {
		f := &fakeAuth{}
		req := httptest.NewRequest(http.MethodGet, "/api/galley/auth/callback?code=c1&state=s1", nil)
		req.AddCookie(&http.Cookie{Name: httpapi.LoginCookie, Value: "sealed-login"})
		resp := do(t, newTestHandler(t, testDeps(f)), req)

		if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != frontend+"/" {
			t.Fatalf("status %d location %q", resp.StatusCode, resp.Header.Get("Location"))
		}
		if f.gotCookie != "sealed-login" || f.gotState != "s1" {
			t.Errorf("service got cookie %q state %q", f.gotCookie, f.gotState)
		}
		s := cookieNamed(resp, httpapi.SessionCookie)
		if s == nil {
			t.Fatal("no session cookie")
		}
		if s.Name != "__Host-galley_session" || s.Value != "session-token" || !s.Secure || !s.HttpOnly ||
			s.Path != "/" || s.Domain != "" || s.SameSite != http.SameSiteStrictMode || s.MaxAge <= 0 {
			t.Errorf("session cookie = %+v", s)
		}
		if l := cookieNamed(resp, httpapi.LoginCookie); l == nil || l.MaxAge >= 0 {
			t.Errorf("login cookie not cleared: %+v", l)
		}
	})
	t.Run("invalid login redirects with a failure flag and no session", func(t *testing.T) {
		f := &fakeAuth{callbackErr: auth.ErrInvalidLogin}
		req := httptest.NewRequest(http.MethodGet, "/api/galley/auth/callback?code=c1&state=bad", nil)
		req.AddCookie(&http.Cookie{Name: httpapi.LoginCookie, Value: "sealed-login"})
		resp := do(t, newTestHandler(t, testDeps(f)), req)
		if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != frontend+"/?login=failed" {
			t.Fatalf("status %d location %q", resp.StatusCode, resp.Header.Get("Location"))
		}
		if cookieNamed(resp, httpapi.SessionCookie) != nil {
			t.Error("session cookie set on failure")
		}
		if l := cookieNamed(resp, httpapi.LoginCookie); l == nil || l.MaxAge >= 0 {
			t.Error("login cookie not cleared on failure")
		}
	})
}

func TestStateChangingRoutesRequireOriginAndHeader(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{name: "missing origin", mutate: func(r *http.Request) { r.Header.Del("Origin") }},
		{name: "wrong origin", mutate: func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }},
		{name: "origin with trailing slash", mutate: func(r *http.Request) { r.Header.Set("Origin", frontend+"/") }},
		{name: "missing csrf header", mutate: func(r *http.Request) { r.Header.Del("X-Galley-CSRF") }},
		{name: "wrong csrf header", mutate: func(r *http.Request) { r.Header.Set("X-Galley-CSRF", "0") }},
	}
	for _, path := range []string{"/api/galley/auth/token", "/api/galley/auth/logout"} {
		for _, tt := range tests {
			t.Run(path+" "+tt.name, func(t *testing.T) {
				f := &fakeAuth{}
				req := browserPost(path, "")
				tt.mutate(req)
				resp := do(t, newTestHandler(t, testDeps(f)), req)
				if resp.StatusCode != http.StatusForbidden {
					t.Fatalf("status = %d, want 403", resp.StatusCode)
				}
				if f.issueCalls != 0 || len(f.loggedOut) != 0 {
					t.Error("service called despite failed check")
				}
			})
		}
	}
}

func TestToken(t *testing.T) {
	t.Run("returns the access token with no-store", func(t *testing.T) {
		f := &fakeAuth{}
		resp := do(t, newTestHandler(t, testDeps(f)), browserPost("/api/galley/auth/token", `{"repository_id": 99}`))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
		}
		var body map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&body)
		if body["access_token"] != "ghu_x" || body["expires_at"] != "2026-11-27T12:00:00Z" {
			t.Errorf("body = %v", body)
		}
		// Older clients still send a repository id; tokens are no longer scoped.
		if f.gotSession != "session-token" || f.gotRejected != "" {
			t.Errorf("service got session %q rejected %q", f.gotSession, f.gotRejected)
		}
	})
	t.Run("empty body reports no rejected token", func(t *testing.T) {
		f := &fakeAuth{}
		resp := do(t, newTestHandler(t, testDeps(f)), browserPost("/api/galley/auth/token", ""))
		if resp.StatusCode != http.StatusOK || f.gotRejected != "" {
			t.Fatalf("status %d rejected %q", resp.StatusCode, f.gotRejected)
		}
	})
	t.Run("passes the token GitHub rejected", func(t *testing.T) {
		f := &fakeAuth{}
		resp := do(t, newTestHandler(t, testDeps(f)), browserPost("/api/galley/auth/token", `{"rejected":"ghu_old"}`))
		if resp.StatusCode != http.StatusOK || f.gotRejected != "ghu_old" {
			t.Fatalf("status %d rejected %q", resp.StatusCode, f.gotRejected)
		}
	})
	t.Run("malformed body is rejected", func(t *testing.T) {
		for _, body := range []string{`{"repository_id":"x"}`, `{"repository_id":-1}`, `{"rejected":5}`, `[`} {
			resp := do(t, newTestHandler(t, testDeps(&fakeAuth{})), browserPost("/api/galley/auth/token", body))
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("%s: status = %d, want 400", body, resp.StatusCode)
			}
		}
	})
	t.Run("missing session cookie is 401", func(t *testing.T) {
		req := browserPost("/api/galley/auth/token", "")
		req.Header.Del("Cookie")
		resp := do(t, newTestHandler(t, testDeps(&fakeAuth{})), req)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d", resp.StatusCode)
		}
	})
	t.Run("transient failure is 503 so the client can retry", func(t *testing.T) {
		f := &fakeAuth{issueErr: errors.New("auth: load session: database is locked")}
		resp := do(t, newTestHandler(t, testDeps(f)), browserPost("/api/galley/auth/token", ""))
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusServiceUnavailable || strings.Contains(string(body), "database") {
			t.Fatalf("status %d body %s", resp.StatusCode, body)
		}
	})
	t.Run("unauthenticated is a generic 401", func(t *testing.T) {
		f := &fakeAuth{issueErr: auth.ErrUnauthenticated}
		resp := do(t, newTestHandler(t, testDeps(f)), browserPost("/api/galley/auth/token", ""))
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusUnauthorized || strings.Contains(string(body), "auth:") {
			t.Fatalf("status %d body %s", resp.StatusCode, body)
		}
	})
}

func TestLogoutClearsSession(t *testing.T) {
	f := &fakeAuth{}
	resp := do(t, newTestHandler(t, testDeps(f)), browserPost("/api/galley/auth/logout", ""))
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if len(f.loggedOut) != 1 || f.loggedOut[0] != "session-token" {
		t.Errorf("logged out = %v", f.loggedOut)
	}
	c := cookieNamed(resp, httpapi.SessionCookie)
	if c == nil || c.MaxAge >= 0 || !c.Secure || c.Path != "/" {
		t.Errorf("session cookie not expired: %+v", c)
	}
}

func sign(body string) string {
	m := hmac.New(sha256.New, []byte(webhookSecret))
	m.Write([]byte(body))
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

func TestWebhook(t *testing.T) {
	revoked := `{"action":"revoked","sender":{"id":42,"login":"octo"}}`
	tests := []struct {
		name        string
		event       string
		body        string
		signature   string
		wantStatus  int
		wantRevoked []int64
	}{
		{name: "valid revocation", event: "github_app_authorization", body: revoked, signature: sign(revoked), wantStatus: 204, wantRevoked: []int64{42}},
		{name: "bad signature", event: "github_app_authorization", body: revoked, signature: sign("other"), wantStatus: 401},
		{name: "missing signature", event: "github_app_authorization", body: revoked, signature: "", wantStatus: 401},
		{name: "signature without prefix", event: "github_app_authorization", body: revoked, signature: strings.TrimPrefix(sign(revoked), "sha256="), wantStatus: 401},
		{name: "other event is ignored", event: "installation", body: revoked, signature: sign(revoked), wantStatus: 204},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeAuth{}
			req := httptest.NewRequest(http.MethodPost, "/api/galley/auth/webhook", strings.NewReader(tt.body))
			req.Header.Set("X-GitHub-Event", tt.event)
			if tt.signature != "" {
				req.Header.Set("X-Hub-Signature-256", tt.signature)
			}
			resp := do(t, newTestHandler(t, testDeps(f)), req)
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			if len(f.revoked) != len(tt.wantRevoked) || (len(f.revoked) == 1 && f.revoked[0] != tt.wantRevoked[0]) {
				t.Errorf("revoked = %v, want %v", f.revoked, tt.wantRevoked)
			}
		})
	}
}

func TestAuthCORS(t *testing.T) {
	t.Run("preflight from the frontend allows credentials", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/api/galley/auth/token", nil)
		req.Header.Set("Origin", frontend)
		req.Header.Set("Access-Control-Request-Method", "POST")
		req.Header.Set("Access-Control-Request-Headers", "content-type,x-galley-csrf")
		resp := do(t, newTestHandler(t, testDeps(&fakeAuth{})), req)
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("status = %d", resp.StatusCode)
		}
		h := resp.Header
		if h.Get("Access-Control-Allow-Origin") != frontend || h.Get("Access-Control-Allow-Credentials") != "true" {
			t.Errorf("allow origin %q credentials %q", h.Get("Access-Control-Allow-Origin"), h.Get("Access-Control-Allow-Credentials"))
		}
		if h.Get("Access-Control-Allow-Headers") != "Content-Type,X-Galley-CSRF" {
			t.Errorf("allow headers = %q", h.Get("Access-Control-Allow-Headers"))
		}
		if !strings.Contains(strings.Join(h.Values("Vary"), ","), "Origin") {
			t.Errorf("Vary = %v", h.Values("Vary"))
		}
	})
	t.Run("other origins get no CORS headers", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/api/galley/auth/token", nil)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		resp := do(t, newTestHandler(t, testDeps(&fakeAuth{})), req)
		if resp.Header.Get("Access-Control-Allow-Origin") != "" || resp.Header.Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("CORS headers sent to a foreign origin: %v", resp.Header)
		}
	})
}

// TestAuthCORSReplacesGlobalMiddleware mirrors apis.Serve, which binds a
// global CORS middleware without credentials (from --origins, default "*").
func TestAuthCORSReplacesGlobalMiddleware(t *testing.T) {
	r := router.NewRouter(func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		return &core.RequestEvent{Event: router.Event{Response: w, Request: req}}, nil
	})
	r.Bind(apis.CORS(apis.CORSConfig{AllowOrigins: []string{"*"}}))
	httpapi.Register(r, testDeps(&fakeAuth{}))
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	pre := httptest.NewRequest(http.MethodOptions, "/api/galley/auth/token", nil)
	pre.Header.Set("Origin", frontend)
	pre.Header.Set("Access-Control-Request-Method", "POST")
	resp := do(t, mux, pre)
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != frontend {
		t.Errorf("preflight Access-Control-Allow-Origin = %q, want %q", got, frontend)
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Error("preflight lacks Access-Control-Allow-Credentials")
	}

	resp = do(t, mux, browserPost("/api/galley/auth/token", ""))
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Access-Control-Allow-Origin") != frontend ||
		resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Errorf("status %d, CORS headers %v", resp.StatusCode, resp.Header)
	}

	health := httptest.NewRequest(http.MethodGet, "/api/galley/health", nil)
	health.Header.Set("Origin", "https://other.example")
	if got := do(t, mux, health).Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("routes outside the auth group lost the global CORS middleware: %q", got)
	}
}

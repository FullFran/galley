package auth_test

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/secret"
)

type harness struct {
	svc      *auth.Service
	provider *fakeProvider
	store    *memStore
	sealer   *secret.Sealer
	now      time.Time

	mu           sync.Mutex
	revokedUsers []string // OnRevoke calls
	reasons      []auth.RevokeReason
}

func (h *harness) revocations() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.revokedUsers...)
}

func TestAuthenticate(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	u, err := h.svc.Authenticate(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if u.Login != "octo" || u.GitHubID != 42 || u.ID == "" {
		t.Errorf("user = %+v", u)
	}
	if h.provider.rotations != 1 {
		t.Error("Authenticate must not refresh the GitHub token")
	}
	for _, bad := range []string{"", "nope"} {
		if _, err := h.svc.Authenticate(context.Background(), bad); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Errorf("Authenticate(%q) err = %v", bad, err)
		}
	}
	h.now = h.now.Add(31 * 24 * time.Hour)
	if _, err := h.svc.Authenticate(context.Background(), token); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Errorf("expired session err = %v", err)
	}
}

func TestUserAccessToken(t *testing.T) {
	h := newHarness(t)
	h.login(t)
	user := h.store.users[42]
	got, err := h.svc.UserAccessToken(context.Background(), user.ID, "")
	if err != nil || got.Token != "ghu_2" {
		t.Fatalf("token = %+v, %v", got, err)
	}
	plain, _ := h.sealer.Open(h.store.tokens[user.ID].Ciphertext, []byte(user.ID))
	if string(plain) != "ghr_2" {
		t.Errorf("rotated refresh token not persisted: %q", plain)
	}

	h.provider.validRefresh = "revoked-elsewhere"
	if again, err := h.svc.UserAccessToken(context.Background(), user.ID, ""); err != nil || again.Token != "ghu_2" {
		t.Fatalf("current token not reused: %+v, %v", again, err)
	}
	if _, err := h.svc.UserAccessToken(context.Background(), user.ID, "ghu_2"); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("rejected refresh err = %v", err)
	}
	if got := h.revocations(); len(got) != 1 || got[0] != user.ID {
		t.Errorf("OnRevoke calls = %v, want [%s]", got, user.ID)
	}
	if _, err := h.svc.UserAccessToken(context.Background(), "unknown", ""); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Errorf("unknown user err = %v", err)
	}
}

func TestTokenIssuedIsReported(t *testing.T) {
	h := newHarness(t)
	var got []string
	h.svc, _ = auth.NewService(auth.Config{
		Provider: h.provider, Users: h.store, Sessions: h.store, Sealer: h.sealer,
		SessionTTL: time.Hour, LoginTTL: time.Minute, Now: func() time.Time { return h.now },
		OnTokenIssued: func(userID string, tok auth.AccessToken) {
			got = append(got, userID+"|"+tok.Token)
		},
	})
	token := h.login(t)
	uid := h.store.users[42].ID
	if _, err := h.svc.IssueToken(context.Background(), token, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.UserAccessToken(context.Background(), uid, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.UserAccessToken(context.Background(), uid, "ghu_2"); err != nil {
		t.Fatal(err)
	}
	want := []string{uid + "|ghu_2", uid + "|ghu_3"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("OnTokenIssued calls = %v, want %v", got, want)
	}
}

func TestRevokeNotifies(t *testing.T) {
	h := newHarness(t)
	h.login(t)
	if err := h.svc.Revoke(context.Background(), 42); err != nil {
		t.Fatal(err)
	}
	if got := h.revocations(); len(got) != 1 || got[0] != h.store.users[42].ID {
		t.Errorf("OnRevoke calls = %v", got)
	}
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC), store: newMemStore()}
	clock := func() time.Time { return h.now }
	h.provider = &fakeProvider{user: auth.GitHubUser{ID: 42, Login: "octo"}, now: clock}
	sealer, err := secret.NewSealer(bytes.Repeat([]byte{1}, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	h.sealer = sealer
	h.svc, err = auth.NewService(auth.Config{
		Provider:   h.provider,
		Users:      h.store,
		Sessions:   h.store,
		Sealer:     sealer,
		SessionTTL: 30 * 24 * time.Hour,
		LoginTTL:   10 * time.Minute,
		Now:        clock,
		OnRevoke: func(userID string, reason auth.RevokeReason) {
			h.mu.Lock()
			h.revokedUsers = append(h.revokedUsers, userID)
			h.reasons = append(h.reasons, reason)
			h.mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// login runs StartLogin and Callback and returns the session token.
func (h *harness) login(t *testing.T) string {
	t.Helper()
	start, err := h.svc.StartLogin()
	if err != nil {
		t.Fatal(err)
	}
	sess, err := h.svc.Callback(context.Background(), start.Cookie, stateOf(t, start.URL), "code-1")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	return sess.Token
}

func stateOf(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get("state")
}

func TestPKCEChallenge(t *testing.T) {
	// Example from RFC 7636, appendix B.
	got := auth.PKCEChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
	if want := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; got != want {
		t.Errorf("challenge = %q, want %q", got, want)
	}
}

func TestStartLoginUsesFreshStateAndPKCE(t *testing.T) {
	h := newHarness(t)
	a, _ := h.svc.StartLogin()
	b, _ := h.svc.StartLogin()
	if stateOf(t, a.URL) == "" || stateOf(t, a.URL) == stateOf(t, b.URL) {
		t.Fatalf("states are empty or repeat: %q %q", stateOf(t, a.URL), stateOf(t, b.URL))
	}
	u, _ := url.Parse(a.URL)
	if u.Query().Get("code_challenge") == "" {
		t.Error("authorize URL has no code_challenge")
	}
	if a.Cookie == "" || bytes.Contains([]byte(a.Cookie), []byte(stateOf(t, a.URL))) {
		t.Error("login cookie is empty or carries the state in clear text")
	}
}

func TestCallbackCreatesSession(t *testing.T) {
	h := newHarness(t)
	start, _ := h.svc.StartLogin()
	sess, err := h.svc.Callback(context.Background(), start.Cookie, stateOf(t, start.URL), "code-1")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if want := h.now.Add(30 * 24 * time.Hour); !sess.ExpiresAt.Equal(want) {
		t.Errorf("session expires %v, want %v", sess.ExpiresAt, want)
	}

	// The verifier sent to GitHub must match the challenge in the authorize URL.
	u, _ := url.Parse(start.URL)
	if len(h.provider.exchanged) != 1 {
		t.Fatalf("exchanges = %d, want 1", len(h.provider.exchanged))
	}
	code, verifier, _ := cut(h.provider.exchanged[0])
	if code != "code-1" || auth.PKCEChallenge(verifier) != u.Query().Get("code_challenge") {
		t.Errorf("exchange got code %q and a verifier that does not match the challenge", code)
	}

	stored, ok := h.store.sessions[secret.HashToken(sess.Token)]
	if !ok {
		t.Fatal("session not stored under the token hash")
	}
	if _, raw := h.store.sessions[sess.Token]; raw {
		t.Error("session stored under the raw token")
	}
	user := h.store.users[42]
	if stored.UserID != user.ID || user.Login != "octo" {
		t.Errorf("session user %q, stored user %+v", stored.UserID, user)
	}
	tok := h.store.tokens[user.ID]
	if bytes.Contains([]byte(tok.Ciphertext), []byte("ghr_")) {
		t.Error("refresh token stored in clear text")
	}
	plain, err := h.sealer.Open(tok.Ciphertext, []byte(user.ID))
	if err != nil || string(plain) != "ghr_1" {
		t.Errorf("stored refresh token opens to %q (err %v), want ghr_1", plain, err)
	}
}

func cut(s string) (string, string, bool) {
	for i := range s {
		if s[i] == '|' {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

func TestCallbackRejectsBadLogin(t *testing.T) {
	h := newHarness(t)
	start, _ := h.svc.StartLogin()
	state := stateOf(t, start.URL)
	other, _ := h.svc.StartLogin()

	tests := []struct {
		name    string
		cookie  string
		state   string
		advance time.Duration
	}{
		{name: "state mismatch", cookie: start.Cookie, state: stateOf(t, other.URL)},
		{name: "empty state", cookie: start.Cookie, state: ""},
		{name: "missing cookie", cookie: "", state: state},
		{name: "tampered cookie", cookie: start.Cookie[:len(start.Cookie)-2] + "AA", state: state},
		{name: "expired login", cookie: start.Cookie, state: state, advance: 11 * time.Minute},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h.now = h.now.Add(tt.advance)
			defer func() { h.now = h.now.Add(-tt.advance) }()
			_, err := h.svc.Callback(context.Background(), tt.cookie, tt.state, "code-1")
			if !errors.Is(err, auth.ErrInvalidLogin) {
				t.Fatalf("err = %v, want ErrInvalidLogin", err)
			}
		})
	}
	if len(h.provider.exchanged) != 0 || len(h.store.sessions) != 0 {
		t.Error("a rejected callback reached GitHub or created a session")
	}
}

func TestIssueTokenReusesCurrentTokenUntilNearExpiry(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)

	got, err := h.svc.IssueToken(context.Background(), token, "")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if got.Token != "ghu_2" || !got.ExpiresAt.Equal(h.now.Add(8*time.Hour)) {
		t.Errorf("issued %+v", got)
	}
	if h.provider.lastRepoID != 0 {
		t.Errorf("repository id = %d, want 0 (tokens are not scoped)", h.provider.lastRepoID)
	}
	user := h.store.users[42]
	plain, _ := h.sealer.Open(h.store.tokens[user.ID].Ciphertext, []byte(user.ID))
	if string(plain) != "ghr_2" {
		t.Errorf("persisted refresh token = %q, want rotated ghr_2", plain)
	}

	// Another tab, device or server-side call gets the same token: no rotation.
	rotations := h.provider.rotations
	again, err := h.svc.IssueToken(context.Background(), token, "")
	if err != nil || again.Token != "ghu_2" || h.provider.rotations != rotations {
		t.Fatalf("second issue = %+v, %v (rotations %d, want %d)", again, err, h.provider.rotations, rotations)
	}
	// Close to expiry the pair is refreshed once.
	h.now = got.ExpiresAt.Add(-4 * time.Minute)
	late, err := h.svc.IssueToken(context.Background(), token, "")
	if err != nil || late.Token != "ghu_3" {
		t.Fatalf("issue near expiry = %+v, %v", late, err)
	}
}

func TestIssueTokenRefreshesOnlyTheRejectedToken(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	if got, _ := h.svc.IssueToken(context.Background(), token, ""); got.Token != "ghu_2" {
		t.Fatalf("first token = %q", got.Token)
	}
	steps := []struct{ rejected, want string }{
		{"ghu_old", "ghu_2"}, // a token that is no longer current changes nothing
		{"ghu_2", "ghu_3"},   // GitHub rejected the current token: refresh once
		{"ghu_2", "ghu_3"},   // a late report about the same token does not rotate again
	}
	for _, step := range steps {
		got, err := h.svc.IssueToken(context.Background(), token, step.rejected)
		if err != nil || got.Token != step.want {
			t.Fatalf("rejected %q: got %+v, %v; want %s", step.rejected, got, err, step.want)
		}
	}
	if h.provider.rotations != 3 {
		t.Errorf("rotations = %d, want 3 (login, first issue, one rejection)", h.provider.rotations)
	}
}

func TestSignInStartsFromTheNewAuthorization(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	if got, _ := h.svc.IssueToken(context.Background(), token, ""); got.Token != "ghu_2" {
		t.Fatalf("first token = %q", got.Token)
	}
	// Signing in again (the way out after any auth trouble) must not keep
	// serving the previous authorization's token.
	again := h.login(t)
	got, err := h.svc.IssueToken(context.Background(), again, "")
	if err != nil || got.Token == "ghu_2" {
		t.Fatalf("token after a new sign-in = %+v, %v; want a fresh one", got, err)
	}
}

func TestRevocationDropsCurrentToken(t *testing.T) {
	t.Run("webhook", func(t *testing.T) {
		h := newHarness(t)
		h.login(t)
		uid := h.store.users[42].ID
		if _, err := h.svc.UserAccessToken(context.Background(), uid, ""); err != nil {
			t.Fatal(err)
		}
		if err := h.svc.Revoke(context.Background(), 42); err != nil {
			t.Fatal(err)
		}
		if _, err := h.svc.UserAccessToken(context.Background(), uid, ""); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("token after revoke: %v", err)
		}
	})
	t.Run("GitHub rejects the refresh token", func(t *testing.T) {
		h := newHarness(t)
		token := h.login(t)
		if _, err := h.svc.IssueToken(context.Background(), token, ""); err != nil {
			t.Fatal(err)
		}
		h.provider.validRefresh = "revoked-elsewhere"
		if _, err := h.svc.IssueToken(context.Background(), token, "ghu_2"); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("rejected refresh err = %v", err)
		}
		if _, err := h.svc.IssueToken(context.Background(), token, ""); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("stale token served after rejection: %v", err)
		}
	})
}

func TestIssueTokenSerializesConcurrentRequests(t *testing.T) {
	h := newHarness(t)
	h.provider.refreshDelay = 5 * time.Millisecond
	token := h.login(t)

	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := h.svc.IssueToken(context.Background(), token, "")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent issue failed: %v", err)
		}
	}
	if h.provider.rotations != 2 {
		t.Errorf("rotations = %d, want 2 (login and one shared refresh)", h.provider.rotations)
	}
}

func TestIssueTokenRejected(t *testing.T) {
	t.Run("unknown session", func(t *testing.T) {
		h := newHarness(t)
		if _, err := h.svc.IssueToken(context.Background(), "nope", ""); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("expired session is deleted", func(t *testing.T) {
		h := newHarness(t)
		token := h.login(t)
		h.now = h.now.Add(31 * 24 * time.Hour)
		if _, err := h.svc.IssueToken(context.Background(), token, ""); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("err = %v", err)
		}
		if len(h.store.sessions) != 0 {
			t.Error("expired session kept")
		}
	})
	t.Run("bad refresh token deletes the stored token", func(t *testing.T) {
		h := newHarness(t)
		token := h.login(t)
		h.provider.validRefresh = "revoked-elsewhere"
		if _, err := h.svc.IssueToken(context.Background(), token, ""); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("err = %v", err)
		}
		if len(h.store.tokens) != 0 {
			t.Error("rejected refresh token kept")
		}
	})
	t.Run("expired refresh token", func(t *testing.T) {
		h := newHarness(t)
		token := h.login(t)
		user := h.store.users[42]
		tok := h.store.tokens[user.ID]
		tok.ExpiresAt = h.now.Add(-time.Second)
		h.store.tokens[user.ID] = tok
		if _, err := h.svc.IssueToken(context.Background(), token, ""); !errors.Is(err, auth.ErrUnauthenticated) {
			t.Fatalf("err = %v", err)
		}
		if h.provider.rotations != 1 {
			t.Error("expired refresh token was sent to GitHub")
		}
	})
}

func TestRevokeReasons(t *testing.T) {
	tests := []struct {
		name    string
		trigger func(t *testing.T, h *harness, session string)
		want    auth.RevokeReason
		revoked bool
	}{
		{"webhook", func(t *testing.T, h *harness, _ string) {
			if err := h.svc.Revoke(context.Background(), 42); err != nil {
				t.Fatal(err)
			}
		}, auth.RevokeWebhook, true},
		{"GitHub rejects the refresh token", func(t *testing.T, h *harness, session string) {
			h.provider.validRefresh = "revoked-elsewhere"
			_, _ = h.svc.IssueToken(context.Background(), session, "")
		}, auth.RevokeRejected, false},
		{"expired refresh token", func(t *testing.T, h *harness, session string) {
			uid := h.store.users[42].ID
			tok := h.store.tokens[uid]
			tok.ExpiresAt = h.now.Add(-time.Second)
			h.store.tokens[uid] = tok
			_, _ = h.svc.IssueToken(context.Background(), session, "")
		}, auth.RevokeExpired, false},
		{"unreadable refresh token (key change)", func(t *testing.T, h *harness, session string) {
			uid := h.store.users[42].ID
			tok := h.store.tokens[uid]
			tok.Ciphertext = "garbage"
			h.store.tokens[uid] = tok
			_, _ = h.svc.IssueToken(context.Background(), session, "")
		}, auth.RevokeUnreadable, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			session := h.login(t)
			tt.trigger(t, h, session)
			h.mu.Lock()
			defer h.mu.Unlock()
			if len(h.reasons) != 1 || h.reasons[0] != tt.want {
				t.Fatalf("reasons = %v, want [%s]", h.reasons, tt.want)
			}
			if h.reasons[0].Revoked() != tt.revoked {
				t.Errorf("%s.Revoked() = %v", tt.want, !tt.revoked)
			}
		})
	}
}

func TestLogoutDeletesSession(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	if err := h.svc.Logout(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.IssueToken(context.Background(), token, ""); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("token issued after logout: %v", err)
	}
}

func TestRevokeDeletesEverything(t *testing.T) {
	h := newHarness(t)
	first := h.login(t)
	h.login(t)
	if err := h.svc.Revoke(context.Background(), 42); err != nil {
		t.Fatal(err)
	}
	if len(h.store.sessions) != 0 || len(h.store.tokens) != 0 {
		t.Errorf("after revoke: %d sessions, %d tokens", len(h.store.sessions), len(h.store.tokens))
	}
	if _, err := h.svc.IssueToken(context.Background(), first, ""); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("err = %v", err)
	}
	if err := h.svc.Revoke(context.Background(), 999); err != nil {
		t.Errorf("revoking an unknown user = %v, want nil", err)
	}
}

func TestIssueTokenKeepsRotationWhenRequestIsCancelled(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The browser aborts the request after GitHub rotated the pair.
	h.provider.afterRotate = func(context.Context) { cancel() }

	_, _ = h.svc.IssueToken(ctx, token, "")

	user := h.store.users[42]
	plain, err := h.sealer.Open(h.store.tokens[user.ID].Ciphertext, []byte(user.ID))
	if err != nil || string(plain) != "ghr_2" {
		t.Fatalf("persisted refresh token = %q (err %v), want rotated ghr_2", plain, err)
	}
	h.provider.afterRotate = nil
	if _, err := h.svc.IssueToken(context.Background(), token, ""); err != nil {
		t.Fatalf("next issue after cancelled request: %v", err)
	}
}

func TestIssueTokenRetriesSaveOnce(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	h.store.failSaves = 1
	if _, err := h.svc.IssueToken(context.Background(), token, ""); err != nil {
		t.Fatalf("issue with one failed save: %v", err)
	}
	user := h.store.users[42]
	plain, _ := h.sealer.Open(h.store.tokens[user.ID].Ciphertext, []byte(user.ID))
	if string(plain) != "ghr_2" {
		t.Errorf("persisted refresh token = %q, want ghr_2", plain)
	}
}

func TestIssueTokenTransientErrorsAreNotUnauthenticated(t *testing.T) {
	h := newHarness(t)
	token := h.login(t)
	h.store.failSaves = 2
	_, err := h.svc.IssueToken(context.Background(), token, "")
	if err == nil || errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("err = %v, want a transient (non-unauthenticated) error", err)
	}
}

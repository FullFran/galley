package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/httpapi"
	"github.com/FullFran/galley/server/internal/notify"
)

type fakeNotify struct {
	mu       sync.Mutex
	calls    []string
	update   notify.Update
	repoID   int64
	number   int
	pr       bool
	login    string
	token    string
	err      error
	disabled bool
}

func (f *fakeNotify) rec(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
}

func (f *fakeNotify) Settings(_ context.Context, a comments.Actor) (notify.Settings, error) {
	f.rec("settings")
	return notify.Settings{Available: !f.disabled, Email: "bob@example.com", Kinds: []notify.Kind{notify.KindAssigned}}, f.err
}

func (f *fakeNotify) UpdateSettings(_ context.Context, a comments.Actor, in notify.Update) (notify.Settings, error) {
	f.rec("update")
	f.update = in
	if f.disabled {
		return notify.Settings{}, notify.ErrDisabled
	}
	return notify.Settings{Available: true, Email: in.Email, Enabled: in.Enabled, Kinds: in.Kinds}, f.err
}

func (f *fakeNotify) Verify(_ context.Context, token string) error {
	f.rec("verify")
	f.token = token
	return f.err
}

func (f *fakeNotify) Unsubscribe(_ context.Context, token string) error {
	f.rec("unsubscribe")
	f.token = token
	return f.err
}

func (f *fakeNotify) ReviewRequested(_ context.Context, a comments.Actor, repoID int64, n int, login string) (notify.Result, error) {
	f.rec("review")
	f.repoID, f.number, f.login = repoID, n, login
	return notify.Result{Status: notify.StatusAccepted}, f.err
}

func (f *fakeNotify) Assigned(_ context.Context, a comments.Actor, repoID int64, n int, pr bool, login string) (notify.Result, error) {
	f.rec("assigned")
	f.repoID, f.number, f.pr, f.login = repoID, n, pr, login
	return notify.Result{Status: notify.StatusAccepted}, f.err
}

func notifyHandler(t *testing.T, fn *fakeNotify) http.Handler {
	d := testDeps(&fakeAuth{})
	d.Notify = fn
	return newTestHandler(t, d)
}

func TestNotifyRoutes(t *testing.T) {
	tests := []struct {
		method, path, body string
		want               int
		call               string
	}{
		{http.MethodGet, "/api/galley/me/notifications", "", 200, "settings"},
		{http.MethodPut, "/api/galley/me/notifications", `{"email":"bob@example.com","enabled":true,"kinds":["assigned"]}`, 200, "update"},
		{http.MethodPost, "/api/galley/repos/7/notify/review-requested", `{"pr_number":12,"reviewer_login":"bob"}`, 202, "review"},
		{http.MethodPost, "/api/galley/repos/7/notify/assigned", `{"issue_number":12,"assignee_login":"bob"}`, 202, "assigned"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			fn := &fakeNotify{}
			resp := do(t, notifyHandler(t, fn), browserReq(tt.method, tt.path, tt.body))
			if resp.StatusCode != tt.want {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d (%s)", resp.StatusCode, body)
			}
			if len(fn.calls) != 1 || fn.calls[0] != tt.call {
				t.Errorf("calls = %v", fn.calls)
			}
			if resp.Header.Get("Cache-Control") != "no-store" {
				t.Error("missing no-store")
			}
		})
	}
}

func TestNotifyRequestsAreDecodedAndChecked(t *testing.T) {
	fn := &fakeNotify{}
	h := notifyHandler(t, fn)
	do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/notify/assigned", `{"pr_number":12,"assignee_login":"bob"}`))
	if fn.repoID != 7 || fn.number != 12 || !fn.pr || fn.login != "bob" {
		t.Errorf("assigned = %+v", fn)
	}
	for _, body := range []string{
		`{"pr_number":12,"issue_number":12,"assignee_login":"bob"}`,
		`{"assignee_login":"bob"}`,
		`{"pr_number":12,"assignee_login":"bob","extra":1}`,
	} {
		if resp := do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/notify/assigned", body)); resp.StatusCode/100 != 4 {
			t.Errorf("%s = %d", body, resp.StatusCode)
		}
	}
	// No session, wrong origin and missing CSRF are refused before the service.
	req := browserReq(http.MethodPost, "/api/galley/repos/7/notify/review-requested", `{"pr_number":1,"reviewer_login":"bob"}`)
	req.Header.Del("X-Galley-CSRF")
	if resp := do(t, h, req); resp.StatusCode != http.StatusForbidden {
		t.Errorf("without CSRF = %d", resp.StatusCode)
	}

	fn.err = comments.ErrConflict
	if resp := do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/notify/review-requested", `{"pr_number":1,"reviewer_login":"bob"}`)); resp.StatusCode != http.StatusConflict {
		t.Errorf("not requested = %d", resp.StatusCode)
	}
}

func TestNotifyDisabled(t *testing.T) {
	fn := &fakeNotify{disabled: true}
	h := notifyHandler(t, fn)
	resp := do(t, h, browserReq(http.MethodPut, "/api/galley/me/notifications", `{"email":"bob@example.com","enabled":true}`))
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if resp.StatusCode != http.StatusConflict || body["reason"] != "disabled" {
		t.Errorf("disabled update = %d %v", resp.StatusCode, body)
	}
	resp = do(t, h, browserReq(http.MethodGet, "/api/galley/me/notifications", ""))
	body = nil
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body["available"] != false {
		t.Errorf("settings = %v", body)
	}
}

func TestVerifyAndUnsubscribeLinks(t *testing.T) {
	fn := &fakeNotify{}
	h := notifyHandler(t, fn)

	// Links are opened from a mail client: no Origin, no session. GET only
	// shows a button: mail scanners fetching the link must not verify an
	// address someone else entered.
	resp := do(t, h, httptest.NewRequest(http.MethodGet, "/api/galley/me/notifications/verify?token=tok1", nil))
	page, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || len(fn.calls) != 0 || !strings.Contains(string(page), `method="post"`) || !strings.Contains(string(page), "tok1") {
		t.Errorf("verify GET = %d %v %q", resp.StatusCode, fn.calls, page)
	}
	if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'none'") {
		t.Errorf("CSP = %q", csp)
	}
	resp = do(t, h, httptest.NewRequest(http.MethodPost, "/api/galley/me/notifications/verify?token=tok1", nil))
	page, _ = io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || fn.token != "tok1" || len(fn.calls) != 1 || !strings.Contains(string(page), "confirmed") {
		t.Errorf("verify POST = %d %v %q", resp.StatusCode, fn.calls, page)
	}

	// GET only shows a confirmation form: prefetchers must not unsubscribe.
	fn.calls = nil
	resp = do(t, h, httptest.NewRequest(http.MethodGet, "/api/galley/unsubscribe?token=tok2", nil))
	page, _ = io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || len(fn.calls) != 0 || !strings.Contains(string(page), `method="post"`) || !strings.Contains(string(page), "tok2") {
		t.Errorf("unsubscribe GET = %d %v %q", resp.StatusCode, fn.calls, page)
	}
	// One-click POST (RFC 8058): token in the URL, form body.
	req := httptest.NewRequest(http.MethodPost, "/api/galley/unsubscribe?token=tok3", strings.NewReader("List-Unsubscribe=One-Click"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp = do(t, h, req)
	if resp.StatusCode != 200 || fn.token != "tok3" || len(fn.calls) != 1 {
		t.Errorf("unsubscribe POST = %d %q %v", resp.StatusCode, fn.token, fn.calls)
	}
	// Invalid links answer a generic page.
	fn.err = comments.ErrNotFound
	resp = do(t, h, httptest.NewRequest(http.MethodPost, "/api/galley/me/notifications/verify?token=bad", nil))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bad verify = %d", resp.StatusCode)
	}
	// Tokens are escaped in the page.
	resp = do(t, h, httptest.NewRequest(http.MethodGet, `/api/galley/unsubscribe?token=%22%3E%3Cscript%3E`, nil))
	page, _ = io.ReadAll(resp.Body)
	if strings.Contains(string(page), "<script>") {
		t.Errorf("unescaped token: %q", page)
	}
}

var _ httpapi.NotifyService = (*fakeNotify)(nil)

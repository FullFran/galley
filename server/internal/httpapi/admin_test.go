package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/httpapi"
)

var adminAt = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

type fakeAdmin struct {
	mu          sync.Mutex
	err         error
	calls       []string
	actor       comments.Actor
	repoID      int64
	arg         string
	confirmSelf bool
	githubID    int64
	login       string
}

func (f *fakeAdmin) record(name string, a comments.Actor, repoID int64, arg string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.actor, f.repoID, f.arg = a, repoID, arg
	return f.err
}

func (f *fakeAdmin) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

var sampleShare = admin.Share{ID: "share0000000001", DraftID: "draft0000000001", Owner: "u2", OwnerLogin: "alice",
	RepoID: 7, Path: "a.qmd", CreatedAt: adminAt, ExpiresAt: adminAt.Add(24 * time.Hour)}

func (f *fakeAdmin) People(_ context.Context, a comments.Actor, repoID int64) ([]admin.PersonView, error) {
	if err := f.record("people", a, repoID, ""); err != nil {
		return nil, err
	}
	return []admin.PersonView{{
		Person: admin.Person{Activity: admin.Activity{UserID: "u2", RepoID: 7, Level: admin.LevelWrite, FirstSeen: adminAt, LastSeen: adminAt.Add(time.Hour)},
			Login: "alice", GitHubID: 2},
		Drafts:  admin.DraftStats{Count: 2, Bytes: 30, Oldest: adminAt, Newest: adminAt.Add(time.Minute)},
		Blocked: true,
	}}, nil
}

func (f *fakeAdmin) RevokeSessions(_ context.Context, a comments.Actor, repoID int64, userID string, confirmSelf bool) error {
	f.mu.Lock()
	f.confirmSelf = confirmSelf
	f.mu.Unlock()
	return f.record("revoke", a, repoID, userID)
}

func (f *fakeAdmin) Allowlist(_ context.Context, a comments.Actor, repoID int64) ([]admin.AllowEntry, error) {
	if err := f.record("allowlist", a, repoID, ""); err != nil {
		return nil, err
	}
	return []admin.AllowEntry{{ID: "allow0000000001", RepoID: 7, GitHubID: 2, Login: "alice", CreatedAt: adminAt}}, nil
}

func (f *fakeAdmin) Allow(_ context.Context, a comments.Actor, repoID, githubID int64, login string) (admin.AllowEntry, error) {
	f.mu.Lock()
	f.githubID, f.login = githubID, login
	f.mu.Unlock()
	if err := f.record("allow", a, repoID, ""); err != nil {
		return admin.AllowEntry{}, err
	}
	return admin.AllowEntry{ID: "allow0000000002", RepoID: repoID, GitHubID: githubID, Login: login, CreatedAt: adminAt}, nil
}

func (f *fakeAdmin) Disallow(_ context.Context, a comments.Actor, repoID int64, id string) error {
	return f.record("disallow", a, repoID, id)
}

func (f *fakeAdmin) SharedDrafts(_ context.Context, a comments.Actor, repoID int64) ([]admin.SharedDraft, error) {
	if err := f.record("shared", a, repoID, ""); err != nil {
		return nil, err
	}
	return []admin.SharedDraft{{Share: sampleShare, Size: 12, UpdatedAt: adminAt}}, nil
}

func (f *fakeAdmin) SharedDraft(_ context.Context, a comments.Actor, repoID int64, id string) (admin.Share, drafts.Draft, error) {
	if err := f.record("shared-one", a, repoID, id); err != nil {
		return admin.Share{}, drafts.Draft{}, err
	}
	return sampleShare, drafts.Draft{Path: "a.qmd", BaseSHA: strings.Repeat("a", 40), Size: 12, UpdatedAt: adminAt, Version: "v1", Content: "draft text"}, nil
}

func (f *fakeAdmin) Audit(_ context.Context, a comments.Actor, repoID int64) ([]admin.AuditEntry, error) {
	if err := f.record("audit", a, repoID, ""); err != nil {
		return nil, err
	}
	return []admin.AuditEntry{{ID: "audit0000000001", RepoID: 7, ActorID: "u1", ActorLogin: "octo", Action: admin.ActionViewPeople, Target: "repo", At: adminAt}}, nil
}

func (f *fakeAdmin) ShareDraft(_ context.Context, a comments.Actor, repoID int64, path string) (admin.Share, error) {
	if err := f.record("share", a, repoID, path); err != nil {
		return admin.Share{}, err
	}
	return sampleShare, nil
}

func (f *fakeAdmin) UnshareDraft(_ context.Context, a comments.Actor, repoID int64, path string) error {
	return f.record("unshare", a, repoID, path)
}

func (f *fakeAdmin) MyShares(_ context.Context, a comments.Actor, repoID int64) ([]admin.Share, error) {
	if err := f.record("mine", a, repoID, ""); err != nil {
		return nil, err
	}
	return []admin.Share{sampleShare}, nil
}

func adminDeps(fa *fakeAuth, f *fakeAdmin) httpapi.Deps {
	d := testDeps(fa)
	d.Admin = f
	return d
}

func adminRouteChecks() []struct{ method, path, body, call, arg string } {
	return []struct{ method, path, body, call, arg string }{
		{http.MethodGet, "/api/galley/repos/7/admin/people", "", "people", ""},
		{http.MethodPost, "/api/galley/repos/7/admin/people/abcdefghijklmno/revoke-sessions", `{"confirm_self":true}`, "revoke", "abcdefghijklmno"},
		{http.MethodGet, "/api/galley/repos/7/admin/allowlist", "", "allowlist", ""},
		{http.MethodPost, "/api/galley/repos/7/admin/allowlist", `{"github_id":2,"login":"alice"}`, "allow", ""},
		{http.MethodDelete, "/api/galley/repos/7/admin/allowlist/allow0000000001", "", "disallow", "allow0000000001"},
		{http.MethodGet, "/api/galley/repos/7/admin/shared-drafts", "", "shared", ""},
		{http.MethodGet, "/api/galley/repos/7/admin/shared-drafts/share0000000001", "", "shared-one", "share0000000001"},
		{http.MethodGet, "/api/galley/repos/7/admin/audit", "", "audit", ""},
		{http.MethodGet, "/api/galley/repos/7/draft-shares", "", "mine", ""},
		{http.MethodPost, "/api/galley/repos/7/draft-shares/sections/a.qmd", "", "share", "sections/a.qmd"},
		{http.MethodDelete, "/api/galley/repos/7/draft-shares/sections/a.qmd", "", "unshare", "sections/a.qmd"},
	}
}

func TestAdminRoutes(t *testing.T) {
	for _, rt := range adminRouteChecks() {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			f := &fakeAdmin{}
			resp := do(t, newTestHandler(t, adminDeps(&fakeAuth{}, f)), browserReq(rt.method, rt.path, rt.body))
			if resp.StatusCode >= 300 {
				t.Fatalf("status = %d", resp.StatusCode)
			}
			if len(f.calls) != 1 || f.calls[0] != rt.call || f.repoID != 7 || f.arg != rt.arg || f.actor.UserID != "u1" {
				t.Errorf("calls = %v repo %d arg %q actor %+v", f.calls, f.repoID, f.arg, f.actor)
			}
			if resp.Header.Get("Cache-Control") != "no-store" {
				t.Errorf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
			}
		})
	}
}

func TestAdminInputs(t *testing.T) {
	f := &fakeAdmin{}
	h := newTestHandler(t, adminDeps(&fakeAuth{}, f))
	do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/admin/people/abcdefghijklmno/revoke-sessions", `{"confirm_self":true}`))
	do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/admin/allowlist", `{"github_id":2,"login":"alice"}`))
	if !f.confirmSelf || f.githubID != 2 || f.login != "alice" {
		t.Errorf("decoded %+v", f)
	}
	for _, rt := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/galley/repos/7/admin/allowlist", `{"github_id":2,"extra":1}`},
		{http.MethodPost, "/api/galley/repos/7/admin/people/abcdefghijklmno/revoke-sessions", `{"confirm_self":"yes"}`},
	} {
		if resp := do(t, h, browserReq(rt.method, rt.path, rt.body)); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s %s = %d", rt.method, rt.body, resp.StatusCode)
		}
	}
	if resp := do(t, h, browserReq(http.MethodGet, "/api/galley/repos/x/admin/people", "")); resp.StatusCode != http.StatusNotFound {
		t.Errorf("bad repo id = %d", resp.StatusCode)
	}
}

func decodeMap(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return m
}

func TestAdminJSON(t *testing.T) {
	h := newTestHandler(t, adminDeps(&fakeAuth{}, &fakeAdmin{}))
	resp := do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/admin/people", ""))
	raw, _ := io.ReadAll(resp.Body)
	want := `{"people":[{"user_id":"u2","login":"alice","github_id":2,"permission":"write","first_seen":"2026-10-28T12:00:00Z",` +
		`"last_seen":"2026-10-28T13:00:00Z","blocked":true,"drafts":{"count":2,"bytes":30,"oldest_updated_at":"2026-10-28T12:00:00Z",` +
		`"newest_updated_at":"2026-10-28T12:01:00Z"}}]}`
	if strings.TrimSpace(string(raw)) != want {
		t.Errorf("people = %s\nwant     %s", raw, want)
	}
	if strings.Contains(string(raw), "content") {
		t.Error("people listing mentions content")
	}

	list := decodeMap(t, do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/admin/shared-drafts", "")))
	sh := list["shared_drafts"].([]any)[0].(map[string]any)
	if sh["id"] != "share0000000001" || sh["path"] != "a.qmd" || sh["expires_at"] != "2026-10-29T12:00:00Z" ||
		sh["owner"].(map[string]any)["login"] != "alice" || sh["size"] != float64(12) || sh["content"] != nil {
		t.Errorf("shared draft listing = %v", sh)
	}
	one := decodeMap(t, do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/admin/shared-drafts/share0000000001", "")))
	if one["content"] != "draft text" || one["read_only"] != true || one["share"].(map[string]any)["id"] != "share0000000001" {
		t.Errorf("shared draft = %v", one)
	}
	audit := decodeMap(t, do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/admin/audit", "")))
	e := audit["entries"].([]any)[0].(map[string]any)
	if e["action"] != "view_people" || e["target"] != "repo" || e["actor"].(map[string]any)["login"] != "octo" || e["at"] != "2026-10-28T12:00:00Z" {
		t.Errorf("audit = %v", e)
	}
	resp = do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/draft-shares/a.qmd", ""))
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("share status = %d", resp.StatusCode)
	}
	resp = do(t, h, browserReq(http.MethodDelete, "/api/galley/repos/7/draft-shares/a.qmd", ""))
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("unshare status = %d", resp.StatusCode)
	}
}

func TestAdminErrorMapping(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
	}{
		{comments.ErrForbidden, 403},
		{comments.ErrNotFound, 404},
		{comments.ErrConflict, 409},
		{&comments.ValidationError{Field: "confirm_self"}, 422},
		{comments.ErrUnavailable, 503},
	} {
		h := newTestHandler(t, adminDeps(&fakeAuth{}, &fakeAdmin{err: c.err}))
		for _, rt := range adminRouteChecks() {
			if resp := do(t, h, browserReq(rt.method, rt.path, rt.body)); resp.StatusCode != c.status {
				t.Errorf("%v %s %s = %d, want %d", c.err, rt.method, rt.path, resp.StatusCode, c.status)
			}
		}
	}
}

func TestAdminRoutesRequireOriginCSRFAndSession(t *testing.T) {
	for _, rt := range adminRouteChecks() {
		cases := []struct {
			name   string
			edit   func(*http.Request)
			auth   error
			status int
		}{
			{"no Origin", func(r *http.Request) { r.Header.Del("Origin") }, nil, 403},
			{"foreign Origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, nil, 403},
			{"no session", func(r *http.Request) { r.Header.Del("Cookie") }, nil, 401},
			{"expired session", func(*http.Request) {}, errExpired, 401},
		}
		if rt.method != http.MethodGet {
			cases = append(cases, struct {
				name   string
				edit   func(*http.Request)
				auth   error
				status int
			}{"no CSRF header", func(r *http.Request) { r.Header.Del("X-Galley-CSRF") }, nil, 403})
		}
		for _, c := range cases {
			t.Run(rt.method+" "+rt.path+" "+c.name, func(t *testing.T) {
				f := &fakeAdmin{}
				req := browserReq(rt.method, rt.path, rt.body)
				c.edit(req)
				resp := do(t, newTestHandler(t, adminDeps(&fakeAuth{authErr: c.auth}, f)), req)
				if resp.StatusCode != c.status {
					t.Fatalf("status = %d, want %d", resp.StatusCode, c.status)
				}
				if f.callCount() != 0 {
					t.Errorf("service called: %v", f.calls)
				}
			})
		}
	}
}

func TestAdminRoutesCORSAndAbsence(t *testing.T) {
	h := newTestHandler(t, adminDeps(&fakeAuth{}, &fakeAdmin{}))
	req := browserReq(http.MethodOptions, "/api/galley/repos/7/admin/people", "")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	resp := do(t, h, req)
	if resp.Header.Get("Access-Control-Allow-Origin") != frontend || resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Errorf("preflight headers = %v", resp.Header)
	}
	none := newTestHandler(t, testDeps(&fakeAuth{}))
	if resp := do(t, none, browserReq(http.MethodGet, "/api/galley/repos/7/admin/people", "")); resp.StatusCode != http.StatusNotFound {
		t.Errorf("admin route without service = %d", resp.StatusCode)
	}
}

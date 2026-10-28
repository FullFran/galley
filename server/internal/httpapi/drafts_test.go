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
	"time"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/httpapi"
)

var draftAt = time.Date(2026, 10, 28, 12, 0, 0, 123_000_000, time.UTC)

type fakeDrafts struct {
	mu     sync.Mutex
	err    error
	calls  []string
	actor  comments.Actor
	repoID int64
	path   string
	in     drafts.PutInput
}

func (f *fakeDrafts) record(name string, a comments.Actor, repoID int64, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.actor, f.repoID, f.path = a, repoID, path
	return f.err
}

func sampleDraft() drafts.Draft {
	return drafts.Draft{Path: "sections/intro.qmd", BaseSHA: strings.Repeat("a", 40), BaseRef: "main", Device: "laptop",
		Size: 5, UpdatedAt: draftAt, Version: "n0nce123", Content: "hello"}
}

func (f *fakeDrafts) List(_ context.Context, a comments.Actor, repoID int64) ([]drafts.Draft, error) {
	if err := f.record("list", a, repoID, ""); err != nil {
		return nil, err
	}
	d := sampleDraft()
	d.Content = ""
	return []drafts.Draft{d}, nil
}

func (f *fakeDrafts) Get(_ context.Context, a comments.Actor, repoID int64, path string) (drafts.Draft, error) {
	if err := f.record("get", a, repoID, path); err != nil {
		return drafts.Draft{}, err
	}
	return sampleDraft(), nil
}

func (f *fakeDrafts) Put(_ context.Context, a comments.Actor, repoID int64, in drafts.PutInput) (drafts.Draft, error) {
	f.mu.Lock()
	f.in = in
	f.mu.Unlock()
	if err := f.record("put", a, repoID, in.Path); err != nil {
		return drafts.Draft{}, err
	}
	return sampleDraft(), nil
}

func (f *fakeDrafts) Delete(_ context.Context, a comments.Actor, repoID int64, path string) error {
	return f.record("delete", a, repoID, path)
}

func (f *fakeDrafts) DeleteAll(_ context.Context, a comments.Actor, repoID int64) (int, error) {
	if err := f.record("deleteAll", a, repoID, ""); err != nil {
		return 0, err
	}
	return 3, nil
}

func draftDeps(fa *fakeAuth, fd *fakeDrafts) httpapi.Deps {
	d := testDeps(fa)
	d.Drafts = fd
	return d
}

const putBody = `{"base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_ref":"main","device":"laptop","content":"hello"}`

func TestDraftRoutes(t *testing.T) {
	tests := []struct {
		method, path, body string
		wantStatus         int
		wantCall, wantPath string
	}{
		{http.MethodGet, "/api/galley/repos/7/drafts", "", 200, "list", ""},
		{http.MethodGet, "/api/galley/repos/7/drafts/sections/intro.qmd", "", 200, "get", "sections/intro.qmd"},
		{http.MethodPut, "/api/galley/repos/7/drafts/sections/intro.qmd", putBody, 201, "put", "sections/intro.qmd"},
		{http.MethodDelete, "/api/galley/repos/7/drafts/sections/intro.qmd", "", 204, "delete", "sections/intro.qmd"},
		{http.MethodDelete, "/api/galley/repos/7/drafts", "", 200, "deleteAll", ""},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			fd := &fakeDrafts{}
			resp := do(t, newTestHandler(t, draftDeps(&fakeAuth{}, fd)), browserReq(tt.method, tt.path, tt.body))
			if resp.StatusCode != tt.wantStatus {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, want %d (%s)", resp.StatusCode, tt.wantStatus, body)
			}
			if len(fd.calls) != 1 || fd.calls[0] != tt.wantCall || fd.path != tt.wantPath || fd.repoID != 7 {
				t.Fatalf("calls = %v path=%q repo=%d", fd.calls, fd.path, fd.repoID)
			}
			if fd.actor != (comments.Actor{UserID: "u1", Login: "octo"}) {
				t.Errorf("actor = %+v", fd.actor)
			}
			if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Access-Control-Allow-Origin") != frontend {
				t.Errorf("headers = %v", resp.Header)
			}
		})
	}
}

func TestDraftJSON(t *testing.T) {
	h := newTestHandler(t, draftDeps(&fakeAuth{}, &fakeDrafts{}))
	resp := do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/drafts/sections/intro.qmd", ""))
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	etag := sampleDraft().ETag()
	if got["content"] != "hello" || got["updated_at"] != "2026-10-28T12:00:00.123Z" || got["etag"] != etag ||
		got["size"] != 5.0 || got["base_ref"] != "main" || resp.Header.Get("ETag") != etag {
		t.Errorf("draft = %v etag header %q", got, resp.Header.Get("ETag"))
	}
	resp = do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/drafts", ""))
	var list struct {
		Drafts []map[string]any `json:"drafts"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&list)
	if len(list.Drafts) != 1 || list.Drafts[0]["path"] != "sections/intro.qmd" {
		t.Fatalf("list = %+v", list)
	}
	if _, ok := list.Drafts[0]["content"]; ok {
		t.Error("listing carries content")
	}
	resp = do(t, h, browserReq(http.MethodDelete, "/api/galley/repos/7/drafts", ""))
	var del map[string]int
	_ = json.NewDecoder(resp.Body).Decode(&del)
	if del["deleted"] != 3 {
		t.Errorf("delete all = %v", del)
	}
}

func TestDraftPreconditions(t *testing.T) {
	etag := sampleDraft().ETag()
	tests := []struct {
		name       string
		ifMatch    string
		expected   string
		wantStatus int
		wantAt     time.Time
		wantNonce  string
		wantField  string
	}{
		{name: "none creates", wantStatus: 201},
		{name: "If-Match", ifMatch: etag, wantStatus: 200, wantAt: draftAt, wantNonce: "n0nce123"},
		{name: "expected_updated_at", expected: "2026-10-28T12:00:00.123Z", wantStatus: 200, wantAt: draftAt},
		{name: "both agree", ifMatch: etag, expected: "2026-10-28T13:00:00.123+01:00", wantStatus: 200, wantAt: draftAt, wantNonce: "n0nce123"},
		{name: "etag without nonce", ifMatch: `"1793188800123"`, wantStatus: 422, wantField: "if_match"},
		{name: "both disagree", ifMatch: etag, expected: "2026-10-28T12:00:00.124Z", wantStatus: 422, wantField: "expected_updated_at"},
		{name: "weak etag", ifMatch: `W/` + etag, wantStatus: 422, wantField: "if_match"},
		{name: "wildcard", ifMatch: "*", wantStatus: 422, wantField: "if_match"},
		{name: "bad time", expected: "yesterday", wantStatus: 422, wantField: "expected_updated_at"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fd := &fakeDrafts{}
			body := putBody
			if tt.expected != "" {
				body = strings.TrimSuffix(putBody, "}") + `,"expected_updated_at":"` + tt.expected + `"}`
			}
			req := browserReq(http.MethodPut, "/api/galley/repos/7/drafts/a.qmd", body)
			if tt.ifMatch != "" {
				req.Header.Set("If-Match", tt.ifMatch)
			}
			resp := do(t, newTestHandler(t, draftDeps(&fakeAuth{}, fd)), req)
			raw, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", resp.StatusCode, tt.wantStatus, raw)
			}
			if tt.wantField != "" {
				if !strings.Contains(string(raw), `"field":"`+tt.wantField+`"`) || len(fd.calls) != 0 {
					t.Errorf("body = %s calls = %v", raw, fd.calls)
				}
				return
			}
			if !fd.in.Expected.Equal(tt.wantAt) || fd.in.ExpectedVersion != tt.wantNonce || fd.in.Content != "hello" || fd.in.BaseRef != "main" || fd.in.Device != "laptop" {
				t.Errorf("input = %+v", fd.in)
			}
			if resp.Header.Get("ETag") != etag {
				t.Errorf("ETag = %q", resp.Header.Get("ETag"))
			}
		})
	}
}

func TestDraftConflictReturnsCurrentMetadata(t *testing.T) {
	cur := sampleDraft()
	cur.Content = ""
	for name, err := range map[string]error{
		"newer draft": &drafts.ConflictError{Current: &cur},
		"gone":        &drafts.ConflictError{},
	} {
		t.Run(name, func(t *testing.T) {
			fd := &fakeDrafts{err: err}
			resp := do(t, newTestHandler(t, draftDeps(&fakeAuth{}, fd)), browserReq(http.MethodPut, "/api/galley/repos/7/drafts/a.qmd", putBody))
			if resp.StatusCode != http.StatusConflict {
				t.Fatalf("status = %d", resp.StatusCode)
			}
			var body struct {
				Error   string         `json:"error"`
				Current map[string]any `json:"current"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&body)
			if body.Error != "Conflict" {
				t.Errorf("error = %q", body.Error)
			}
			if name == "newer draft" && (body.Current["etag"] != cur.ETag() || body.Current["content"] != nil) {
				t.Errorf("current = %v", body.Current)
			}
			if name == "gone" && body.Current != nil {
				t.Errorf("current = %v, want null", body.Current)
			}
		})
	}
}

func TestDraftErrorsAndLimits(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		body       string
		wantStatus int
	}{
		{"other user's draft", comments.ErrNotFound, putBody, 404},
		{"count limit", drafts.ErrLimit, putBody, 422},
		{"rate limited", comments.ErrRateLimited, putBody, 429},
		{"too large", nil, `{"content":"` + strings.Repeat("x", 12<<20+128<<10) + `"}`, 413},
		{"unknown field", nil, `{"content":"x","owner":"u2"}`, 400},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fd := &fakeDrafts{err: tt.err}
			resp := do(t, newTestHandler(t, draftDeps(&fakeAuth{}, fd)), browserReq(http.MethodPut, "/api/galley/repos/7/drafts/a.qmd", tt.body))
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
		})
	}
	// A 2 MB draft of control characters, each escaped as \u00XX (6 bytes),
	// still fits the request limit.
	content := strings.Repeat(`\u0001`, 2<<20)
	resp := do(t, newTestHandler(t, draftDeps(&fakeAuth{}, &fakeDrafts{})),
		browserReq(http.MethodPut, "/api/galley/repos/7/drafts/a.qmd", `{"base_sha":"`+strings.Repeat("a", 40)+`","content":"`+content+`"}`))
	if resp.StatusCode != http.StatusCreated {
		t.Errorf("2 MB escaped draft: %d", resp.StatusCode)
	}
}

// newRouteChecks lists one request per new route, for the middleware tests.
func newRouteChecks() []struct{ method, path, body string } {
	return []struct{ method, path, body string }{
		{http.MethodGet, "/api/galley/repos/7/drafts", ""},
		{http.MethodGet, "/api/galley/repos/7/drafts/a.qmd", ""},
		{http.MethodPut, "/api/galley/repos/7/drafts/a.qmd", putBody},
		{http.MethodDelete, "/api/galley/repos/7/drafts/a.qmd", ""},
		{http.MethodDelete, "/api/galley/repos/7/drafts", ""},
		{http.MethodGet, "/api/galley/repos/7/chat", ""},
		{http.MethodPost, "/api/galley/repos/7/chat", `{"body":"hi"}`},
		{http.MethodPost, "/api/galley/repos/7/chat/read", `{}`},
		{http.MethodGet, "/api/galley/repos/7/chat/unread", ""},
		{http.MethodGet, "/api/galley/repos/7/chat/stream", ""},
	}
}

func allDeps(fa *fakeAuth) (httpapi.Deps, *fakeDrafts, *fakeChat) {
	fd, fc := &fakeDrafts{}, newFakeChat()
	d := testDeps(fa)
	d.Drafts, d.Chat = fd, fc
	return d, fd, fc
}

func TestNewRoutesRequireOriginCSRFAndSession(t *testing.T) {
	for _, rt := range newRouteChecks() {
		cases := []struct {
			name   string
			edit   func(*http.Request)
			auth   error
			status int
		}{
			{"no Origin", func(r *http.Request) { r.Header.Del("Origin") }, nil, 403},
			{"foreign Origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, nil, 403},
			{"no session", func(r *http.Request) {
				r.Header.Del("Cookie")
			}, nil, 401},
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
				d, fd, fc := allDeps(&fakeAuth{authErr: c.auth})
				req := browserReq(rt.method, rt.path, rt.body)
				c.edit(req)
				resp := do(t, newTestHandler(t, d), req)
				if resp.StatusCode != c.status {
					t.Fatalf("status = %d, want %d", resp.StatusCode, c.status)
				}
				if len(fd.calls) != 0 || fc.callCount() != 0 {
					t.Errorf("service called: %v %v", fd.calls, fc.calls)
				}
			})
		}
	}
}

func TestNewRoutesCORS(t *testing.T) {
	d, _, _ := allDeps(&fakeAuth{})
	h := newTestHandler(t, d)
	for _, rt := range newRouteChecks() {
		req := httptest.NewRequest(http.MethodOptions, rt.path, nil)
		req.Header.Set("Origin", frontend)
		req.Header.Set("Access-Control-Request-Method", rt.method)
		req.Header.Set("Access-Control-Request-Headers", "content-type,x-galley-csrf,if-match")
		resp := do(t, h, req)
		hd := resp.Header
		if resp.StatusCode != http.StatusNoContent || hd.Get("Access-Control-Allow-Origin") != frontend || hd.Get("Access-Control-Allow-Credentials") != "true" {
			t.Errorf("%s %s preflight: %d %v", rt.method, rt.path, resp.StatusCode, hd)
		}
		if m := hd.Get("Access-Control-Allow-Methods"); !strings.Contains(m, "PUT") {
			t.Errorf("allow methods = %q", m)
		}
		if a := strings.ToLower(hd.Get("Access-Control-Allow-Headers")); !strings.Contains(a, "if-match") {
			t.Errorf("allow headers = %q", a)
		}
		evil := httptest.NewRequest(http.MethodOptions, rt.path, nil)
		evil.Header.Set("Origin", "https://evil.example")
		evil.Header.Set("Access-Control-Request-Method", rt.method)
		if got := do(t, h, evil).Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("%s allows a foreign origin: %q", rt.path, got)
		}
	}
	// ETag is readable cross-origin.
	resp := do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/drafts/a.qmd", ""))
	if !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), "ETag") {
		t.Errorf("expose headers = %q", resp.Header.Get("Access-Control-Expose-Headers"))
	}
}

func TestDraftAndChatRoutesAbsentWithoutService(t *testing.T) {
	h := newTestHandler(t, testDeps(&fakeAuth{}))
	for _, rt := range newRouteChecks() {
		if resp := do(t, h, browserReq(rt.method, rt.path, rt.body)); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s %s = %d", rt.method, rt.path, resp.StatusCode)
		}
	}
}

func TestCommentsStillWorkNextToDraftsAndChat(t *testing.T) {
	d, _, _ := allDeps(&fakeAuth{})
	fc := &fakeComments{}
	d.Comments = fc
	resp := do(t, newTestHandler(t, d), browserReq(http.MethodGet, "/api/galley/repos/7/threads", ""))
	if resp.StatusCode != http.StatusOK || len(fc.calls) != 1 {
		t.Errorf("threads = %d %v", resp.StatusCode, fc.calls)
	}
}

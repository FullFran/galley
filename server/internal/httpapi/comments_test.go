package httpapi_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/httpapi"
)

const threadID = "abcdefghijklmn0"

var created = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

// fakeComments records the last call and returns err, or canned values.
type fakeComments struct {
	mu        sync.Mutex
	err       error
	calls     []string
	actor     comments.Actor
	repoID    int64
	id        string
	filter    comments.ListFilter
	newThread comments.NewThread
	comment   comments.NewComment
}

func (f *fakeComments) record(name string, a comments.Actor) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.actor = a
	return f.err
}

func sampleThread() comments.Thread {
	return comments.Thread{
		ID: threadID, RepoID: 7, RepoFullName: "o/r", Status: comments.StatusOpen, Origin: comments.OriginSource,
		Anchor: comments.Anchor{Path: "a.qmd", CommitSHA: strings.Repeat("a", 40),
			Range: comments.Range{StartLine: 3, EndLine: 4}, Quote: comments.Quote{Exact: "quoted"}},
		Position:  comments.Position{CommitSHA: strings.Repeat("a", 40), Range: comments.Range{StartLine: 3, EndLine: 4}, State: comments.AnchorExact},
		CreatedBy: "alice", CreatedAt: created, UpdatedAt: created,
		Comments: []comments.Comment{{ID: "comment00000001", ThreadID: threadID, AuthorKind: comments.AuthorHuman,
			AuthorLogin: "alice", Mine: true, Body: "hello", CreatedAt: created,
			Suggestion: &comments.Suggestion{Text: "new", BaseSHA: strings.Repeat("a", 40)}}},
	}
}

func (f *fakeComments) ListThreads(_ context.Context, a comments.Actor, repoID int64, fl comments.ListFilter) (comments.ThreadList, error) {
	f.repoID, f.filter = repoID, fl
	if err := f.record("list", a); err != nil {
		return comments.ThreadList{}, err
	}
	return comments.ThreadList{Threads: []comments.Thread{sampleThread()}}, nil
}

func (f *fakeComments) CreateThread(_ context.Context, a comments.Actor, repoID int64, in comments.NewThread) (comments.Thread, error) {
	f.repoID, f.newThread = repoID, in
	if err := f.record("create", a); err != nil {
		return comments.Thread{}, err
	}
	return sampleThread(), nil
}

func (f *fakeComments) GetThread(_ context.Context, a comments.Actor, id string) (comments.Thread, error) {
	f.id = id
	if err := f.record("get", a); err != nil {
		return comments.Thread{}, err
	}
	return sampleThread(), nil
}

func (f *fakeComments) Reply(_ context.Context, a comments.Actor, id string, in comments.NewComment) (comments.Comment, error) {
	f.id, f.comment = id, in
	if err := f.record("reply", a); err != nil {
		return comments.Comment{}, err
	}
	return sampleThread().Comments[0], nil
}

func (f *fakeComments) EditComment(_ context.Context, a comments.Actor, id string, in comments.NewComment) (comments.Comment, error) {
	f.id, f.comment = id, in
	if err := f.record("edit", a); err != nil {
		return comments.Comment{}, err
	}
	return sampleThread().Comments[0], nil
}

func (f *fakeComments) DeleteComment(_ context.Context, a comments.Actor, id string) error {
	f.id = id
	return f.record("delete", a)
}

func (f *fakeComments) Resolve(_ context.Context, a comments.Actor, id string) (comments.Thread, error) {
	f.id = id
	if err := f.record("resolve", a); err != nil {
		return comments.Thread{}, err
	}
	return sampleThread(), nil
}

func (f *fakeComments) Reopen(_ context.Context, a comments.Actor, id string) (comments.Thread, error) {
	f.id = id
	if err := f.record("reopen", a); err != nil {
		return comments.Thread{}, err
	}
	return sampleThread(), nil
}

func (f *fakeComments) MarkRead(_ context.Context, a comments.Actor, id string) error {
	f.id = id
	return f.record("read", a)
}

func (f *fakeComments) Unread(_ context.Context, a comments.Actor, repoID int64) (comments.Unread, error) {
	f.repoID = repoID
	if err := f.record("unread", a); err != nil {
		return comments.Unread{}, err
	}
	return comments.Unread{RepoID: repoID, Threads: 1, Comments: 2, ByThread: map[string]int{threadID: 2}}, nil
}

func commentDeps(fa *fakeAuth, fc *fakeComments) httpapi.Deps {
	d := testDeps(fa)
	d.Comments = fc
	return d
}

func browserReq(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Origin", frontend)
	if method != http.MethodGet {
		req.Header.Set("X-Galley-CSRF", "1")
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: httpapi.SessionCookie, Value: "session-token"})
	return req
}

const createBody = `{"path":"a.qmd","commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","start_line":3,"end_line":4,
"start_column":2,"end_column":7,"quote":{"exact":"q","prefix":"p","suffix":"s"},"origin":"preview","body":"hi","suggestion":""}`

func TestCommentRoutes(t *testing.T) {
	tests := []struct {
		method, path, body string
		wantStatus         int
		wantCall           string
	}{
		{http.MethodGet, "/api/galley/repos/7/threads?path=a.qmd&status=open&at=" + strings.Repeat("b", 40), "", 200, "list"},
		{http.MethodPost, "/api/galley/repos/7/threads", createBody, 201, "create"},
		{http.MethodGet, "/api/galley/repos/7/unread", "", 200, "unread"},
		{http.MethodGet, "/api/galley/threads/" + threadID, "", 200, "get"},
		{http.MethodPost, "/api/galley/threads/" + threadID + "/comments", `{"body":"reply"}`, 201, "reply"},
		{http.MethodPost, "/api/galley/threads/" + threadID + "/resolve", "", 200, "resolve"},
		{http.MethodPost, "/api/galley/threads/" + threadID + "/reopen", "", 200, "reopen"},
		{http.MethodPost, "/api/galley/threads/" + threadID + "/read", "", 204, "read"},
		{http.MethodPatch, "/api/galley/comments/comment00000001", `{"body":"edited","suggestion":"x"}`, 200, "edit"},
		{http.MethodDelete, "/api/galley/comments/comment00000001", "", 204, "delete"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			fa, fc := &fakeAuth{}, &fakeComments{}
			resp := do(t, newTestHandler(t, commentDeps(fa, fc)), browserReq(tt.method, tt.path, tt.body))
			if resp.StatusCode != tt.wantStatus {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, want %d (%s)", resp.StatusCode, tt.wantStatus, body)
			}
			if len(fc.calls) != 1 || fc.calls[0] != tt.wantCall {
				t.Fatalf("calls = %v, want [%s]", fc.calls, tt.wantCall)
			}
			if fc.actor != (comments.Actor{UserID: "u1", Login: "octo"}) {
				t.Errorf("actor = %+v", fc.actor)
			}
			if resp.Header.Get("Cache-Control") != "no-store" {
				t.Errorf("Cache-Control = %q", resp.Header.Get("Cache-Control"))
			}
			if resp.Header.Get("Access-Control-Allow-Origin") != frontend || resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
				t.Errorf("CORS headers = %v", resp.Header)
			}
		})
	}
}

func TestCommentRequestsAreDecoded(t *testing.T) {
	fa, fc := &fakeAuth{}, &fakeComments{}
	h := newTestHandler(t, commentDeps(fa, fc))

	do(t, h, browserReq(http.MethodPost, "/api/galley/repos/7/threads", createBody))
	n := fc.newThread
	want := comments.Range{StartLine: 3, EndLine: 4, StartColumn: 2, EndColumn: 7}
	if fc.repoID != 7 || n.Path != "a.qmd" || n.Range != want || n.Origin != comments.OriginPreview ||
		n.Quote != (comments.Quote{Exact: "q", Prefix: "p", Suffix: "s"}) || n.Body != "hi" || n.Suggestion == nil || *n.Suggestion != "" {
		t.Errorf("new thread = %+v", n)
	}

	do(t, h, browserReq(http.MethodGet, "/api/galley/repos/7/threads?path=a.qmd&status=open", ""))
	if fc.filter != (comments.ListFilter{Path: "a.qmd", Status: comments.StatusOpen}) {
		t.Errorf("filter = %+v", fc.filter)
	}

	do(t, h, browserReq(http.MethodPost, "/api/galley/threads/"+threadID+"/comments", `{"body":"reply"}`))
	if fc.id != threadID || fc.comment.Body != "reply" || fc.comment.Suggestion != nil {
		t.Errorf("reply = %q %+v", fc.id, fc.comment)
	}
}

func TestThreadJSON(t *testing.T) {
	resp := do(t, newTestHandler(t, commentDeps(&fakeAuth{}, &fakeComments{})), browserReq(http.MethodGet, "/api/galley/threads/"+threadID, ""))
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	anchor := got["anchor"].(map[string]any)
	if got["id"] != threadID || got["status"] != "open" || anchor["path"] != "a.qmd" || anchor["start_line"] != 3.0 {
		t.Errorf("thread = %v", got)
	}
	if _, ok := anchor["start_column"]; ok {
		t.Error("whole-line anchors must omit columns")
	}
	if q := anchor["quote"].(map[string]any); q["exact"] != "quoted" {
		t.Errorf("quote = %v", q)
	}
	if p := got["position"].(map[string]any); p["state"] != "exact" {
		t.Errorf("position = %v", p)
	}
	c := got["comments"].([]any)[0].(map[string]any)
	author := c["author"].(map[string]any)
	if c["body"] != "hello" || c["mine"] != true || author["kind"] != "human" || author["login"] != "alice" ||
		c["created_at"] != "2026-10-28T12:00:00Z" {
		t.Errorf("comment = %v", c)
	}
	if s := c["suggestion"].(map[string]any); s["text"] != "new" {
		t.Errorf("suggestion = %v", s)
	}
	for _, internal := range []string{"author_user", "user_id", "u1"} {
		if strings.Contains(fmt.Sprint(got), internal) {
			t.Errorf("response exposes %q", internal)
		}
	}
}

func TestCommentRoutesRequireOriginCSRFAndSession(t *testing.T) {
	tests := []struct {
		name       string
		req        func() *http.Request
		authErr    error
		wantStatus int
	}{
		{name: "GET without Origin", wantStatus: 403, req: func() *http.Request {
			r := browserReq(http.MethodGet, "/api/galley/threads/"+threadID, "")
			r.Header.Del("Origin")
			return r
		}},
		{name: "GET from another origin", wantStatus: 403, req: func() *http.Request {
			r := browserReq(http.MethodGet, "/api/galley/threads/"+threadID, "")
			r.Header.Set("Origin", "https://evil.example")
			return r
		}},
		{name: "GET needs no CSRF header", wantStatus: 200, req: func() *http.Request {
			return browserReq(http.MethodGet, "/api/galley/threads/"+threadID, "")
		}},
		{name: "POST without CSRF header", wantStatus: 403, req: func() *http.Request {
			r := browserReq(http.MethodPost, "/api/galley/threads/"+threadID+"/resolve", "")
			r.Header.Del("X-Galley-CSRF")
			return r
		}},
		{name: "DELETE with a wrong CSRF value", wantStatus: 403, req: func() *http.Request {
			r := browserReq(http.MethodDelete, "/api/galley/comments/comment00000001", "")
			r.Header.Set("X-Galley-CSRF", "0")
			return r
		}},
		{name: "no session cookie", wantStatus: 401, req: func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/galley/threads/"+threadID, nil)
			r.Header.Set("Origin", frontend)
			return r
		}},
		{name: "expired session", authErr: auth.ErrUnauthenticated, wantStatus: 401, req: func() *http.Request {
			return browserReq(http.MethodGet, "/api/galley/threads/"+threadID, "")
		}},
		{name: "session store down", authErr: errors.New("db down"), wantStatus: 503, req: func() *http.Request {
			return browserReq(http.MethodGet, "/api/galley/threads/"+threadID, "")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fa, fc := &fakeAuth{authErr: tt.authErr}, &fakeComments{}
			resp := do(t, newTestHandler(t, commentDeps(fa, fc)), tt.req())
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			if tt.wantStatus != 200 && len(fc.calls) != 0 {
				t.Errorf("service called: %v", fc.calls)
			}
		})
	}
}

func TestCommentErrorMapping(t *testing.T) {
	tests := []struct {
		err        error
		wantStatus int
	}{
		{comments.ErrUnauthenticated, 401},
		{comments.ErrForbidden, 403},
		{comments.ErrNotFound, 404},
		{comments.ErrConflict, 409},
		{&comments.ValidationError{Field: "body"}, 422},
		{comments.ErrRateLimited, 429},
		{fmt.Errorf("%w: github: secret detail", comments.ErrUnavailable), 503},
		{errors.New("secret detail"), 500},
	}
	for _, tt := range tests {
		t.Run(tt.err.Error(), func(t *testing.T) {
			fc := &fakeComments{err: tt.err}
			resp := do(t, newTestHandler(t, commentDeps(&fakeAuth{}, fc)),
				browserReq(http.MethodPost, "/api/galley/threads/"+threadID+"/comments", `{"body":"x"}`))
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			raw, _ := io.ReadAll(resp.Body)
			var body map[string]string
			if err := json.Unmarshal(raw, &body); err != nil || body["error"] != http.StatusText(tt.wantStatus) {
				t.Errorf("body = %s", raw)
			}
			if strings.Contains(string(raw), "secret") {
				t.Errorf("error body leaks details: %s", raw)
			}
			if tt.wantStatus == 422 && body["field"] != "body" {
				t.Errorf("422 does not name the field: %s", raw)
			}
		})
	}
}

func TestCommentBodiesAreStrict(t *testing.T) {
	tests := []struct {
		name, method, path, body string
		wantStatus               int
	}{
		{"malformed JSON", http.MethodPost, "/api/galley/threads/" + threadID + "/comments", `{"body":`, 400},
		{"unknown field", http.MethodPost, "/api/galley/threads/" + threadID + "/comments", `{"body":"x","author_kind":"ai"}`, 400},
		{"trailing data", http.MethodPost, "/api/galley/threads/" + threadID + "/comments", `{"body":"x"}{"body":"y"}`, 400},
		{"wrong type", http.MethodPost, "/api/galley/repos/7/threads", `{"start_line":"3"}`, 400},
		{"too large", http.MethodPost, "/api/galley/threads/" + threadID + "/comments", `{"body":"` + strings.Repeat("x", 200<<10) + `"}`, 413},
		{"non-numeric repo", http.MethodGet, "/api/galley/repos/abc/threads", "", 404},
		{"negative repo", http.MethodGet, "/api/galley/repos/-1/unread", "", 404},
		{"unknown status filter", http.MethodGet, "/api/galley/repos/7/threads?status=all", "", 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fc := &fakeComments{}
			resp := do(t, newTestHandler(t, commentDeps(&fakeAuth{}, fc)), browserReq(tt.method, tt.path, tt.body))
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			if tt.wantStatus >= 400 && len(fc.calls) != 0 {
				t.Errorf("service called: %v", fc.calls)
			}
		})
	}
}

func TestCommentCORS(t *testing.T) {
	for _, path := range []string{"/api/galley/repos/7/threads", "/api/galley/threads/" + threadID + "/resolve", "/api/galley/comments/comment00000001"} {
		req := httptest.NewRequest(http.MethodOptions, path, nil)
		req.Header.Set("Origin", frontend)
		req.Header.Set("Access-Control-Request-Method", "PATCH")
		req.Header.Set("Access-Control-Request-Headers", "content-type,x-galley-csrf")
		resp := do(t, newTestHandler(t, commentDeps(&fakeAuth{}, &fakeComments{})), req)
		h := resp.Header
		if resp.StatusCode != http.StatusNoContent || h.Get("Access-Control-Allow-Origin") != frontend || h.Get("Access-Control-Allow-Credentials") != "true" {
			t.Errorf("%s preflight: %d %v", path, resp.StatusCode, h)
		}
		if m := h.Get("Access-Control-Allow-Methods"); !strings.Contains(m, "PATCH") || !strings.Contains(m, "DELETE") {
			t.Errorf("%s allow methods = %q", path, m)
		}

		evil := httptest.NewRequest(http.MethodOptions, path, nil)
		evil.Header.Set("Origin", "https://evil.example")
		evil.Header.Set("Access-Control-Request-Method", "POST")
		if got := do(t, newTestHandler(t, commentDeps(&fakeAuth{}, &fakeComments{})), evil).Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("%s allows a foreign origin: %q", path, got)
		}
	}
}

func TestCommentRoutesAbsentWithoutService(t *testing.T) {
	resp := do(t, newTestHandler(t, testDeps(&fakeAuth{})), browserReq(http.MethodGet, "/api/galley/threads/"+threadID, ""))
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

func TestWebhookFlushesAccessCache(t *testing.T) {
	for _, event := range []string{"installation", "installation_repositories", "member", "membership", "organization", "team", "repository"} {
		flushed := 0
		d := testDeps(&fakeAuth{})
		d.OnAccessChange = func() { flushed++ }
		body := `{"action":"removed"}`
		req := httptest.NewRequest(http.MethodPost, "/api/galley/auth/webhook", strings.NewReader(body))
		req.Header.Set("X-GitHub-Event", event)
		req.Header.Set("X-Hub-Signature-256", sign(body))
		resp := do(t, newTestHandler(t, d), req)
		if resp.StatusCode != http.StatusNoContent || flushed != 1 {
			t.Errorf("%s: status %d, flushed %d", event, resp.StatusCode, flushed)
		}
	}
}

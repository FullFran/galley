package httpapi_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/chat"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/httpapi"
)

var errExpired = auth.ErrUnauthenticated

type fakeStream struct {
	backlog []chat.Message
	resync  bool
	ch      chan chat.Message
	done    chan struct{}
	once    sync.Once
	closed  chan struct{}
}

func newFakeStream() *fakeStream {
	return &fakeStream{ch: make(chan chat.Message, 8), done: make(chan struct{}), closed: make(chan struct{})}
}

func (s *fakeStream) Backlog() []chat.Message       { return s.backlog }
func (s *fakeStream) Resync() bool                  { return s.resync }
func (s *fakeStream) Messages() <-chan chat.Message { return s.ch }
func (s *fakeStream) Done() <-chan struct{}         { return s.done }
func (s *fakeStream) Close()                        { s.once.Do(func() { close(s.closed) }) }
func (s *fakeStream) end()                          { close(s.done) }
func (s *fakeStream) wasClosed(t *testing.T, d time.Duration) bool {
	t.Helper()
	select {
	case <-s.closed:
		return true
	case <-time.After(d):
		return false
	}
}

type fakeChat struct {
	mu       sync.Mutex
	err      error
	checkErr error
	calls    []string
	actor    comments.Actor
	repoID   int64
	before   int64
	limit    int
	seq      int64
	body     string
	after    int64
	stream   *fakeStream
}

func newFakeChat() *fakeChat { return &fakeChat{stream: newFakeStream()} }

func (f *fakeChat) record(name string, a comments.Actor, repoID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.actor, f.repoID = a, repoID
	return f.err
}

func (f *fakeChat) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

var chatAt = time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

func sampleMessage(seq int64) chat.Message {
	return chat.Message{ID: "message00000001", RepoID: 7, Seq: seq, AuthorLogin: "alice", Body: "hi\nthere", CreatedAt: chatAt}
}

func (f *fakeChat) History(_ context.Context, a comments.Actor, repoID, before int64, limit int) (chat.Page, error) {
	f.mu.Lock()
	f.before, f.limit = before, limit
	f.mu.Unlock()
	if err := f.record("history", a, repoID); err != nil {
		return chat.Page{}, err
	}
	return chat.Page{Messages: []chat.Message{sampleMessage(1), sampleMessage(2)}, HasMore: true}, nil
}

func (f *fakeChat) Post(_ context.Context, a comments.Actor, repoID int64, body string) (chat.Message, error) {
	f.mu.Lock()
	f.body = body
	f.mu.Unlock()
	if err := f.record("post", a, repoID); err != nil {
		return chat.Message{}, err
	}
	m := sampleMessage(3)
	m.Mine = true
	return m, nil
}

func (f *fakeChat) MarkRead(_ context.Context, a comments.Actor, repoID, seq int64) (int64, error) {
	f.mu.Lock()
	f.seq = seq
	f.mu.Unlock()
	if err := f.record("read", a, repoID); err != nil {
		return 0, err
	}
	return 9, nil
}

func (f *fakeChat) Unread(_ context.Context, a comments.Actor, repoID int64) (chat.Unread, error) {
	if err := f.record("unread", a, repoID); err != nil {
		return chat.Unread{}, err
	}
	return chat.Unread{RepoID: repoID, Count: 2, LastReadSeq: 1, LatestSeq: 3}, nil
}

func (f *fakeChat) Subscribe(_ context.Context, a comments.Actor, repoID, after int64) (httpapi.ChatStream, error) {
	f.mu.Lock()
	f.after = after
	f.mu.Unlock()
	if err := f.record("subscribe", a, repoID); err != nil {
		return nil, err
	}
	return f.stream, nil
}

func (f *fakeChat) Check(_ context.Context, _ comments.Actor, _ int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checkErr
}

func (f *fakeChat) setCheckErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checkErr = err
}

func chatDeps(fa *fakeAuth, fc *fakeChat) httpapi.Deps {
	d := testDeps(fa)
	d.Chat = fc
	return d
}

func TestChatRoutes(t *testing.T) {
	tests := []struct {
		method, path, body string
		wantStatus         int
		wantCall           string
	}{
		{http.MethodGet, "/api/galley/repos/7/chat?before_seq=10&limit=20", "", 200, "history"},
		{http.MethodPost, "/api/galley/repos/7/chat", `{"body":"hello"}`, 201, "post"},
		{http.MethodPost, "/api/galley/repos/7/chat/read", `{"seq":4}`, 200, "read"},
		{http.MethodGet, "/api/galley/repos/7/chat/unread", "", 200, "unread"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			fc := newFakeChat()
			resp := do(t, newTestHandler(t, chatDeps(&fakeAuth{}, fc)), browserReq(tt.method, tt.path, tt.body))
			raw, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d (%s)", resp.StatusCode, tt.wantStatus, raw)
			}
			if len(fc.calls) != 1 || fc.calls[0] != tt.wantCall || fc.repoID != 7 || fc.actor.UserID != "u1" {
				t.Fatalf("calls = %v repo=%d actor=%+v", fc.calls, fc.repoID, fc.actor)
			}
			switch tt.wantCall {
			case "history":
				var page struct {
					Messages []map[string]any `json:"messages"`
					HasMore  bool             `json:"has_more"`
				}
				_ = json.Unmarshal(raw, &page)
				if fc.before != 10 || fc.limit != 20 || len(page.Messages) != 2 || !page.HasMore || page.Messages[0]["seq"] != 1.0 {
					t.Errorf("history = %s (before %d limit %d)", raw, fc.before, fc.limit)
				}
			case "post":
				if fc.body != "hello" || !strings.Contains(string(raw), `"mine":true`) {
					t.Errorf("post = %s", raw)
				}
			case "read":
				if fc.seq != 4 || !strings.Contains(string(raw), `"last_read_seq":9`) {
					t.Errorf("read = %s", raw)
				}
			case "unread":
				if !strings.Contains(string(raw), `"unread":2`) || !strings.Contains(string(raw), `"latest_seq":3`) {
					t.Errorf("unread = %s", raw)
				}
			}
			if strings.Contains(string(raw), "u1") {
				t.Errorf("response exposes the user id: %s", raw)
			}
		})
	}
}

func TestChatInputErrors(t *testing.T) {
	tests := []struct {
		name, method, path, body string
		err                      error
		wantStatus               int
	}{
		{"bad before_seq", http.MethodGet, "/api/galley/repos/7/chat?before_seq=x", "", nil, 422},
		{"negative limit", http.MethodGet, "/api/galley/repos/7/chat?limit=-1", "", nil, 422},
		{"huge limit", http.MethodGet, "/api/galley/repos/7/chat?limit=1000", "", nil, 422},
		{"oversized body", http.MethodPost, "/api/galley/repos/7/chat", `{"body":"` + strings.Repeat("x", 40<<10) + `"}`, nil, 413},
		{"unknown field", http.MethodPost, "/api/galley/repos/7/chat", `{"body":"x","author":"u2"}`, nil, 400},
		{"invalid body", http.MethodPost, "/api/galley/repos/7/chat", `{"body":""}`, &comments.ValidationError{Field: "body"}, 422},
		{"rate limited", http.MethodPost, "/api/galley/repos/7/chat", `{"body":"x"}`, comments.ErrRateLimited, 429},
		{"no access", http.MethodGet, "/api/galley/repos/7/chat", "", comments.ErrNotFound, 404},
		{"bad Last-Event-ID", http.MethodGet, "/api/galley/repos/7/chat/stream?last_event_id=x", "", nil, 422},
		{"stream cap", http.MethodGet, "/api/galley/repos/7/chat/stream", "", chat.ErrTooManyStreams, 429},
		{"stream no access", http.MethodGet, "/api/galley/repos/7/chat/stream", "", comments.ErrNotFound, 404},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fc := newFakeChat()
			fc.err = tt.err
			resp := do(t, newTestHandler(t, chatDeps(&fakeAuth{}, fc)), browserReq(tt.method, tt.path, tt.body))
			if resp.StatusCode != tt.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantStatus)
			}
			if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
		})
	}
}

// sse reads events from a live stream.
type sse struct {
	resp *http.Response
	r    *bufio.Reader
}

func openStream(t *testing.T, srv *httptest.Server, path string, edit func(*http.Request)) *sse {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	req.Header.Set("Origin", frontend)
	req.AddCookie(&http.Cookie{Name: httpapi.SessionCookie, Value: "session-token"})
	if edit != nil {
		edit(req)
	}
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return &sse{resp: resp, r: bufio.NewReader(resp.Body)}
}

// next returns the next event block (lines up to a blank line), or "" at EOF.
func (s *sse) next(t *testing.T) string {
	t.Helper()
	type res struct {
		block string
		err   error
	}
	ch := make(chan res, 1)
	go func() {
		var b strings.Builder
		for {
			line, err := s.r.ReadString('\n')
			if err != nil {
				ch <- res{b.String(), err}
				return
			}
			if line == "\n" {
				ch <- res{b.String(), nil}
				return
			}
			b.WriteString(line)
		}
	}()
	select {
	case r := <-ch:
		return r.block
	case <-time.After(3 * time.Second):
		t.Fatal("no event")
		return ""
	}
}

func newStreamServer(t *testing.T, fa *fakeAuth, fc *fakeChat, beat time.Duration) *httptest.Server {
	d := chatDeps(fa, fc)
	d.ChatHeartbeat = beat
	srv := httptest.NewServer(newTestHandler(t, d))
	t.Cleanup(srv.Close)
	return srv
}

func TestChatStreamDeliversEvents(t *testing.T) {
	fc := newFakeChat()
	fc.stream.backlog = []chat.Message{sampleMessage(4), sampleMessage(5)}
	srv := newStreamServer(t, &fakeAuth{}, fc, time.Hour)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream", func(r *http.Request) { r.Header.Set("Last-Event-ID", "3") })

	h := s.resp.Header
	if s.resp.StatusCode != 200 || h.Get("Content-Type") != "text/event-stream" || h.Get("X-Accel-Buffering") != "no" ||
		h.Get("Cache-Control") != "no-store" || h.Get("Access-Control-Allow-Origin") != frontend {
		t.Fatalf("stream response = %d %v", s.resp.StatusCode, h)
	}
	if b := s.next(t); b != "retry: 5000\n" {
		t.Errorf("first block = %q", b)
	}
	if b := s.next(t); !strings.HasPrefix(b, "id: 4\nevent: message\ndata: {") || !strings.Contains(b, `"body":"hi\nthere"`) {
		t.Errorf("backlog event = %q", b)
	}
	s.next(t) // seq 5
	if fc.after != 3 {
		t.Errorf("after = %d, want the Last-Event-ID", fc.after)
	}
	fc.stream.ch <- sampleMessage(5) // duplicate of the backlog tail: skipped
	fc.stream.ch <- sampleMessage(6)
	if b := s.next(t); !strings.HasPrefix(b, "id: 6\n") {
		t.Errorf("live event = %q", b)
	}
}

func TestChatStreamResyncAndQueryLastEventID(t *testing.T) {
	fc := newFakeChat()
	fc.stream.resync = true
	srv := newStreamServer(t, &fakeAuth{}, fc, time.Hour)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream?last_event_id=8", nil)
	s.next(t)
	if b := s.next(t); b != "event: resync\ndata: {}\n" {
		t.Errorf("resync = %q", b)
	}
	if fc.after != 8 {
		t.Errorf("after = %d", fc.after)
	}
}

func TestChatStreamHeartbeat(t *testing.T) {
	fc := newFakeChat()
	srv := newStreamServer(t, &fakeAuth{}, fc, 20*time.Millisecond)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream", nil)
	s.next(t)
	for range 2 {
		if b := s.next(t); b != ": ping\n" {
			t.Fatalf("heartbeat = %q", b)
		}
	}
}

func TestChatStreamEndsWhenAccessIsRevoked(t *testing.T) {
	fc := newFakeChat()
	srv := newStreamServer(t, &fakeAuth{}, fc, 20*time.Millisecond)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream", nil)
	s.next(t)
	fc.setCheckErr(comments.ErrNotFound)
	for {
		b := s.next(t)
		if b == "event: close\ndata: {}\n" {
			break
		}
		if b != ": ping\n" {
			t.Fatalf("unexpected block %q", b)
		}
	}
	if b := s.next(t); b != "" {
		t.Errorf("after close = %q, want EOF", b)
	}
	if !fc.stream.wasClosed(t, time.Second) {
		t.Error("subscription not released")
	}
}

func TestChatStreamEndsWhenTheSessionEnds(t *testing.T) {
	fa, fc := &fakeAuth{}, newFakeChat()
	srv := newStreamServer(t, fa, fc, 20*time.Millisecond)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream", nil)
	s.next(t)
	fa.mu.Lock()
	fa.authErr = errors.New("logged out")
	fa.mu.Unlock()
	for b := s.next(t); b != "event: close\ndata: {}\n"; b = s.next(t) {
		if b == "" {
			t.Fatal("EOF before close event")
		}
	}
	if !fc.stream.wasClosed(t, time.Second) {
		t.Error("subscription not released")
	}
}

func TestChatStreamEndsWhenTheBrokerDropsIt(t *testing.T) {
	fc := newFakeChat()
	srv := newStreamServer(t, &fakeAuth{}, fc, time.Hour)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream", nil)
	s.next(t)
	fc.stream.end() // revocation (OnRevoke) or shutdown
	if b := s.next(t); b != "event: close\ndata: {}\n" {
		t.Errorf("close = %q", b)
	}
	if !fc.stream.wasClosed(t, time.Second) {
		t.Error("subscription not released")
	}
}

func TestChatStreamReleasesOnClientDisconnect(t *testing.T) {
	fc := newFakeChat()
	srv := newStreamServer(t, &fakeAuth{}, fc, time.Hour)
	s := openStream(t, srv, "/api/galley/repos/7/chat/stream", nil)
	s.next(t)
	s.resp.Body.Close()
	if !fc.stream.wasClosed(t, 2*time.Second) {
		t.Error("subscription kept after the client left")
	}
}

// The adapter exposes *chat.Service through ChatService.
var _ httpapi.ChatService = httpapi.ChatAdapter(nil)

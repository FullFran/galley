package chat_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/chat"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/secret"
)

var ctx = context.Background()

const (
	repo      int64 = 7
	otherRepo int64 = 8
)

type fakeAccess struct {
	mu    sync.Mutex
	perms map[string]comments.RepoPermission
	err   error
}

func (f *fakeAccess) Permission(_ context.Context, userID string, repoID int64) (comments.RepoPermission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return comments.RepoPermission{}, f.err
	}
	p, ok := f.perms[userID]
	if !ok || (repoID != repo && repoID != otherRepo) {
		return comments.RepoPermission{}, comments.ErrNotFound
	}
	return p, nil
}

func (f *fakeAccess) revoke(userID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.perms, userID)
}

type env struct {
	svc    *chat.Service
	app    core.App
	access *fakeAccess
	alice  comments.Actor
	bob    comments.Actor
	eve    comments.Actor // no access
}

func newEnv(t *testing.T, opts ...func(*chat.Config)) *env {
	t.Helper()
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatalf("test app: %v", err)
	}
	t.Cleanup(app.Cleanup)
	users := pbstore.New(app)
	actor := func(id int64, login string) comments.Actor {
		u, err := users.UpsertUser(ctx, auth.GitHubUser{ID: id, Login: login})
		if err != nil {
			t.Fatal(err)
		}
		return comments.Actor{UserID: u.ID, Login: u.Login}
	}
	e := &env{app: app, alice: actor(1, "alice"), bob: actor(2, "bob"), eve: actor(3, "eve")}
	e.access = &fakeAccess{perms: map[string]comments.RepoPermission{
		e.alice.UserID: {FullName: "o/paper", Pull: true, Push: true},
		e.bob.UserID:   {FullName: "o/paper", Pull: true},
	}}
	sealer, err := secret.NewSealer(bytes.Repeat([]byte{7}, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	cfg := chat.Config{Store: pbstore.NewChatStore(app), Access: e.access, Sealer: sealer}
	for _, o := range opts {
		o(&cfg)
	}
	if e.svc, err = chat.NewService(cfg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.svc.Shutdown)
	return e
}

// eve2 is a user with pull who is then deleted from the users collection.
func (e *env) eve2(t *testing.T) comments.Actor {
	t.Helper()
	u, err := pbstore.New(e.app).UpsertUser(ctx, auth.GitHubUser{ID: 99, Login: "leaver"})
	if err != nil {
		t.Fatal(err)
	}
	a := comments.Actor{UserID: u.ID, Login: u.Login}
	e.access.mu.Lock()
	e.access.perms[a.UserID] = comments.RepoPermission{FullName: "o/paper", Pull: true}
	e.access.mu.Unlock()
	return a
}

func (e *env) post(t *testing.T, a comments.Actor, r int64, body string) chat.Message {
	t.Helper()
	m, err := e.svc.Post(ctx, a, r, body)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	return m
}

func TestPostAssignsSequencePerRepo(t *testing.T) {
	e := newEnv(t)
	m1 := e.post(t, e.alice, repo, "first")
	m2 := e.post(t, e.bob, repo, "second")
	o1 := e.post(t, e.bob, otherRepo, "elsewhere")
	if m1.Seq != 1 || m2.Seq != 2 || o1.Seq != 1 {
		t.Errorf("seqs = %d %d %d, want 1 2 1", m1.Seq, m2.Seq, o1.Seq)
	}
	if m1.AuthorLogin != "alice" || !m1.Mine || m1.Body != "first" || m1.CreatedAt.IsZero() || len(m1.ID) != comments.IDLength {
		t.Errorf("message = %+v", m1)
	}
}

func TestConcurrentPostsGetDistinctSequences(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	seqs := make(chan int64, 20)
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a := e.alice
			if i%2 == 1 {
				a = e.bob
			}
			m, err := e.svc.Post(ctx, a, repo, fmt.Sprint("m", i))
			if err != nil {
				t.Error(err)
				return
			}
			seqs <- m.Seq
		}()
	}
	wg.Wait()
	close(seqs)
	seen := map[int64]bool{}
	for s := range seqs {
		if seen[s] {
			t.Errorf("duplicate seq %d", s)
		}
		seen[s] = true
	}
	for s := int64(1); s <= 20; s++ {
		if !seen[s] {
			t.Errorf("missing seq %d", s)
		}
	}
}

func TestHistoryPagination(t *testing.T) {
	e := newEnv(t)
	for i := 1; i <= 7; i++ {
		e.post(t, e.alice, repo, fmt.Sprint("m", i))
	}
	e.post(t, e.alice, otherRepo, "other")

	page, err := e.svc.History(ctx, e.bob, repo, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	if got := seqs(page.Messages); got != "5,6,7" || !page.HasMore {
		t.Fatalf("latest page = %s more=%v", got, page.HasMore)
	}
	if page.Messages[0].Mine || page.Messages[0].Body != "m5" {
		t.Errorf("bob's view = %+v", page.Messages[0])
	}
	page, _ = e.svc.History(ctx, e.bob, repo, 5, 3)
	if got := seqs(page.Messages); got != "2,3,4" || !page.HasMore {
		t.Errorf("second page = %s more=%v", got, page.HasMore)
	}
	page, _ = e.svc.History(ctx, e.bob, repo, 2, 3)
	if got := seqs(page.Messages); got != "1" || page.HasMore {
		t.Errorf("last page = %s more=%v", got, page.HasMore)
	}
	// Defaults and bounds.
	page, _ = e.svc.History(ctx, e.bob, repo, 0, 0)
	if len(page.Messages) != 7 {
		t.Errorf("default limit page = %d", len(page.Messages))
	}
	var ve *comments.ValidationError
	if _, err := e.svc.History(ctx, e.bob, repo, 0, chat.MaxPageSize+1); !errors.As(err, &ve) || ve.Field != "limit" {
		t.Errorf("oversized limit = %v", err)
	}
	if _, err := e.svc.History(ctx, e.bob, repo, -1, 10); !errors.As(err, &ve) || ve.Field != "before_seq" {
		t.Errorf("negative before = %v", err)
	}
}

func seqs(ms []chat.Message) string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = fmt.Sprint(m.Seq)
	}
	return strings.Join(out, ",")
}

func TestChatNeedsPull(t *testing.T) {
	e := newEnv(t)
	e.post(t, e.alice, repo, "secret plans")
	if _, err := e.svc.History(ctx, e.eve, repo, 0, 10); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("eve history = %v", err)
	}
	if _, err := e.svc.Post(ctx, e.eve, repo, "hi"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("eve post = %v", err)
	}
	if _, err := e.svc.Subscribe(ctx, e.eve, repo, 0); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("eve subscribe = %v", err)
	}
	e.access.perms[e.eve.UserID] = comments.RepoPermission{FullName: "o/paper"} // listed, no pull
	if _, err := e.svc.Unread(ctx, e.eve, repo); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("eve unread = %v", err)
	}
	if _, err := e.svc.Post(ctx, comments.Actor{}, repo, "x"); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("anonymous = %v", err)
	}
}

func TestBodyValidation(t *testing.T) {
	e := newEnv(t)
	for name, body := range map[string]string{
		"empty":     "",
		"blank":     " \n\t",
		"too long":  strings.Repeat("x", chat.MaxBodyBytes+1),
		"NUL":       "a\x00b",
		"bidi":      "abc‮def",
		"bad UTF-8": "\xff",
	} {
		_, err := e.svc.Post(ctx, e.alice, repo, body)
		var ve *comments.ValidationError
		if !errors.As(err, &ve) || ve.Field != "body" {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := e.svc.Post(ctx, e.alice, repo, strings.Repeat("x", chat.MaxBodyBytes)); err != nil {
		t.Errorf("4 KB body: %v", err)
	}
}

func TestPostsAreRateLimited(t *testing.T) {
	e := newEnv(t, func(c *chat.Config) { c.Limiter = comments.NewRateLimiter(2, time.Hour, nil) })
	e.post(t, e.alice, repo, "1")
	e.post(t, e.alice, repo, "2")
	if _, err := e.svc.Post(ctx, e.alice, repo, "3"); !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("third post = %v", err)
	}
	e.post(t, e.bob, repo, "bob has his own bucket")
}

func TestUnreadAndMarkRead(t *testing.T) {
	e := newEnv(t)
	e.post(t, e.alice, repo, "1")
	e.post(t, e.alice, repo, "2")
	e.post(t, e.bob, repo, "mine")
	e.post(t, e.alice, otherRepo, "elsewhere")

	u, err := e.svc.Unread(ctx, e.bob, repo)
	if err != nil || u.Count != 2 || u.LastReadSeq != 0 || u.LatestSeq != 3 {
		t.Fatalf("bob unread = %+v, %v", u, err)
	}
	if u, _ := e.svc.Unread(ctx, e.alice, repo); u.Count != 1 {
		t.Errorf("alice unread = %+v", u)
	}

	if seq, err := e.svc.MarkRead(ctx, e.bob, repo, 1); err != nil || seq != 1 {
		t.Fatalf("mark 1 = %d, %v", seq, err)
	}
	if u, _ := e.svc.Unread(ctx, e.bob, repo); u.Count != 1 || u.LastReadSeq != 1 {
		t.Errorf("after mark 1 = %+v", u)
	}
	// Markers never move back and never pass the newest message.
	if seq, _ := e.svc.MarkRead(ctx, e.bob, repo, 0); seq != 3 {
		t.Errorf("mark latest = %d", seq)
	}
	if seq, _ := e.svc.MarkRead(ctx, e.bob, repo, 1); seq != 3 {
		t.Errorf("mark back = %d, want 3", seq)
	}
	if seq, _ := e.svc.MarkRead(ctx, e.bob, repo, 99); seq != 3 {
		t.Errorf("mark beyond = %d, want 3", seq)
	}
	if u, _ := e.svc.Unread(ctx, e.bob, repo); u.Count != 0 {
		t.Errorf("after mark latest = %+v", u)
	}
	if u, _ := e.svc.Unread(ctx, e.bob, otherRepo); u.Count != 1 {
		t.Errorf("other repo = %+v", u)
	}
}

func TestBodiesAreSealedAndBoundToTheirRepo(t *testing.T) {
	e := newEnv(t)
	m := e.post(t, e.alice, repo, "PLAINTEXT-CHAT")
	rec, err := e.app.FindRecordById(pbstore.ChatMessagesCollection, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.GetString("body"), "PLAINTEXT") {
		t.Fatal("body stored in plaintext")
	}
	rec.Set("repo_id", otherRepo)
	rec.Set("seq", 100)
	if err := e.app.Save(rec); err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.History(ctx, e.alice, otherRepo, 0, 10)
	if err == nil || strings.Contains(err.Error(), "PLAINTEXT") {
		t.Errorf("moved message: %v", err)
	}

	// A body copied onto another message does not open either.
	a := e.post(t, e.alice, repo, "a")
	b := e.post(t, e.alice, repo, "b")
	ra, _ := e.app.FindRecordById(pbstore.ChatMessagesCollection, a.ID)
	rb, _ := e.app.FindRecordById(pbstore.ChatMessagesCollection, b.ID)
	rb.Set("body", ra.GetString("body"))
	if err := e.app.Save(rb); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.History(ctx, e.alice, repo, 0, 10); err == nil {
		t.Error("swapped body opens")
	}
}

func TestBodiesAreBoundToTheirAuthor(t *testing.T) {
	e := newEnv(t)
	m := e.post(t, e.alice, repo, "signed by alice")
	rec, _ := e.app.FindRecordById(pbstore.ChatMessagesCollection, m.ID)
	rec.Set("author", e.bob.UserID)
	rec.Set("author_login", "bob")
	if err := e.app.Save(rec); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.History(ctx, e.alice, repo, 0, 10); err == nil {
		t.Error("message reattributed to another author still opens")
	}
}

func TestHistorySurvivesDeletingTheAuthor(t *testing.T) {
	e := newEnv(t)
	leaver := e.eve2(t)
	e.post(t, leaver, repo, "from a user who leaves")
	u, err := e.app.FindRecordById(pbstore.UsersCollection, leaver.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.app.Delete(u); err != nil {
		t.Fatal(err)
	}
	page, err := e.svc.History(ctx, e.alice, repo, 0, 10)
	if err != nil || len(page.Messages) != 1 {
		t.Fatalf("history = %+v, %v", page, err)
	}
}

func recv(t *testing.T, s *chat.Subscription) chat.Message {
	t.Helper()
	select {
	case m := <-s.Messages():
		return m
	case <-s.Done():
		t.Fatal("subscription closed")
	case <-time.After(2 * time.Second):
		t.Fatal("no message")
	}
	return chat.Message{}
}

func silent(t *testing.T, s *chat.Subscription) {
	t.Helper()
	select {
	case m := <-s.Messages():
		t.Fatalf("unexpected message %+v", m)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestStreamDeliversToAuthorizedSubscribersOfTheRepo(t *testing.T) {
	e := newEnv(t)
	alice, err := e.svc.Subscribe(ctx, e.alice, repo, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer alice.Close()
	bob, err := e.svc.Subscribe(ctx, e.bob, repo, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer bob.Close()
	bobOther, err := e.svc.Subscribe(ctx, e.bob, otherRepo, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer bobOther.Close()

	e.post(t, e.alice, repo, "hello")
	if m := recv(t, alice); m.Body != "hello" || !m.Mine || m.Seq != 1 {
		t.Errorf("alice got %+v", m)
	}
	if m := recv(t, bob); m.Body != "hello" || m.Mine || m.AuthorLogin != "alice" {
		t.Errorf("bob got %+v", m)
	}
	silent(t, bobOther)
}

func TestStreamReplaysAfterLastEventID(t *testing.T) {
	e := newEnv(t, func(c *chat.Config) { c.ReplayLimit = 2 })
	for i := 1; i <= 3; i++ {
		e.post(t, e.alice, repo, fmt.Sprint("m", i))
	}
	s, err := e.svc.Subscribe(ctx, e.bob, repo, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if got := seqs(s.Backlog()); got != "2,3" || s.Resync() {
		t.Errorf("backlog = %s resync=%v", got, s.Resync())
	}
	if again := s.Backlog(); again != nil {
		t.Errorf("backlog kept after it was handed over: %d messages", len(again))
	}
	s2, _ := e.svc.Subscribe(ctx, e.bob, repo, 0)
	defer s2.Close()
	if len(s2.Backlog()) != 0 {
		t.Error("no Last-Event-ID still replays")
	}
	e.post(t, e.alice, repo, "m4")
	s3, _ := e.svc.Subscribe(ctx, e.bob, repo, 1)
	defer s3.Close()
	if got := seqs(s3.Backlog()); got != "2,3" || !s3.Resync() {
		t.Errorf("truncated backlog = %s resync=%v", got, s3.Resync())
	}
}

func TestStreamConnectionCap(t *testing.T) {
	e := newEnv(t, func(c *chat.Config) { c.MaxStreamsPerUser = 2; c.MaxStreams = 3 })
	s1, _ := e.svc.Subscribe(ctx, e.alice, repo, 0)
	s2, _ := e.svc.Subscribe(ctx, e.alice, otherRepo, 0)
	if _, err := e.svc.Subscribe(ctx, e.alice, repo, 0); !errors.Is(err, chat.ErrTooManyStreams) || !errors.Is(err, comments.ErrRateLimited) {
		t.Fatalf("third stream = %v", err)
	}
	b1, err := e.svc.Subscribe(ctx, e.bob, repo, 0)
	if err != nil {
		t.Fatalf("bob's first stream: %v", err)
	}
	if _, err := e.svc.Subscribe(ctx, e.bob, repo, 0); !errors.Is(err, chat.ErrTooManyStreams) {
		t.Errorf("global cap = %v", err)
	}
	s1.Close()
	s1.Close() // idempotent
	s3, err := e.svc.Subscribe(ctx, e.alice, repo, 0)
	if err != nil {
		t.Errorf("after close: %v", err)
	}
	for _, s := range []*chat.Subscription{s2, b1, s3} {
		s.Close()
	}
}

func TestCloseUserDropsTheirStreams(t *testing.T) {
	e := newEnv(t)
	a, _ := e.svc.Subscribe(ctx, e.alice, repo, 0)
	b, _ := e.svc.Subscribe(ctx, e.bob, repo, 0)
	defer b.Close()
	e.svc.CloseUser(e.alice.UserID)
	select {
	case <-a.Done():
	case <-time.After(time.Second):
		t.Fatal("alice's stream is still open")
	}
	e.post(t, e.bob, repo, "after")
	recv(t, b)
	select {
	case m := <-a.Messages():
		t.Errorf("closed stream received %+v", m)
	default:
	}
}

func TestCheckFollowsAccess(t *testing.T) {
	e := newEnv(t)
	if err := e.svc.Check(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	e.access.revoke(e.bob.UserID)
	if err := e.svc.Check(ctx, e.bob, repo); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("revoked check = %v", err)
	}
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	e := newEnv(t, func(c *chat.Config) { c.StreamBuffer = 1; c.Limiter = comments.NewRateLimiter(100, time.Second, nil) })
	s, _ := e.svc.Subscribe(ctx, e.bob, repo, 0)
	defer s.Close()
	e.post(t, e.alice, repo, "1")
	e.post(t, e.alice, repo, "2") // buffer full: dropped, the client reconnects with Last-Event-ID
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("slow subscriber kept")
	}
}

func TestShutdownClosesStreams(t *testing.T) {
	e := newEnv(t)
	s, _ := e.svc.Subscribe(ctx, e.bob, repo, 0)
	e.svc.Shutdown()
	select {
	case <-s.Done():
	case <-time.After(time.Second):
		t.Fatal("stream open after shutdown")
	}
	if _, err := e.svc.Subscribe(ctx, e.bob, repo, 0); !errors.Is(err, comments.ErrUnavailable) {
		t.Errorf("subscribe after shutdown = %v", err)
	}
}

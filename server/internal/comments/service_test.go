package comments_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/secret"
)

var ctx = context.Background()

const (
	repo      int64 = 7
	otherRepo int64 = 8 // the actors have the same access to it
)

// fakeAccess answers permissions from a table keyed by user id.
type fakeAccess struct {
	mu    sync.Mutex
	perms map[string]comments.RepoPermission // user id -> permission on repo
	err   error
	calls int
}

func (f *fakeAccess) Permission(_ context.Context, userID string, repoID int64) (comments.RepoPermission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return comments.RepoPermission{}, f.err
	}
	p, ok := f.perms[userID]
	if !ok || (repoID != repo && repoID != otherRepo) {
		return comments.RepoPermission{}, comments.ErrNotFound
	}
	return p, nil
}

type env struct {
	svc    *comments.Service
	app    core.App
	access *fakeAccess
	clock  *fakeClock
	alice  comments.Actor // push
	bob    comments.Actor // pull only
	eve    comments.Actor // no access
}

func newEnv(t *testing.T, opts ...func(*comments.Config)) *env {
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
	e := &env{app: app, clock: newClock(), alice: actor(1, "alice"), bob: actor(2, "bob"), eve: actor(3, "eve")}
	e.access = &fakeAccess{perms: map[string]comments.RepoPermission{
		e.alice.UserID: {FullName: "fullfran/paper", Pull: true, Push: true},
		e.bob.UserID:   {FullName: "fullfran/paper", Pull: true},
	}}
	sealer, err := secret.NewSealer(bytes.Repeat([]byte{9}, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	cfg := comments.Config{
		Store:  pbstore.NewCommentStore(app),
		Access: e.access,
		Sealer: sealer,
		Clock:  e.clock,
	}
	for _, o := range opts {
		o(&cfg)
	}
	e.svc, err = comments.NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) create(t *testing.T, a comments.Actor) comments.Thread {
	t.Helper()
	th, err := e.svc.CreateThread(ctx, a, repo, validThread())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return th
}

func TestCreateAndGetThread(t *testing.T) {
	e := newEnv(t)
	in := validThread()
	in.Suggestion = ptr("the sourced text")
	th, err := e.svc.CreateThread(ctx, e.bob, repo, in)
	if err != nil {
		t.Fatal(err)
	}
	if th.Status != comments.StatusOpen || th.RepoFullName != "fullfran/paper" || th.CreatedBy != "bob" {
		t.Errorf("thread = %+v", th)
	}
	if th.Anchor.Path != in.Path || th.Anchor.Quote != in.Quote || th.Anchor.Range != in.Range {
		t.Errorf("anchor = %+v", th.Anchor)
	}
	if th.Position.State != comments.AnchorExact || th.Position.CommitSHA != sha || th.Position.Range != in.Range {
		t.Errorf("position = %+v", th.Position)
	}

	got, err := e.svc.GetThread(ctx, e.alice, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Comments) != 1 {
		t.Fatalf("comments = %d", len(got.Comments))
	}
	c := got.Comments[0]
	if c.Body != in.Body || c.AuthorLogin != "bob" || c.AuthorKind != comments.AuthorHuman || c.Mine {
		t.Errorf("comment = %+v", c)
	}
	if c.Suggestion == nil || c.Suggestion.Text != "the sourced text" || c.Suggestion.BaseSHA != sha {
		t.Errorf("suggestion = %+v", c.Suggestion)
	}
	if got.Anchor.Quote != in.Quote {
		t.Errorf("quote did not round-trip: %+v", got.Anchor.Quote)
	}
}

func TestSealedAtRest(t *testing.T) {
	e := newEnv(t)
	in := validThread()
	in.Suggestion = ptr("SECRET-SUGGESTION")
	in.Body = "SECRET-BODY"
	in.Quote = comments.Quote{Exact: "SECRET-QUOTE", Prefix: "SECRET-PREFIX", Suffix: "SECRET-SUFFIX"}
	th, err := e.svc.CreateThread(ctx, e.alice, repo, in)
	if err != nil {
		t.Fatal(err)
	}

	var dump strings.Builder
	for _, col := range []string{pbstore.ThreadsCollection, pbstore.CommentsCollection} {
		recs, err := e.app.FindAllRecords(col)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range recs {
			for _, f := range r.Collection().Fields {
				dump.WriteString(r.GetString(f.GetName()))
				dump.WriteByte('|')
			}
		}
	}
	if strings.Contains(dump.String(), "SECRET") {
		t.Fatal("plaintext found in the database")
	}

	// A sealed value moved to another record (or field) no longer opens.
	other, err := e.svc.CreateThread(ctx, e.alice, repo, validThread())
	if err != nil {
		t.Fatal(err)
	}
	a, _ := e.app.FindFirstRecordByData(pbstore.CommentsCollection, "thread", th.ID)
	b, _ := e.app.FindFirstRecordByData(pbstore.CommentsCollection, "thread", other.ID)
	a.Set("body", b.GetString("body"))
	if err := e.app.Save(a); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.GetThread(ctx, e.alice, th.ID); err == nil {
		t.Fatal("swapped comment body opened")
	}
	if _, err := e.svc.GetThread(ctx, e.alice, other.ID); err != nil {
		t.Fatalf("untouched thread broken: %v", err)
	}

	ta, _ := e.app.FindRecordById(pbstore.ThreadsCollection, other.ID)
	ta.Set("quote_exact", ta.GetString("quote_prefix"))
	if err := e.app.Save(ta); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.GetThread(ctx, e.alice, other.ID); err == nil {
		t.Fatal("quote sealed for another field opened")
	}
}

func TestPermissions(t *testing.T) {
	e := newEnv(t)

	if _, err := e.svc.CreateThread(ctx, e.eve, repo, validThread()); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("create without access err = %v, want not found", err)
	}
	th := e.create(t, e.bob) // pull is enough to comment
	if _, err := e.svc.GetThread(ctx, e.eve, th.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("get without access err = %v, want not found", err)
	}
	if _, err := e.svc.Reply(ctx, e.eve, th.ID, comments.NewComment{Body: "hi"}); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("reply without access err = %v", err)
	}
	if _, err := e.svc.ListThreads(ctx, e.eve, repo, comments.ListFilter{}); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("list without access err = %v", err)
	}
	if _, err := e.svc.Reply(ctx, e.alice, th.ID, comments.NewComment{Body: "reply"}); err != nil {
		t.Errorf("reply with push: %v", err)
	}

	// Resolve and reopen need push, whoever wrote the thread.
	if _, err := e.svc.Resolve(ctx, e.bob, th.ID); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("resolve with pull only err = %v, want forbidden", err)
	}
	if _, err := e.svc.Resolve(ctx, e.eve, th.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("resolve without access err = %v, want not found", err)
	}
	res, err := e.svc.Resolve(ctx, e.alice, th.ID)
	if err != nil || res.Status != comments.StatusResolved || res.ResolvedBy != "alice" || res.ResolvedAt.IsZero() {
		t.Fatalf("resolve = %+v, %v", res, err)
	}
	if _, err := e.svc.Resolve(ctx, e.alice, th.ID); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("second resolve err = %v, want conflict", err)
	}
	if _, err := e.svc.Reopen(ctx, e.bob, th.ID); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("reopen with pull only err = %v", err)
	}
	re, err := e.svc.Reopen(ctx, e.alice, th.ID)
	if err != nil || re.Status != comments.StatusOpen || re.ResolvedBy != "" {
		t.Fatalf("reopen = %+v, %v", re, err)
	}
	if _, err := e.svc.Reopen(ctx, e.alice, th.ID); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("reopen of an open thread err = %v", err)
	}
}

func TestEditAndDeleteOwnCommentsOnly(t *testing.T) {
	e := newEnv(t)
	th := e.create(t, e.alice)
	mine := th.Comments[0]
	e.clock.Advance(time.Second)
	reply, err := e.svc.Reply(ctx, e.bob, th.ID, comments.NewComment{Body: "bob's reply"})
	if err != nil {
		t.Fatal(err)
	}
	if !reply.Mine || reply.AuthorLogin != "bob" {
		t.Errorf("reply = %+v", reply)
	}

	if _, err := e.svc.EditComment(ctx, e.bob, mine.ID, comments.NewComment{Body: "hijack"}); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("edit someone else's err = %v, want forbidden", err)
	}
	if err := e.svc.DeleteComment(ctx, e.alice, reply.ID); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("delete someone else's (even with push) err = %v, want forbidden", err)
	}
	if _, err := e.svc.EditComment(ctx, e.eve, mine.ID, comments.NewComment{Body: "x"}); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("edit without access err = %v, want not found", err)
	}

	e.clock.Advance(time.Minute)
	edited, err := e.svc.EditComment(ctx, e.alice, mine.ID, comments.NewComment{Body: "edited", Suggestion: ptr("new text")})
	if err != nil {
		t.Fatal(err)
	}
	if edited.Body != "edited" || edited.EditedAt.IsZero() || edited.Suggestion == nil || edited.Suggestion.Text != "new text" {
		t.Errorf("edited = %+v", edited)
	}
	got, _ := e.svc.GetThread(ctx, e.bob, th.ID)
	if got.Comments[0].Body != "edited" {
		t.Errorf("stored body = %q", got.Comments[0].Body)
	}

	if err := e.svc.DeleteComment(ctx, e.bob, reply.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.svc.GetThread(ctx, e.alice, th.ID); len(got.Comments) != 1 {
		t.Errorf("comments after delete = %d", len(got.Comments))
	}
	if err := e.svc.DeleteComment(ctx, e.alice, mine.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.GetThread(ctx, e.alice, th.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("thread without comments still exists: %v", err)
	}
	if err := e.svc.DeleteComment(ctx, e.alice, mine.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("delete twice err = %v", err)
	}
}

func TestInvalidInputIsRejectedBeforeAccessChecks(t *testing.T) {
	e := newEnv(t)
	bad := validThread()
	bad.Path = "../secrets"
	var ve *comments.ValidationError
	if _, err := e.svc.CreateThread(ctx, e.alice, repo, bad); !errors.As(err, &ve) || ve.Field != "path" {
		t.Fatalf("err = %v", err)
	}
	if _, err := e.svc.CreateThread(ctx, e.alice, 0, validThread()); !errors.As(err, &ve) || ve.Field != "repo_id" {
		t.Fatalf("repo 0 err = %v", err)
	}
	if _, err := e.svc.GetThread(ctx, e.alice, "../x"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("malformed id err = %v", err)
	}
	if _, err := e.svc.ListThreads(ctx, e.alice, repo, comments.ListFilter{Status: "archived"}); !errors.As(err, &ve) || ve.Field != "status" {
		t.Errorf("bad status filter err = %v", err)
	}
	if e.access.calls != 0 {
		t.Errorf("access checked %d times for invalid input", e.access.calls)
	}
}

func TestAccessFailuresAreUnavailable(t *testing.T) {
	e := newEnv(t)
	e.access.err = errors.New("github down")
	if _, err := e.svc.ListThreads(ctx, e.alice, repo, comments.ListFilter{}); !errors.Is(err, comments.ErrUnavailable) {
		t.Errorf("err = %v, want unavailable", err)
	}
	e.access.err = comments.ErrUnauthenticated
	if _, err := e.svc.ListThreads(ctx, e.alice, repo, comments.ListFilter{}); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("err = %v, want unauthenticated", err)
	}
}

func TestWritesAreRateLimited(t *testing.T) {
	var clock *fakeClock
	e := newEnv(t, func(c *comments.Config) {
		clock = c.Clock.(*fakeClock)
		c.Limiter = comments.NewRateLimiter(2, time.Minute, clock)
	})
	th := e.create(t, e.alice)
	if _, err := e.svc.Reply(ctx, e.alice, th.ID, comments.NewComment{Body: "2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Reply(ctx, e.alice, th.ID, comments.NewComment{Body: "3"}); !errors.Is(err, comments.ErrRateLimited) {
		t.Fatalf("third write err = %v, want rate limited", err)
	}
	if _, err := e.svc.GetThread(ctx, e.alice, th.ID); err != nil {
		t.Errorf("reads must not be rate limited: %v", err)
	}
	if err := e.svc.MarkRead(ctx, e.alice, th.ID); err != nil {
		t.Errorf("read markers must not be rate limited: %v", err)
	}
	if _, err := e.svc.Reply(ctx, e.bob, th.ID, comments.NewComment{Body: "bob"}); err != nil {
		t.Errorf("limit is not per user: %v", err)
	}
	clock.Advance(time.Minute)
	if _, err := e.svc.Reply(ctx, e.alice, th.ID, comments.NewComment{Body: "4"}); err != nil {
		t.Errorf("after refill: %v", err)
	}
}

func TestListThreads(t *testing.T) {
	e := newEnv(t, func(c *comments.Config) { c.ListLimit = 2 })
	a := validThread()
	a.Path = "b.qmd"
	b := validThread()
	b.Path = "a.qmd"
	b.Range = comments.Range{StartLine: 9, EndLine: 9}
	c := validThread()
	c.Path = "a.qmd"
	c.Range = comments.Range{StartLine: 1, EndLine: 2}
	var ids []string
	for _, in := range []comments.NewThread{a, b, c} {
		th, err := e.svc.CreateThread(ctx, e.alice, repo, in)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, th.ID)
	}
	if _, err := e.svc.Resolve(ctx, e.alice, ids[1]); err != nil {
		t.Fatal(err)
	}

	all, err := e.svc.ListThreads(ctx, e.bob, repo, comments.ListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Threads) != 2 || !all.Truncated {
		t.Fatalf("list = %d threads, truncated %v", len(all.Threads), all.Truncated)
	}
	if all.Threads[0].ID != ids[2] || all.Threads[1].ID != ids[1] {
		t.Errorf("order = %s, %s; want by path then line", all.Threads[0].ID, all.Threads[1].ID)
	}
	if len(all.Threads[0].Comments) != 1 || all.Threads[0].Comments[0].Body == "" {
		t.Errorf("list does not carry comments: %+v", all.Threads[0].Comments)
	}

	open, err := e.svc.ListThreads(ctx, e.bob, repo, comments.ListFilter{Path: "a.qmd", Status: comments.StatusOpen})
	if err != nil {
		t.Fatal(err)
	}
	if len(open.Threads) != 1 || open.Threads[0].ID != ids[2] || open.Truncated {
		t.Errorf("filtered list = %+v", open)
	}
}

func TestUnreadCounts(t *testing.T) {
	e := newEnv(t)
	th := e.create(t, e.alice)

	u, err := e.svc.Unread(ctx, e.bob, repo)
	if err != nil {
		t.Fatal(err)
	}
	if u.Threads != 1 || u.Comments != 1 || u.ByThread[th.ID] != 1 {
		t.Errorf("bob unread = %+v", u)
	}
	if u, _ := e.svc.Unread(ctx, e.alice, repo); u.Comments != 0 {
		t.Errorf("own comments counted as unread: %+v", u)
	}

	e.clock.Advance(time.Second)
	if err := e.svc.MarkRead(ctx, e.bob, th.ID); err != nil {
		t.Fatal(err)
	}
	if u, _ := e.svc.Unread(ctx, e.bob, repo); u.Comments != 0 || u.Threads != 0 {
		t.Errorf("after mark read = %+v", u)
	}

	e.clock.Advance(time.Second)
	if _, err := e.svc.Reply(ctx, e.alice, th.ID, comments.NewComment{Body: "new"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Reply(ctx, e.bob, th.ID, comments.NewComment{Body: "mine"}); err != nil {
		t.Fatal(err)
	}
	if u, _ := e.svc.Unread(ctx, e.bob, repo); u.Comments != 1 || u.Threads != 1 {
		t.Errorf("after a new reply = %+v", u)
	}
	if err := e.svc.MarkRead(ctx, e.eve, th.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("mark read without access err = %v", err)
	}
	if _, err := e.svc.Unread(ctx, e.eve, repo); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("unread without access err = %v", err)
	}
}

// reanchorSpy records that the service routes positions through the seam.
type reanchorSpy struct {
	at, users []string
	budgeted  []bool
}

func (r *reanchorSpy) Position(ctx context.Context, userID string, t comments.ThreadRecord, q comments.Quote, at string) (comments.Position, error) {
	r.at = append(r.at, at)
	r.users = append(r.users, userID)
	_, ok := comments.WorkBudget(ctx)
	r.budgeted = append(r.budgeted, ok)
	p := t.Position
	if q.Exact != "" && at != "" {
		p.State = comments.AnchorMoved
		p.CommitSHA = at
	}
	return p, nil
}

func TestReanchorSeam(t *testing.T) {
	spy := &reanchorSpy{}
	e := newEnv(t, func(c *comments.Config) { c.Reanchorer = spy })
	th := e.create(t, e.alice)
	head := strings.Repeat("b", 40)
	list, err := e.svc.ListThreads(ctx, e.alice, repo, comments.ListFilter{At: head})
	if err != nil {
		t.Fatal(err)
	}
	if p := list.Threads[0].Position; p.State != comments.AnchorMoved || p.CommitSHA != head {
		t.Errorf("position = %+v", p)
	}
	if list.Threads[0].Anchor.CommitSHA != sha {
		t.Error("the original anchor must be returned as stored")
	}
	if p := list.Threads[0].Position; p.Path != list.Threads[0].Anchor.Path {
		t.Errorf("position path = %q", p.Path)
	}
	got, err := e.svc.GetThreadAt(ctx, e.alice, th.ID, head)
	if err != nil {
		t.Fatal(err)
	}
	// Listings share one work budget; a single thread has none.
	if len(spy.budgeted) != 3 || !spy.budgeted[1] || spy.budgeted[2] { // create, list, get
		t.Errorf("budgeted = %v", spy.budgeted)
	}
	if got.Position.CommitSHA != head || spy.users[len(spy.users)-1] != e.alice.UserID {
		t.Errorf("get at = %+v, users %v", got.Position, spy.users)
	}
	var ve *comments.ValidationError
	if _, err := e.svc.GetThreadAt(ctx, e.alice, th.ID, "HEAD"); !errors.As(err, &ve) || ve.Field != "at" {
		t.Errorf("bad get at err = %v", err)
	}
	if _, err := e.svc.ListThreads(ctx, e.alice, repo, comments.ListFilter{At: "main"}); !errors.As(err, &ve) || ve.Field != "at" {
		t.Errorf("bad at err = %v", err)
	}
}

func TestSealedValuesAreBoundToTheirPlace(t *testing.T) {
	e := newEnv(t)
	in := validThread()
	in.Body = "PLAINTEXT-BODY"
	in.Quote.Exact = "PLAINTEXT-QUOTE"
	moves := []struct {
		name  string
		apply func(t *testing.T, th, other comments.Thread)
	}{
		{"thread moved to another repository", func(t *testing.T, th, _ comments.Thread) {
			rec, _ := e.app.FindRecordById(pbstore.ThreadsCollection, th.ID)
			rec.Set("repo_id", otherRepo)
			mustSave(t, e.app, rec)
		}},
		{"thread moved to another path", func(t *testing.T, th, _ comments.Thread) {
			rec, _ := e.app.FindRecordById(pbstore.ThreadsCollection, th.ID)
			rec.Set("path", "other.qmd")
			mustSave(t, e.app, rec)
		}},
		{"comment moved to another thread", func(t *testing.T, th, other comments.Thread) {
			rec, _ := e.app.FindRecordById(pbstore.CommentsCollection, th.Comments[0].ID)
			rec.Set("thread", other.ID)
			mustSave(t, e.app, rec)
		}},
	}
	for _, m := range moves {
		t.Run(m.name, func(t *testing.T) {
			th, err := e.svc.CreateThread(ctx, e.alice, repo, in)
			if err != nil {
				t.Fatal(err)
			}
			other := e.create(t, e.alice)
			m.apply(t, th, other)
			target := th.ID
			if m.name == "comment moved to another thread" {
				target = other.ID
			}
			_, err = e.svc.GetThread(ctx, e.alice, target)
			if err == nil {
				t.Fatal("moved value still opens")
			}
			if strings.Contains(err.Error(), "PLAINTEXT") {
				t.Errorf("error carries plaintext: %v", err)
			}
			if errors.Is(err, comments.ErrNotFound) || errors.Is(err, comments.ErrForbidden) {
				t.Errorf("err = %v, want a generic server error", err)
			}
		})
	}
}

func mustSave(t *testing.T, app core.App, rec *core.Record) {
	t.Helper()
	if err := app.Save(rec); err != nil {
		t.Fatal(err)
	}
}

func TestUnreadIsExactWithinOneMillisecond(t *testing.T) {
	e := newEnv(t)
	th := e.create(t, e.alice)
	if err := e.svc.MarkRead(ctx, e.bob, th.ID); err != nil {
		t.Fatal(err)
	}
	// Same clock instant as the read marker: still unread.
	if _, err := e.svc.Reply(ctx, e.alice, th.ID, comments.NewComment{Body: "same ms"}); err != nil {
		t.Fatal(err)
	}
	if u, _ := e.svc.Unread(ctx, e.bob, repo); u.Comments != 1 {
		t.Errorf("unread = %+v, want the reply written in the same millisecond", u)
	}
}

func TestAccessRateLimitIsReported(t *testing.T) {
	e := newEnv(t)
	e.access.err = comments.ErrRateLimited
	if _, err := e.svc.ListThreads(ctx, e.alice, repo, comments.ListFilter{}); !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("err = %v, want rate limited", err)
	}
}

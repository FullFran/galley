package pbstore_test

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/pbstore"
)

var commentCollections = []string{pbstore.ThreadsCollection, pbstore.CommentsCollection, pbstore.ThreadReadsCollection}

func TestCommentCollectionsAreSuperuserOnly(t *testing.T) {
	_, app := newStore(t)
	for _, name := range commentCollections {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.ListRule != nil || c.ViewRule != nil || c.CreateRule != nil || c.UpdateRule != nil || c.DeleteRule != nil {
			t.Errorf("%s has a non-nil API rule", name)
		}
	}
	sealed := map[string][]string{
		pbstore.ThreadsCollection:  {"quote_exact", "quote_prefix", "quote_suffix"},
		pbstore.CommentsCollection: {"body", "suggestion"},
	}
	for name, fields := range sealed {
		c, _ := app.FindCollectionByNameOrId(name)
		for _, f := range fields {
			if field := c.Fields.GetByName(f); field == nil || !field.GetHidden() {
				t.Errorf("%s.%s is not a hidden field", name, f)
			}
		}
	}
}

func TestCommentCollectionsDenyAnonymousRecordAPI(t *testing.T) {
	for _, name := range commentCollections {
		for _, sc := range []tests.ApiScenario{
			{Name: name + " list", Method: http.MethodGet, URL: "/api/collections/" + name + "/records"},
			{Name: name + " create", Method: http.MethodPost, URL: "/api/collections/" + name + "/records", Body: jsonBody(`{"path":"a"}`)},
		} {
			sc.ExpectedStatus = http.StatusForbidden
			sc.ExpectedContent = []string{`"data":{}`}
			sc.TestAppFactory = func(t testing.TB) *tests.TestApp {
				app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
				if err != nil {
					t.Fatal(err)
				}
				return app
			}
			sc.Test(t)
		}
	}
}

type fixture struct {
	store *pbstore.CommentStore
	app   core.App
	alice auth.User
	bob   auth.User
	now   time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	users, app := newStore(t)
	alice, _ := users.UpsertUser(ctx, auth.GitHubUser{ID: 1, Login: "alice"})
	bob, _ := users.UpsertUser(ctx, auth.GitHubUser{ID: 2, Login: "bob"})
	return &fixture{
		store: pbstore.NewCommentStore(app), app: app, alice: alice, bob: bob,
		now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC),
	}
}

const sha = "0123456789abcdef0123456789abcdef01234567"

func (f *fixture) thread(id, path string, line int) comments.ThreadRecord {
	r := comments.Range{StartLine: line, EndLine: line + 1, StartColumn: 2, EndColumn: 5}
	return comments.ThreadRecord{
		ID: id, RepoID: 7, RepoFullName: "o/r", Path: path, CommitSHA: sha, Range: r,
		QuoteExact: "sealed-q", QuotePrefix: "sealed-p",
		Position: comments.Position{CommitSHA: sha, Range: r, State: comments.AnchorExact},
		Origin:   comments.OriginPreview, Status: comments.StatusOpen,
		CreatedBy: f.alice.ID, CreatedByLogin: "alice", CreatedAt: f.now, UpdatedAt: f.now,
	}
}

func (f *fixture) comment(id, thread string, by auth.User, at time.Time) comments.CommentRecord {
	return comments.CommentRecord{
		ID: id, ThreadID: thread, AuthorKind: comments.AuthorHuman, AuthorUser: by.ID, AuthorLogin: by.Login,
		Body: "sealed-body-" + id, CreatedAt: at,
	}
}

func TestCommentStoreRoundTrip(t *testing.T) {
	f := newFixture(t)
	th := f.thread("thread000000001", "a.qmd", 3)
	first := f.comment("comment00000001", th.ID, f.alice, f.now)
	first.Suggestion, first.SuggestionBaseSHA = "sealed-s", sha
	if err := f.store.CreateThread(ctx, th, first); err != nil {
		t.Fatal(err)
	}
	got, err := f.store.Thread(ctx, th.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got != th {
		t.Errorf("thread\n got %+v\nwant %+v", got, th)
	}
	c, err := f.store.Comment(ctx, first.ID)
	if err != nil || c != first {
		t.Errorf("comment = %+v, %v; want %+v", c, err, first)
	}
	if _, err := f.store.Thread(ctx, "missing00000000"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("missing thread err = %v", err)
	}
	if _, err := f.store.Comment(ctx, "missing00000000"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("missing comment err = %v", err)
	}

	// The first comment is saved with its thread or not at all.
	bad := f.thread("thread000000002", "a.qmd", 1)
	if err := f.store.CreateThread(ctx, bad, f.comment("comment00000001", bad.ID, f.alice, f.now)); err == nil {
		t.Fatal("duplicate comment id accepted")
	}
	if _, err := f.store.Thread(ctx, bad.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Error("thread saved without its first comment")
	}
}

func TestCommentStoreListAndComments(t *testing.T) {
	f := newFixture(t)
	for i, spec := range []struct {
		id, path string
		line     int
	}{{"thread00000000b", "b.qmd", 1}, {"thread00000000a", "a.qmd", 9}, {"thread00000000c", "a.qmd", 2}} {
		th := f.thread(spec.id, spec.path, spec.line)
		if err := f.store.CreateThread(ctx, th, f.comment("comment0000000"+string(rune('a'+i)), th.ID, f.alice, f.now)); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.store.SetThreadStatus(ctx, "thread00000000a", comments.StatusOpen, comments.StatusResolved,
		comments.Actor{UserID: f.bob.ID, Login: "bob"}, f.now); err != nil {
		t.Fatal(err)
	}

	all, err := f.store.Threads(ctx, 7, comments.ListFilter{}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 3 || all[0].ID != "thread00000000c" || all[1].ID != "thread00000000a" || all[2].ID != "thread00000000b" {
		t.Errorf("order = %v", ids(all))
	}
	if got, _ := f.store.Threads(ctx, 7, comments.ListFilter{}, 2); len(got) != 2 {
		t.Errorf("limit ignored: %d", len(got))
	}
	open, _ := f.store.Threads(ctx, 7, comments.ListFilter{Path: "a.qmd", Status: comments.StatusOpen}, 10)
	if len(open) != 1 || open[0].ID != "thread00000000c" {
		t.Errorf("filtered = %v", ids(open))
	}
	if other, _ := f.store.Threads(ctx, 8, comments.ListFilter{}, 10); len(other) != 0 {
		t.Errorf("other repo = %v", ids(other))
	}

	// A path filter is a value, never filter syntax.
	if inj, err := f.store.Threads(ctx, 7, comments.ListFilter{Path: `a.qmd" || path != "`}, 10); err != nil || len(inj) != 0 {
		t.Errorf("filter injection = %v, %v", ids(inj), err)
	}

	resolved, _ := f.store.Thread(ctx, "thread00000000a")
	if resolved.ResolvedBy != f.bob.ID || resolved.ResolvedByLogin != "bob" || !resolved.ResolvedAt.Equal(f.now) {
		t.Errorf("resolved = %+v", resolved)
	}

	later := f.now.Add(time.Minute)
	if err := f.store.AddComment(ctx, f.comment("reply0000000001", "thread00000000c", f.bob, later)); err != nil {
		t.Fatal(err)
	}
	cs, err := f.store.Comments(ctx, []string{"thread00000000c", "thread00000000b"})
	if err != nil {
		t.Fatal(err)
	}
	if len(cs) != 3 || cs[len(cs)-1].ID != "reply0000000001" {
		t.Errorf("comments = %+v", cs)
	}
	if th, _ := f.store.Thread(ctx, "thread00000000c"); !th.UpdatedAt.Equal(later) {
		t.Errorf("reply did not bump the thread: %v", th.UpdatedAt)
	}
}

func jsonBody(s string) *strings.Reader { return strings.NewReader(s) }

func ids(ts []comments.ThreadRecord) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.ID
	}
	return out
}

func TestCommentStoreStatusIsCompareAndSet(t *testing.T) {
	f := newFixture(t)
	th := f.thread("thread000000001", "a.qmd", 1)
	_ = f.store.CreateThread(ctx, th, f.comment("comment00000001", th.ID, f.alice, f.now))
	by := comments.Actor{UserID: f.alice.ID, Login: "alice"}
	if err := f.store.SetThreadStatus(ctx, th.ID, comments.StatusResolved, comments.StatusOpen, by, f.now); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("reopen of open thread err = %v", err)
	}
	if err := f.store.SetThreadStatus(ctx, th.ID, comments.StatusOpen, comments.StatusResolved, by, f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.store.SetThreadStatus(ctx, th.ID, comments.StatusResolved, comments.StatusOpen, by, f.now); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.store.Thread(ctx, th.ID); got.ResolvedBy != "" || !got.ResolvedAt.IsZero() {
		t.Errorf("reopen kept the resolver: %+v", got)
	}
	if err := f.store.SetThreadStatus(ctx, "missing00000000", comments.StatusOpen, comments.StatusResolved, by, f.now); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("missing err = %v", err)
	}
}

func TestCommentStoreDeleteAndCascade(t *testing.T) {
	f := newFixture(t)
	th := f.thread("thread000000001", "a.qmd", 1)
	_ = f.store.CreateThread(ctx, th, f.comment("comment00000001", th.ID, f.alice, f.now))
	_ = f.store.AddComment(ctx, f.comment("comment00000002", th.ID, f.bob, f.now))
	if err := f.store.MarkRead(ctx, f.bob.ID, th.ID, f.now); err != nil {
		t.Fatal(err)
	}

	deleted, err := f.store.DeleteComment(ctx, "comment00000002", f.now)
	if err != nil || deleted {
		t.Fatalf("delete reply = %v, %v", deleted, err)
	}
	deleted, err = f.store.DeleteComment(ctx, "comment00000001", f.now)
	if err != nil || !deleted {
		t.Fatalf("delete last = %v, %v", deleted, err)
	}
	if _, err := f.store.Thread(ctx, th.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Error("thread survived its last comment")
	}
	if n, _ := f.app.CountRecords(pbstore.ThreadReadsCollection); n != 0 {
		t.Errorf("read markers not cascaded: %d", n)
	}
	if _, err := f.store.DeleteComment(ctx, "comment00000001", f.now); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("delete missing err = %v", err)
	}

	// Deleting a thread record cascades to its comments.
	th2 := f.thread("thread000000002", "a.qmd", 1)
	_ = f.store.CreateThread(ctx, th2, f.comment("comment00000003", th2.ID, f.alice, f.now))
	rec, _ := f.app.FindRecordById(pbstore.ThreadsCollection, th2.ID)
	if err := f.app.Delete(rec); err != nil {
		t.Fatal(err)
	}
	if n, _ := f.app.CountRecords(pbstore.CommentsCollection); n != 0 {
		t.Errorf("comments not cascaded: %d", n)
	}
}

func TestCommentStoreUnreadCounts(t *testing.T) {
	f := newFixture(t)
	t1 := f.thread("thread000000001", "a.qmd", 1)
	t2 := f.thread("thread000000002", "a.qmd", 5)
	_ = f.store.CreateThread(ctx, t1, f.comment("comment00000001", t1.ID, f.alice, f.now))
	_ = f.store.CreateThread(ctx, t2, f.comment("comment00000002", t2.ID, f.alice, f.now))
	_ = f.store.AddComment(ctx, f.comment("comment00000003", t1.ID, f.bob, f.now))

	got, err := f.store.UnreadCounts(ctx, f.bob.ID, 7)
	if err != nil {
		t.Fatal(err)
	}
	if got[t1.ID] != 1 || got[t2.ID] != 1 || len(got) != 2 {
		t.Errorf("bob unread = %v", got)
	}

	if err := f.store.MarkRead(ctx, f.bob.ID, t1.ID, f.now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := f.store.MarkRead(ctx, f.bob.ID, t1.ID, f.now.Add(2*time.Second)); err != nil {
		t.Fatal("second mark read (upsert) failed:", err)
	}
	_ = f.store.AddComment(ctx, f.comment("comment00000004", t1.ID, f.alice, f.now.Add(3*time.Second)))
	got, _ = f.store.UnreadCounts(ctx, f.bob.ID, 7)
	if got[t1.ID] != 1 || got[t2.ID] != 1 {
		t.Errorf("after read + new reply = %v", got)
	}
	if n, _ := f.app.CountRecords(pbstore.ThreadReadsCollection); n != 1 {
		t.Errorf("read markers = %d, want one per user and thread", n)
	}
	if got, _ := f.store.UnreadCounts(ctx, f.alice.ID, 7); got[t1.ID] != 1 || got[t2.ID] != 0 {
		t.Errorf("alice unread = %v", got)
	}
}

func TestCommentStoreUnreadUsesSequenceNotTime(t *testing.T) {
	f := newFixture(t)
	th := f.thread("thread000000001", "a.qmd", 1)
	_ = f.store.CreateThread(ctx, th, f.comment("comment00000001", th.ID, f.alice, f.now))
	if err := f.store.MarkRead(ctx, f.bob.ID, th.ID, f.now); err != nil {
		t.Fatal(err)
	}
	// Written at the very same instant as the marker, and even "earlier".
	_ = f.store.AddComment(ctx, f.comment("comment00000002", th.ID, f.alice, f.now))
	_ = f.store.AddComment(ctx, f.comment("comment00000003", th.ID, f.alice, f.now.Add(-time.Hour)))
	if got, _ := f.store.UnreadCounts(ctx, f.bob.ID, 7); got[th.ID] != 2 {
		t.Errorf("unread = %v, want 2", got)
	}
	if err := f.store.MarkRead(ctx, f.bob.ID, th.ID, f.now); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.store.UnreadCounts(ctx, f.bob.ID, 7); got[th.ID] != 0 {
		t.Errorf("after reading = %v", got)
	}
}

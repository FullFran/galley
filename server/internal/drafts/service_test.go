package drafts_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/secret"
)

var ctx = context.Background()

const (
	repo      int64 = 7
	otherRepo int64 = 8
)

var sha = strings.Repeat("a", 40)

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

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type env struct {
	svc    *drafts.Service
	app    core.App
	access *fakeAccess
	clock  *fakeClock
	alice  comments.Actor
	bob    comments.Actor
	eve    comments.Actor // no access
}

func newEnv(t *testing.T, opts ...func(*drafts.Config)) *env {
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
	e := &env{app: app, clock: &fakeClock{now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)},
		alice: actor(1, "alice"), bob: actor(2, "bob"), eve: actor(3, "eve")}
	e.access = &fakeAccess{perms: map[string]comments.RepoPermission{
		e.alice.UserID: {FullName: "o/paper", Pull: true, Push: true},
		e.bob.UserID:   {FullName: "o/paper", Pull: true},
		e.eve.UserID:   {FullName: "o/paper"}, // listed but without pull
	}}
	sealer, err := secret.NewSealer(bytes.Repeat([]byte{9}, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	cfg := drafts.Config{Store: pbstore.NewDraftStore(app), Access: e.access, Sealer: sealer, Clock: e.clock}
	for _, o := range opts {
		o(&cfg)
	}
	if e.svc, err = drafts.NewService(cfg); err != nil {
		t.Fatal(err)
	}
	return e
}

func put(path, content string) drafts.PutInput {
	return drafts.PutInput{Path: path, BaseSHA: sha, BaseRef: "main", Device: "laptop", Content: content}
}

func (e *env) put(t *testing.T, a comments.Actor, in drafts.PutInput) drafts.Draft {
	t.Helper()
	d, err := e.svc.Put(ctx, a, repo, in)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	return d
}

func TestPutGetListDelete(t *testing.T) {
	e := newEnv(t)
	d := e.put(t, e.alice, put("sections/intro.qmd", "Hello, draft"))
	if d.Path != "sections/intro.qmd" || d.BaseSHA != sha || d.BaseRef != "main" || d.Device != "laptop" ||
		d.Size != len("Hello, draft") || !d.UpdatedAt.Equal(e.clock.Now()) || d.Content != "Hello, draft" {
		t.Fatalf("put = %+v", d)
	}
	got, err := e.svc.Get(ctx, e.alice, repo, "sections/intro.qmd")
	if err != nil || got.Content != "Hello, draft" || got.ETag() != d.ETag() {
		t.Fatalf("get = %+v, %v", got, err)
	}
	e.clock.Advance(time.Second)
	e.put(t, e.alice, put("b.qmd", "two"))
	list, err := e.svc.List(ctx, e.alice, repo)
	if err != nil || len(list) != 2 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if list[0].Path != "b.qmd" || list[1].Path != "sections/intro.qmd" {
		t.Errorf("list order = %s, %s; want newest first", list[0].Path, list[1].Path)
	}
	for _, m := range list {
		if m.Content != "" {
			t.Errorf("listing carries content for %s", m.Path)
		}
	}
	if err := e.svc.Delete(ctx, e.alice, repo, "b.qmd"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Get(ctx, e.alice, repo, "b.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("deleted draft: %v", err)
	}
	if err := e.svc.Delete(ctx, e.alice, repo, "b.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
}

func TestDraftsAreOwnerOnly(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("a.qmd", "alice's words"))

	// Bob can pull the repository, Alice has push: neither matters.
	if _, err := e.svc.Get(ctx, e.bob, repo, "a.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("bob get = %v, want not found", err)
	}
	if list, err := e.svc.List(ctx, e.bob, repo); err != nil || len(list) != 0 {
		t.Errorf("bob list = %v, %v", list, err)
	}
	if err := e.svc.Delete(ctx, e.bob, repo, "a.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("bob delete = %v", err)
	}
	if n, err := e.svc.DeleteAll(ctx, e.bob, repo); err != nil || n != 0 {
		t.Errorf("bob delete all = %d, %v", n, err)
	}
	// Bob's own draft at the same path is independent.
	e.put(t, e.bob, put("a.qmd", "bob's words"))
	if got, _ := e.svc.Get(ctx, e.alice, repo, "a.qmd"); got.Content != "alice's words" {
		t.Errorf("alice sees %q", got.Content)
	}
	// Drafts are per repository too.
	if _, err := e.svc.Get(ctx, e.alice, otherRepo, "a.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("other repo = %v", err)
	}
}

func TestDraftsNeedPullOnAnInstalledRepo(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("a.qmd", "x"))
	if _, err := e.svc.Put(ctx, e.eve, repo, put("a.qmd", "x")); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("no pull put = %v", err)
	}
	if _, err := e.svc.List(ctx, e.alice, 99); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("not installed = %v", err)
	}
	e.access.err = errors.New("github down")
	if _, err := e.svc.Get(ctx, e.alice, repo, "a.qmd"); !errors.Is(err, comments.ErrUnavailable) {
		t.Errorf("access failure = %v", err)
	}
	if _, err := e.svc.List(ctx, comments.Actor{}, repo); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("anonymous = %v", err)
	}
}

func TestOptimisticConcurrency(t *testing.T) {
	e := newEnv(t)
	first := e.put(t, e.alice, put("a.qmd", "v1"))

	// No precondition only creates.
	if _, err := e.svc.Put(ctx, e.alice, repo, put("a.qmd", "blind")); !errors.Is(err, comments.ErrConflict) {
		t.Fatalf("blind overwrite = %v", err)
	}

	// Both devices loaded v1. The laptop saves v2 first.
	in := put("a.qmd", "v2")
	in.Expected = first.UpdatedAt
	second, err := e.svc.Put(ctx, e.alice, repo, in)
	if err != nil {
		t.Fatal(err)
	}
	if !second.UpdatedAt.After(first.UpdatedAt) {
		t.Errorf("updated_at did not advance within the same instant: %v -> %v", first.UpdatedAt, second.UpdatedAt)
	}

	// The stale phone still holds v1's version.
	stale := put("a.qmd", "stale")
	stale.Expected = first.UpdatedAt
	_, err = e.svc.Put(ctx, e.alice, repo, stale)
	var ce *drafts.ConflictError
	if !errors.Is(err, comments.ErrConflict) || !errors.As(err, &ce) || ce.Current == nil || ce.Current.ETag() != second.ETag() {
		t.Fatalf("stale put = %v (%+v)", err, ce)
	}
	if ce.Current.Content != "" {
		t.Error("conflict carries content")
	}
	if got, _ := e.svc.Get(ctx, e.alice, repo, "a.qmd"); got.Content != "v2" {
		t.Errorf("content = %q, want v2", got.Content)
	}

	// A precondition on a draft that is gone (purged after save) conflicts.
	_ = e.svc.Delete(ctx, e.alice, repo, "a.qmd")
	_, err = e.svc.Put(ctx, e.alice, repo, in)
	if !errors.As(err, &ce) || ce.Current != nil {
		t.Errorf("put on a deleted draft = %v", err)
	}
}

func TestETagRoundTrip(t *testing.T) {
	e := newEnv(t)
	d := e.put(t, e.alice, put("a.qmd", "v1"))
	v, err := drafts.ParseETag(d.ETag())
	if err != nil || !v.At.Equal(d.UpdatedAt) || v.Nonce == "" || v.Nonce != d.Version {
		t.Errorf("ParseETag(%s) = %+v, %v", d.ETag(), v, err)
	}
	for _, bad := range []string{"", "*", "123", `"abc"`, `W/"1-abcdefgh"`, `"-1-abcdefgh"`, `"1"`, `"1-"`, `"1-ABC!"`} {
		if _, err := drafts.ParseETag(bad); err == nil {
			t.Errorf("ParseETag(%q) accepted", bad)
		}
	}
}

func TestRecreatedDraftGetsANewETag(t *testing.T) {
	e := newEnv(t)
	old := e.put(t, e.alice, put("a.qmd", "v1"))
	_ = e.svc.Delete(ctx, e.alice, repo, "a.qmd")
	// Same clock instant: only the nonce tells the versions apart.
	fresh := e.put(t, e.alice, put("a.qmd", "v2"))
	if fresh.ETag() == old.ETag() {
		t.Fatalf("recreated draft reuses the etag %s", old.ETag())
	}
	in := put("a.qmd", "stale")
	v, _ := drafts.ParseETag(old.ETag())
	in.Expected, in.ExpectedVersion = v.At, v.Nonce
	if _, err := e.svc.Put(ctx, e.alice, repo, in); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("old etag on a recreated draft = %v", err)
	}
	v, _ = drafts.ParseETag(fresh.ETag())
	in.Expected, in.ExpectedVersion = v.At, v.Nonce
	if _, err := e.svc.Put(ctx, e.alice, repo, in); err != nil {
		t.Errorf("current etag = %v", err)
	}
}

func TestOwnerTotals(t *testing.T) {
	e := newEnv(t, func(c *drafts.Config) { c.MaxOwnerDrafts = 3; c.MaxOwnerBytes = 10 })
	var ve *comments.ValidationError
	e.put(t, e.alice, put("a.qmd", "1234"))
	if _, err := e.svc.Put(ctx, e.alice, otherRepo, put("b.qmd", "12345")); err != nil {
		t.Fatal(err)
	}
	// 4 + 5 + 2 > 10, across repositories.
	if _, err := e.svc.Put(ctx, e.alice, repo, put("c.qmd", "12")); !errors.As(err, &ve) || ve.Field != "owner_storage" {
		t.Errorf("storage cap = %v", err)
	}
	// Replacing counts the new size instead of the old one.
	d, _ := e.svc.Get(ctx, e.alice, repo, "a.qmd")
	in := put("a.qmd", "12345")
	in.Expected = d.UpdatedAt
	if _, err := e.svc.Put(ctx, e.alice, repo, in); err != nil {
		t.Errorf("replace within cap: %v", err)
	}
	e.put(t, e.alice, put("c.qmd", ""))
	if _, err := e.svc.Put(ctx, e.alice, otherRepo, put("d.qmd", "")); !errors.As(err, &ve) || ve.Field != "owner_drafts" {
		t.Errorf("count cap = %v", err)
	}
	if _, err := e.svc.Put(ctx, e.bob, repo, put("a.qmd", "1234567890")); err != nil {
		t.Errorf("bob has his own budget: %v", err)
	}
}

func TestRevokeBlocksWritesAndPurgesTwice(t *testing.T) {
	e := newEnv(t, func(c *drafts.Config) { c.SecondPurgeDelay = 50 * time.Millisecond })
	e.put(t, e.alice, put("a.qmd", "a"))
	e.put(t, e.bob, put("a.qmd", "b"))

	e.svc.Revoke(e.alice.UserID) // does not block
	if _, err := e.svc.Put(ctx, e.alice, repo, put("late.qmd", "x")); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("put after revocation = %v", err)
	}
	waitFor(t, func() bool {
		n, _ := e.app.CountRecords(pbstore.DraftsCollection, dbx.HashExp{"owner": e.alice.UserID})
		return n == 0
	})

	// A write that slipped past the first purge (the in-flight race) is
	// removed by the second one.
	store := pbstore.NewDraftStore(e.app)
	err := store.Put(ctx, drafts.Record{ID: "slipped00000001", Owner: e.alice.UserID, RepoID: repo, Path: "s.qmd",
		BaseSHA: sha, Content: "sealed", Version: "abcdefgh", UpdatedAt: e.clock.Now()}, drafts.Precondition{}, drafts.Limits{MaxDrafts: 10, MaxOwnerDrafts: 10, MaxOwnerBytes: 100}, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		n, _ := e.app.CountRecords(pbstore.DraftsCollection, dbx.HashExp{"owner": e.alice.UserID})
		return n == 0
	})
	if l, _ := e.svc.List(ctx, e.bob, repo); len(l) != 1 {
		t.Error("bob's drafts were purged")
	}
}

func TestRevokedMarkerIsCheckedInsideTheStoreTransaction(t *testing.T) {
	e := newEnv(t)
	store := pbstore.NewDraftStore(e.app)
	guardErr := errors.New("revoked")
	called := false
	err := store.Put(ctx, drafts.Record{ID: "guarded00000001", Owner: e.alice.UserID, RepoID: repo, Path: "g.qmd",
		BaseSHA: sha, Content: "sealed", Version: "abcdefgh", UpdatedAt: e.clock.Now()}, drafts.Precondition{},
		drafts.Limits{MaxDrafts: 10, MaxOwnerDrafts: 10, MaxOwnerBytes: 100},
		func() error { called = true; return guardErr })
	if !errors.Is(err, guardErr) || !called {
		t.Fatalf("guarded put = %v (called %v)", err, called)
	}
	if n, _ := e.app.CountRecords(pbstore.DraftsCollection); n != 0 {
		t.Error("draft written despite the guard")
	}
}

func TestRevokeMarkerExpires(t *testing.T) {
	e := newEnv(t, func(c *drafts.Config) { c.RevokeTTL = time.Minute; c.SecondPurgeDelay = time.Millisecond })
	e.svc.Revoke(e.alice.UserID)
	e.clock.Advance(2 * time.Minute)
	if _, err := e.svc.Put(ctx, e.alice, repo, put("a.qmd", "after sign-in again")); err != nil {
		t.Errorf("put after the marker expired = %v", err)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLimits(t *testing.T) {
	e := newEnv(t, func(c *drafts.Config) { c.MaxDrafts = 2 })
	big := strings.Repeat("x", drafts.MaxContentBytes)
	if _, err := e.svc.Put(ctx, e.alice, repo, put("big.qmd", big)); err != nil {
		t.Fatalf("2 MB draft: %v", err)
	}
	_, err := e.svc.Put(ctx, e.alice, repo, put("bigger.qmd", big+"x"))
	var ve *comments.ValidationError
	if !errors.As(err, &ve) || ve.Field != "content" {
		t.Errorf("oversized = %v", err)
	}
	e.put(t, e.alice, put("two.qmd", "2"))
	_, err = e.svc.Put(ctx, e.alice, repo, put("three.qmd", "3"))
	if !errors.As(err, &ve) || ve.Field != "drafts" {
		t.Errorf("over count = %v", err)
	}
	// Updating an existing draft at the limit is fine; other repos and users have their own budget.
	in := put("two.qmd", "2b")
	d, _ := e.svc.Get(ctx, e.alice, repo, "two.qmd")
	in.Expected = d.UpdatedAt
	if _, err := e.svc.Put(ctx, e.alice, repo, in); err != nil {
		t.Errorf("update at limit: %v", err)
	}
	if _, err := e.svc.Put(ctx, e.alice, otherRepo, put("three.qmd", "3")); err != nil {
		t.Errorf("other repo: %v", err)
	}
	if _, err := e.svc.Put(ctx, e.bob, repo, put("three.qmd", "3")); err != nil {
		t.Errorf("other user: %v", err)
	}
}

func TestInputValidation(t *testing.T) {
	e := newEnv(t)
	tests := []struct {
		name  string
		edit  func(*drafts.PutInput)
		field string
	}{
		{"path traversal", func(p *drafts.PutInput) { p.Path = "../etc/passwd" }, "path"},
		{"empty path", func(p *drafts.PutInput) { p.Path = "" }, "path"},
		{"short sha", func(p *drafts.PutInput) { p.BaseSHA = "abc" }, "base_sha"},
		{"bad ref", func(p *drafts.PutInput) { p.BaseRef = "main..x" }, "base_ref"},
		{"ref with control", func(p *drafts.PutInput) { p.BaseRef = "ma\nin" }, "base_ref"},
		{"long device", func(p *drafts.PutInput) { p.Device = strings.Repeat("d", 65) }, "device"},
		{"device with newline", func(p *drafts.PutInput) { p.Device = "a\nb" }, "device"},
		{"NUL in content", func(p *drafts.PutInput) { p.Content = "a\x00b" }, "content"},
		{"invalid UTF-8", func(p *drafts.PutInput) { p.Content = "\xff" }, "content"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := put("a.qmd", "ok")
			tt.edit(&in)
			_, err := e.svc.Put(ctx, e.alice, repo, in)
			var ve *comments.ValidationError
			if !errors.As(err, &ve) || ve.Field != tt.field {
				t.Errorf("err = %v, want invalid %s", err, tt.field)
			}
		})
	}
	// Optional fields may be empty, and an empty draft is allowed.
	in := drafts.PutInput{Path: "empty.qmd", BaseSHA: sha}
	if _, err := e.svc.Put(ctx, e.alice, repo, in); err != nil {
		t.Errorf("minimal draft: %v", err)
	}
	if _, err := e.svc.Get(ctx, e.alice, repo, "../x"); err == nil {
		t.Error("invalid path accepted on get")
	}
}

func TestWritesAreRateLimited(t *testing.T) {
	e := newEnv(t, func(c *drafts.Config) { c.Limiter = comments.NewRateLimiter(2, time.Hour, nil) })
	e.put(t, e.alice, put("a.qmd", "1"))
	e.put(t, e.alice, put("b.qmd", "2"))
	if _, err := e.svc.Put(ctx, e.alice, repo, put("c.qmd", "3")); !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("third write = %v", err)
	}
	if _, err := e.svc.List(ctx, e.alice, repo); err != nil {
		t.Errorf("reads are not limited: %v", err)
	}
}

func TestContentIsSealedAndBoundToItsPlace(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("a.qmd", "PLAINTEXT-DRAFT"))
	e.put(t, e.alice, put("b.qmd", "other"))
	rec, err := e.app.FindFirstRecordByData(pbstore.DraftsCollection, "path", "a.qmd")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rec.GetString("content"), "PLAINTEXT") {
		t.Fatal("content stored in plaintext")
	}

	moves := []struct {
		name  string
		apply func(r *core.Record)
		as    comments.Actor
		repo  int64
		path  string
	}{
		{"moved to another path", func(r *core.Record) { r.Set("path", "c.qmd") }, e.alice, repo, "c.qmd"},
		{"moved to another repository", func(r *core.Record) { r.Set("repo_id", otherRepo) }, e.alice, otherRepo, "a.qmd"},
		{"moved to another owner", func(r *core.Record) { r.Set("owner", e.bob.UserID) }, e.bob, repo, "a.qmd"},
	}
	for _, m := range moves {
		t.Run(m.name, func(t *testing.T) {
			_ = e.svc.Delete(ctx, e.alice, repo, "a.qmd")
			e.put(t, e.alice, put("a.qmd", "PLAINTEXT-DRAFT"))
			r, _ := e.app.FindFirstRecordByFilter(pbstore.DraftsCollection, "path = 'a.qmd' && owner = {:o}", map[string]any{"o": e.alice.UserID})
			m.apply(r)
			if err := e.app.Save(r); err != nil {
				t.Fatal(err)
			}
			_, err := e.svc.Get(ctx, m.as, m.repo, m.path)
			if err == nil || errors.Is(err, comments.ErrNotFound) {
				t.Fatalf("moved draft opens or hides: %v", err)
			}
			if strings.Contains(err.Error(), "PLAINTEXT") {
				t.Errorf("error carries plaintext: %v", err)
			}
			_ = e.app.Delete(r)
		})
	}

	t.Run("swapped between records", func(t *testing.T) {
		a, _ := e.app.FindFirstRecordByData(pbstore.DraftsCollection, "path", "b.qmd")
		e.put(t, e.alice, put("c2.qmd", "victim"))
		c, _ := e.app.FindFirstRecordByData(pbstore.DraftsCollection, "path", "c2.qmd")
		c.Set("content", a.GetString("content"))
		if err := e.app.Save(c); err != nil {
			t.Fatal(err)
		}
		if _, err := e.svc.Get(ctx, e.alice, repo, "c2.qmd"); err == nil {
			t.Error("swapped ciphertext opens")
		}
	})
}

func TestPurgeIdle(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("old.qmd", "old"))
	e.clock.Advance(20 * 24 * time.Hour)
	e.put(t, e.alice, put("recent.qmd", "recent"))
	e.clock.Advance(10*24*time.Hour + time.Minute) // old is now 30 days and a minute idle

	n, err := e.svc.PurgeIdle(ctx)
	if err != nil || n != 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	list, _ := e.svc.List(ctx, e.alice, repo)
	if len(list) != 1 || list[0].Path != "recent.qmd" {
		t.Errorf("left = %+v", list)
	}
}

func TestPurgeUserOnRevocation(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("a.qmd", "a"))
	if _, err := e.svc.Put(ctx, e.alice, otherRepo, put("a.qmd", "a")); err != nil {
		t.Fatal(err)
	}
	e.put(t, e.bob, put("a.qmd", "b"))
	n, err := e.svc.PurgeUser(ctx, e.alice.UserID)
	if err != nil || n != 2 {
		t.Fatalf("purge user = %d, %v", n, err)
	}
	if list, _ := e.svc.List(ctx, e.bob, repo); len(list) != 1 {
		t.Errorf("bob's drafts were touched: %+v", list)
	}
	if _, err := e.svc.PurgeUser(ctx, ""); err == nil {
		t.Error("empty user id purges")
	}
}

func TestDeleteAllMineInRepo(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("a.qmd", "a"))
	e.put(t, e.alice, put("b.qmd", "b"))
	if _, err := e.svc.Put(ctx, e.alice, otherRepo, put("a.qmd", "a")); err != nil {
		t.Fatal(err)
	}
	e.put(t, e.bob, put("a.qmd", "b"))
	n, err := e.svc.DeleteAll(ctx, e.alice, repo)
	if err != nil || n != 2 {
		t.Fatalf("delete all = %d, %v", n, err)
	}
	if l, _ := e.svc.List(ctx, e.alice, otherRepo); len(l) != 1 {
		t.Error("other repository purged")
	}
	if l, _ := e.svc.List(ctx, e.bob, repo); len(l) != 1 {
		t.Error("other user purged")
	}
}

type fakeScheduler struct {
	id, expr string
	fn       func()
}

func (f *fakeScheduler) Add(id, expr string, fn func()) error {
	f.id, f.expr, f.fn = id, expr, fn
	return nil
}

func TestScheduleRetention(t *testing.T) {
	e := newEnv(t)
	e.put(t, e.alice, put("old.qmd", "old"))
	e.clock.Advance(31 * 24 * time.Hour)
	s := &fakeScheduler{}
	if err := drafts.ScheduleRetention(s, e.svc, nil); err != nil {
		t.Fatal(err)
	}
	if s.id == "" || s.expr != "0 * * * *" {
		t.Errorf("job = %q %q, want hourly", s.id, s.expr)
	}
	s.fn()
	if l, _ := e.svc.List(ctx, e.alice, repo); len(l) != 0 {
		t.Errorf("cron run left %d drafts", len(l))
	}
	// It also registers on PocketBase's own cron.
	if err := drafts.ScheduleRetention(e.app.Cron(), e.svc, nil); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, j := range e.app.Cron().Jobs() {
		found = found || j.Id() == s.id
	}
	if !found {
		t.Error("job missing from the app cron")
	}
}

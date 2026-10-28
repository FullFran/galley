package admin_test

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

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/chat"
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
	perms map[string]map[int64]comments.RepoPermission
	calls int
	// demoted: what a fresh check returns for the user.
	demoted    map[string]comments.RepoPermission
	freshCalls int
}

func (f *fakeAccess) Permission(_ context.Context, userID string, repoID int64) (comments.RepoPermission, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	p, ok := f.perms[userID][repoID]
	if !ok {
		return comments.RepoPermission{}, comments.ErrNotFound
	}
	return p, nil
}

// FreshPermission stands for an uncached GitHub check: demoted users are
// what GitHub says now, while Permission keeps answering the cached value.
func (f *fakeAccess) FreshPermission(ctx context.Context, userID string, repoID int64) (comments.RepoPermission, error) {
	f.mu.Lock()
	f.freshCalls++
	p, ok := f.demoted[userID]
	f.mu.Unlock()
	if ok {
		return p, nil
	}
	return f.Permission(ctx, userID, repoID)
}

func (f *fakeAccess) set(userID string, repoID int64, p comments.RepoPermission) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.perms[userID] == nil {
		f.perms[userID] = map[int64]comments.RepoPermission{}
	}
	f.perms[userID][repoID] = p
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
	app      core.App
	users    *pbstore.Store
	store    *pbstore.AdminStore
	access   *fakeAccess
	clock    *fakeClock
	guard    *admin.Guard
	svc      *admin.Service
	drafts   *drafts.Service
	comments *comments.Service
	chat     *chat.Service

	mu      sync.Mutex
	revoked []string

	root  comments.Actor // admin of repo
	alice comments.Actor // push
	bob   comments.Actor // pull
	eve   comments.Actor // admin of otherRepo only
}

var (
	adminPerm = comments.RepoPermission{FullName: "o/paper", Pull: true, Push: true, Admin: true}
	pushPerm  = comments.RepoPermission{FullName: "o/paper", Pull: true, Push: true}
	pullPerm  = comments.RepoPermission{FullName: "o/paper", Pull: true}
)

func newEnv(t *testing.T) *env {
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
	e := &env{app: app, users: users, store: pbstore.NewAdminStore(app),
		clock:  &fakeClock{now: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)},
		access: &fakeAccess{perms: map[string]map[int64]comments.RepoPermission{}, demoted: map[string]comments.RepoPermission{}},
		root:   actor(1, "root"), alice: actor(2, "alice"), bob: actor(3, "bob"), eve: actor(4, "eve")}
	e.access.set(e.root.UserID, repo, adminPerm)
	e.access.set(e.alice.UserID, repo, pushPerm)
	e.access.set(e.bob.UserID, repo, pullPerm)
	e.access.set(e.eve.UserID, otherRepo, comments.RepoPermission{FullName: "o/other", Pull: true, Push: true, Admin: true})
	e.access.set(e.eve.UserID, repo, pullPerm)

	e.guard, err = admin.NewGuard(admin.GuardConfig{
		Inner: e.access,
		Store: e.store,
		Users: func(ctx context.Context, id string) (admin.Identity, error) {
			u, err := users.UserByID(ctx, id)
			return admin.Identity{GitHubID: u.GitHubID, Login: u.Login}, err
		},
		Clock: e.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	sealer, err := secret.NewSealer(bytes.Repeat([]byte{9}, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	if e.drafts, err = drafts.NewService(drafts.Config{Store: pbstore.NewDraftStore(app), Access: e.guard, Sealer: sealer, Clock: e.clock}); err != nil {
		t.Fatal(err)
	}
	if e.comments, err = comments.NewService(comments.Config{Store: pbstore.NewCommentStore(app), Access: e.guard, Sealer: sealer, Clock: e.clock}); err != nil {
		t.Fatal(err)
	}
	if e.chat, err = chat.NewService(chat.Config{Store: pbstore.NewChatStore(app), Access: e.guard, Sealer: sealer, Clock: e.clock}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.chat.Shutdown)
	e.svc, err = admin.NewService(admin.Config{
		Guard:  e.guard,
		Store:  e.store,
		Drafts: e.drafts,
		DeleteSessions: func(ctx context.Context, userID string) error {
			e.mu.Lock()
			e.revoked = append(e.revoked, userID)
			e.mu.Unlock()
			return users.DeleteUserSessions(ctx, userID)
		},
		Clock: e.clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) putDraft(t *testing.T, a comments.Actor, path, content string) drafts.Draft {
	t.Helper()
	d, err := e.drafts.Put(ctx, a, repo, drafts.PutInput{Path: path, BaseSHA: sha, Content: content})
	if err != nil {
		t.Fatalf("put draft: %v", err)
	}
	return d
}

func (e *env) auditActions(t *testing.T) []string {
	t.Helper()
	list, err := e.store.Audit(ctx, repo, 500)
	if err != nil {
		t.Fatal(err)
	}
	// The store lists newest first; return them in the order they happened.
	out := make([]string, len(list))
	for i, a := range list {
		out[len(list)-1-i] = a.Action
	}
	return out
}

func TestAdminEndpointsNeedAdminPermission(t *testing.T) {
	e := newEnv(t)
	stranger := comments.Actor{UserID: "nobody000000000", Login: "nobody"}
	calls := map[string]func(comments.Actor) error{
		"people":    func(a comments.Actor) error { _, err := e.svc.People(ctx, a, repo); return err },
		"revoke":    func(a comments.Actor) error { return e.svc.RevokeSessions(ctx, a, repo, e.bob.UserID, false) },
		"allowlist": func(a comments.Actor) error { _, err := e.svc.Allowlist(ctx, a, repo); return err },
		"allow":     func(a comments.Actor) error { _, err := e.svc.Allow(ctx, a, repo, 3, "bob"); return err },
		"disallow":  func(a comments.Actor) error { return e.svc.Disallow(ctx, a, repo, "abcdefghijklmno") },
		"shares":    func(a comments.Actor) error { _, err := e.svc.SharedDrafts(ctx, a, repo); return err },
		"share": func(a comments.Actor) error {
			_, _, err := e.svc.SharedDraft(ctx, a, repo, "abcdefghijklmno")
			return err
		},
		"audit": func(a comments.Actor) error { _, err := e.svc.Audit(ctx, a, repo); return err },
	}
	for name, call := range calls {
		if err := call(e.alice); !errors.Is(err, comments.ErrForbidden) {
			t.Errorf("%s by push user = %v, want forbidden", name, err)
		}
		if err := call(stranger); !errors.Is(err, comments.ErrNotFound) {
			t.Errorf("%s by stranger = %v, want not found", name, err)
		}
		// eve administers another repository, not this one.
		if err := call(e.eve); !errors.Is(err, comments.ErrForbidden) {
			t.Errorf("%s by admin of another repo = %v, want forbidden", name, err)
		}
		if err := call(comments.Actor{}); !errors.Is(err, comments.ErrUnauthenticated) {
			t.Errorf("%s without actor = %v", name, err)
		}
	}
	if got := e.auditActions(t); len(got) != 0 {
		t.Errorf("refused calls were audited: %v", got)
	}
}

func TestPeopleListsActivityAndDraftMetadataOnly(t *testing.T) {
	e := newEnv(t)
	e.putDraft(t, e.alice, "a.qmd", "SECRET alpha")
	e.clock.Advance(time.Hour)
	e.putDraft(t, e.alice, "b.qmd", "SECRET beta!")
	if _, err := e.chat.Unread(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	// eve's activity on the other repository is not listed here.
	if _, err := e.drafts.List(ctx, e.eve, otherRepo); err != nil {
		t.Fatal(err)
	}

	people, err := e.svc.People(ctx, e.root, repo)
	if err != nil {
		t.Fatal(err)
	}
	byLogin := map[string]admin.PersonView{}
	for _, p := range people {
		byLogin[p.Login] = p
	}
	if len(people) != 3 {
		t.Fatalf("people = %+v", people)
	}
	a := byLogin["alice"]
	if a.Level != admin.LevelWrite || a.GitHubID != 2 || a.UserID != e.alice.UserID || a.Blocked {
		t.Errorf("alice = %+v", a)
	}
	if a.Drafts.Count != 2 || a.Drafts.Bytes != int64(len("SECRET alpha")+len("SECRET beta!")) {
		t.Errorf("alice drafts = %+v", a.Drafts)
	}
	if !a.Drafts.Oldest.Equal(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)) || !a.Drafts.Newest.Equal(time.Date(2026, 10, 28, 13, 0, 0, 0, time.UTC)) {
		t.Errorf("alice draft ages = %v .. %v", a.Drafts.Oldest, a.Drafts.Newest)
	}
	if b := byLogin["bob"]; b.Level != admin.LevelRead || b.Drafts.Count != 0 {
		t.Errorf("bob = %+v", b)
	}
	if r := byLogin["root"]; r.Level != admin.LevelAdmin {
		t.Errorf("root = %+v", r)
	}
	if _, ok := byLogin["eve"]; ok {
		t.Error("eve listed without activity on this repo")
	}
	if strings.Contains(strings.ToLower(fmtAll(people)), "secret") {
		t.Error("people listing contains draft content")
	}
	if got := e.auditActions(t); len(got) != 1 || got[0] != admin.ActionViewPeople {
		t.Errorf("audit = %v", got)
	}
}

func fmtAll(v any) string { return fmt.Sprintf("%+v", v) }

func TestLastSeenIsThrottled(t *testing.T) {
	e := newEnv(t)
	seen := func() admin.Activity {
		t.Helper()
		acts, err := e.store.People(ctx, repo, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, a := range acts {
			if a.UserID == e.bob.UserID {
				return a.Activity
			}
		}
		t.Fatal("bob has no activity")
		return admin.Activity{}
	}
	start := e.clock.Now()
	if _, err := e.drafts.List(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	first := seen()
	if !first.FirstSeen.Equal(start) || !first.LastSeen.Equal(start) || first.Level != admin.LevelRead {
		t.Fatalf("first = %+v", first)
	}
	e.clock.Advance(time.Minute)
	if _, err := e.drafts.List(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	if got := seen(); !got.LastSeen.Equal(start) {
		t.Errorf("last_seen moved within the throttle: %v", got.LastSeen)
	}
	e.clock.Advance(admin.DefaultTouchEvery)
	if _, err := e.drafts.List(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	got := seen()
	if !got.LastSeen.Equal(e.clock.Now()) || !got.FirstSeen.Equal(start) {
		t.Errorf("after the throttle = %+v", got)
	}
	// A permission change is written at once.
	e.clock.Advance(time.Second)
	e.access.set(e.bob.UserID, repo, pushPerm)
	if _, err := e.drafts.List(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	if got := seen(); got.Level != admin.LevelWrite || !got.LastSeen.Equal(e.clock.Now()) {
		t.Errorf("after a permission change = %+v", got)
	}
}

func TestRevokeSessions(t *testing.T) {
	e := newEnv(t)
	for _, h := range []string{strings.Repeat("a", 64), strings.Repeat("b", 64)} {
		if err := e.users.CreateSession(ctx, auth.Session{TokenHash: h, UserID: e.bob.UserID, ExpiresAt: e.clock.Now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	// bob has not used galley on this repository yet.
	if err := e.svc.RevokeSessions(ctx, e.root, repo, e.bob.UserID, false); !errors.Is(err, comments.ErrNotFound) {
		t.Fatalf("revoke unseen user = %v", err)
	}
	if _, err := e.chat.Unread(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.RevokeSessions(ctx, e.root, repo, e.bob.UserID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := e.users.SessionByHash(ctx, strings.Repeat("a", 64)); !errors.Is(err, auth.ErrNotFound) {
		t.Errorf("session survived: %v", err)
	}
	if len(e.revoked) != 1 || e.revoked[0] != e.bob.UserID {
		t.Errorf("revoked = %v", e.revoked)
	}

	// Revoking yourself needs confirm_self.
	var ve *comments.ValidationError
	if err := e.svc.RevokeSessions(ctx, e.root, repo, e.root.UserID, false); !errors.As(err, &ve) || ve.Field != "confirm_self" {
		t.Errorf("self revoke without confirm = %v", err)
	}
	if err := e.svc.RevokeSessions(ctx, e.root, repo, e.root.UserID, true); err != nil {
		t.Errorf("self revoke with confirm = %v", err)
	}
	if err := e.svc.RevokeSessions(ctx, e.root, repo, "", false); !errors.As(err, &ve) {
		t.Errorf("empty target = %v", err)
	}
	got := e.auditActions(t)
	if len(got) != 2 || got[0] != admin.ActionRevokeSessions || got[1] != admin.ActionRevokeSessions {
		t.Errorf("audit = %v", got)
	}
	list, _ := e.store.Audit(ctx, repo, 10)
	if list[1].Target != "user:"+e.bob.UserID || list[1].ActorID != e.root.UserID || list[1].ActorLogin != "root" {
		t.Errorf("audit entry = %+v", list[1])
	}
}

func TestAllowlistRestrictsGalleyFeatures(t *testing.T) {
	e := newEnv(t)
	// Empty allowlist: everyone with access may use galley.
	if _, err := e.drafts.List(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Allow(ctx, e.root, repo, 2, ""); err != nil { // alice by id
		t.Fatal(err)
	}
	if _, err := e.svc.Allow(ctx, e.root, repo, 0, "EVE"); err != nil { // eve by login
		t.Fatal(err)
	}
	var ve *comments.ValidationError
	if _, err := e.svc.Allow(ctx, e.root, repo, 0, ""); !errors.As(err, &ve) {
		t.Errorf("empty entry = %v", err)
	}
	if _, err := e.svc.Allow(ctx, e.root, repo, 0, "bad login!"); !errors.As(err, &ve) || ve.Field != "login" {
		t.Errorf("bad login = %v", err)
	}
	if _, err := e.svc.Allow(ctx, e.root, repo, 2, ""); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("duplicate = %v", err)
	}

	// bob is not on the list: comments, drafts and chat refuse him.
	if _, err := e.drafts.List(ctx, e.bob, repo); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("drafts for blocked user = %v", err)
	}
	if _, err := e.comments.ListThreads(ctx, e.bob, repo, comments.ListFilter{}); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("comments for blocked user = %v", err)
	}
	if err := e.chat.Check(ctx, e.bob, repo); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("chat for blocked user = %v", err)
	}
	// alice (by id), eve (by login, case-insensitive) and root (admin) pass.
	for _, a := range []comments.Actor{e.alice, e.eve, e.root} {
		if _, err := e.drafts.List(ctx, a, repo); err != nil {
			t.Errorf("%s: %v", a.Login, err)
		}
		if err := e.chat.Check(ctx, a, repo); err != nil {
			t.Errorf("%s chat: %v", a.Login, err)
		}
	}
	// Other repositories are unaffected.
	e.access.set(e.bob.UserID, otherRepo, pullPerm)
	if _, err := e.drafts.List(ctx, e.bob, otherRepo); err != nil {
		t.Errorf("other repo: %v", err)
	}

	people, err := e.svc.People(ctx, e.root, repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range people {
		if p.Blocked != (p.Login == "bob") {
			t.Errorf("%s blocked = %v", p.Login, p.Blocked)
		}
	}

	list, err := e.svc.Allowlist(ctx, e.root, repo)
	if err != nil || len(list) != 2 {
		t.Fatalf("allowlist = %+v, %v", list, err)
	}
	for _, entry := range list {
		if err := e.svc.Disallow(ctx, e.root, repo, entry.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.svc.Disallow(ctx, e.root, repo, list[0].ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("second delete = %v", err)
	}
	// Empty again: bob is back, without waiting for the cache.
	if _, err := e.drafts.List(ctx, e.bob, repo); err != nil {
		t.Errorf("after clearing: %v", err)
	}
	// An admin of another repository cannot remove entries of this one.
	entry, _ := e.svc.Allow(ctx, e.root, repo, 2, "")
	if err := e.svc.Disallow(ctx, e.eve, otherRepo, entry.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("cross-repo delete = %v", err)
	}
	got := e.auditActions(t)
	want := []string{admin.ActionAllowlistAdd, admin.ActionAllowlistAdd, admin.ActionViewPeople, admin.ActionViewAllowlist,
		admin.ActionAllowlistRemove, admin.ActionAllowlistRemove, admin.ActionAllowlistAdd}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("audit = %v\nwant    %v", got, want)
	}
}

func TestShareLifecycle(t *testing.T) {
	e := newEnv(t)
	e.putDraft(t, e.alice, "a.qmd", "first version")

	// Only the owner shares, and only an existing draft.
	if _, err := e.svc.ShareDraft(ctx, e.bob, repo, "a.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("share someone else's draft = %v", err)
	}
	if _, err := e.svc.ShareDraft(ctx, e.alice, repo, "missing.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("share missing draft = %v", err)
	}
	if _, err := e.svc.ShareDraft(ctx, e.alice, repo, "../x"); err == nil {
		t.Error("invalid path accepted")
	}
	sh, err := e.svc.ShareDraft(ctx, e.alice, repo, "a.qmd")
	if err != nil {
		t.Fatal(err)
	}
	if !sh.ExpiresAt.Equal(e.clock.Now().Add(admin.DefaultShareTTL)) || sh.Owner != e.alice.UserID || sh.Path != "a.qmd" {
		t.Errorf("share = %+v", sh)
	}

	// The admin sees the grant and the current version of the draft.
	list, err := e.svc.SharedDrafts(ctx, e.root, repo)
	if err != nil || len(list) != 1 || list[0].ID != sh.ID || list[0].OwnerLogin != "alice" {
		t.Fatalf("shared drafts = %+v, %v", list, err)
	}
	_, d, err := e.svc.SharedDraft(ctx, e.root, repo, sh.ID)
	if err != nil || d.Content != "first version" {
		t.Fatalf("shared draft = %q, %v", d.Content, err)
	}
	cur, _ := e.drafts.Get(ctx, e.alice, repo, "a.qmd")
	if _, err := e.drafts.Put(ctx, e.alice, repo, drafts.PutInput{Path: "a.qmd", BaseSHA: sha, Content: "second version",
		Expected: cur.UpdatedAt, ExpectedVersion: cur.Version}); err != nil {
		t.Fatal(err)
	}
	if _, d, _ := e.svc.SharedDraft(ctx, e.root, repo, sh.ID); d.Content != "second version" {
		t.Errorf("after edit = %q", d.Content)
	}
	// The grant is for this repository's admins only.
	if _, _, err := e.svc.SharedDraft(ctx, e.eve, otherRepo, sh.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("admin of another repo = %v", err)
	}
	if _, _, err := e.svc.SharedDraft(ctx, e.alice, repo, sh.ID); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("non-admin view = %v", err)
	}

	// Revocation ends access at once.
	if err := e.svc.UnshareDraft(ctx, e.alice, repo, "a.qmd"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.SharedDraft(ctx, e.root, repo, sh.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("after revoke = %v", err)
	}
	if err := e.svc.UnshareDraft(ctx, e.alice, repo, "a.qmd"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("second revoke = %v", err)
	}

	// Expiry ends access too.
	sh2, err := e.svc.ShareDraft(ctx, e.alice, repo, "a.qmd")
	if err != nil {
		t.Fatal(err)
	}
	mine, err := e.svc.MyShares(ctx, e.alice, repo)
	if err != nil || len(mine) != 1 || mine[0].ID != sh2.ID {
		t.Errorf("my shares = %+v, %v", mine, err)
	}
	e.clock.Advance(admin.DefaultShareTTL)
	if _, _, err := e.svc.SharedDraft(ctx, e.root, repo, sh2.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("after expiry = %v", err)
	}
	if list, _ := e.svc.SharedDrafts(ctx, e.root, repo); len(list) != 0 {
		t.Errorf("expired grant listed: %+v", list)
	}

	// A draft deleted and recreated at the same path is a new draft: the old
	// grant does not cover it.
	sh3, err := e.svc.ShareDraft(ctx, e.alice, repo, "a.qmd")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.drafts.Delete(ctx, e.alice, repo, "a.qmd"); err != nil {
		t.Fatal(err)
	}
	e.putDraft(t, e.alice, "a.qmd", "recreated")
	if _, _, err := e.svc.SharedDraft(ctx, e.root, repo, sh3.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("recreated draft = %v", err)
	}

	got := e.auditActions(t)
	want := []string{
		admin.ActionShareCreate, admin.ActionViewSharedDrafts, admin.ActionViewSharedDraft, admin.ActionViewSharedDraft,
		admin.ActionShareRevoke, admin.ActionShareCreate, admin.ActionViewSharedDrafts, admin.ActionShareCreate,
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("audit = %v\nwant    %v", got, want)
	}
}

func TestBlockedUserCannotShare(t *testing.T) {
	e := newEnv(t)
	e.putDraft(t, e.bob, "a.qmd", "x")
	if _, err := e.svc.Allow(ctx, e.root, repo, 2, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.ShareDraft(ctx, e.bob, repo, "a.qmd"); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("blocked share = %v", err)
	}
}

func TestAuditListIsNewestFirstAndBounded(t *testing.T) {
	e := newEnv(t)
	for i := 0; i < admin.MaxAuditList+5; i++ {
		if _, err := e.svc.Allowlist(ctx, e.root, repo); err != nil {
			t.Fatal(err)
		}
		e.clock.Advance(time.Second)
	}
	list, err := e.svc.Audit(ctx, e.root, repo)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != admin.MaxAuditList {
		t.Fatalf("audit length = %d", len(list))
	}
	// The view of the audit itself is recorded first, so it is the newest.
	if list[0].Action != admin.ActionViewAudit || !list[1].At.After(list[2].At) {
		t.Errorf("order: %+v %+v %+v", list[0], list[1], list[2])
	}
	for _, a := range list {
		if a.RepoID != repo || a.ActorID != e.root.UserID {
			t.Errorf("entry = %+v", a)
		}
	}
}

package pbstore_test

import (
	"errors"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/pbstore"
)

type adminFixture struct {
	app   core.App
	s     *pbstore.AdminStore
	ds    *pbstore.DraftStore
	alice auth.User
	at    time.Time
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	users, app := newStore(t)
	alice, err := users.UpsertUser(ctx, auth.GitHubUser{ID: 1, Login: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	return &adminFixture{app: app, s: pbstore.NewAdminStore(app), ds: pbstore.NewDraftStore(app), alice: alice,
		at: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)}
}

func (f *adminFixture) draft(t *testing.T, id, path string) {
	t.Helper()
	d := drafts.Record{ID: id, Owner: f.alice.ID, RepoID: 7, Path: path,
		BaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Content: "sealed", Size: 1, Version: "v1", UpdatedAt: f.at}
	if err := f.ds.Put(ctx, d, drafts.Precondition{}, drafts.Limits{MaxDrafts: 9, MaxOwnerDrafts: 9, MaxOwnerBytes: 99}, nil); err != nil {
		t.Fatal(err)
	}
}

func (f *adminFixture) share(t *testing.T, id, draftID, path string) admin.Share {
	t.Helper()
	sh := admin.Share{ID: id, DraftID: draftID, Owner: f.alice.ID, RepoID: 7, Path: path, CreatedAt: f.at, ExpiresAt: f.at.Add(24 * time.Hour)}
	if err := f.s.CreateShare(ctx, sh, f.audit(admin.ActionShareCreate)); err != nil {
		t.Fatal(err)
	}
	return sh
}

func (f *adminFixture) audit(action string) admin.AuditEntry {
	return admin.AuditEntry{RepoID: 7, ActorID: f.alice.ID, ActorLogin: "alice", Action: action, Target: "repo", At: f.at}
}

func (f *adminFixture) auditCount(t *testing.T) int {
	t.Helper()
	list, err := f.s.Audit(ctx, 7, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return len(list)
}

func TestExtendShareOnlyExtendsActiveGrants(t *testing.T) {
	f := newAdminFixture(t)
	f.draft(t, "draft0000000001", "a.qmd")
	sh := f.share(t, "share0000000001", "draft0000000001", "a.qmd")
	before := f.auditCount(t)

	if err := f.s.ExtendShare(ctx, sh.ID, f.at.Add(time.Hour), f.at.Add(25*time.Hour), f.audit(admin.ActionShareCreate)); err != nil {
		t.Fatalf("extend active = %v", err)
	}
	if got, _ := f.s.Share(ctx, sh.ID); !got.ExpiresAt.Equal(f.at.Add(25 * time.Hour)) {
		t.Errorf("expires = %v", got.ExpiresAt)
	}
	if f.auditCount(t) != before+1 {
		t.Error("extension not audited")
	}
	// Expired: not extended, not audited.
	if err := f.s.ExtendShare(ctx, sh.ID, f.at.Add(25*time.Hour), f.at.Add(48*time.Hour), f.audit(admin.ActionShareCreate)); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("extend expired = %v", err)
	}
	// Revoked: not extended, not audited.
	if _, err := f.s.RevokeShares(ctx, f.alice.ID, 7, "a.qmd", f.at.Add(2*time.Hour), f.audit(admin.ActionShareRevoke)); err != nil {
		t.Fatal(err)
	}
	n := f.auditCount(t)
	if err := f.s.ExtendShare(ctx, sh.ID, f.at.Add(3*time.Hour), f.at.Add(27*time.Hour), f.audit(admin.ActionShareCreate)); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("extend revoked = %v", err)
	}
	if f.auditCount(t) != n {
		t.Error("failed extension was audited")
	}
}

func TestBulkDraftDeletesRemoveTheirGrants(t *testing.T) {
	for name, del := range map[string]func(f *adminFixture) error{
		"idle":  func(f *adminFixture) error { _, err := f.ds.DeleteIdle(ctx, f.at.Add(time.Second)); return err },
		"repo":  func(f *adminFixture) error { _, err := f.ds.DeleteRepo(ctx, f.alice.ID, 7); return err },
		"owner": func(f *adminFixture) error { _, err := f.ds.DeleteOwner(ctx, f.alice.ID); return err },
	} {
		t.Run(name, func(t *testing.T) {
			f := newAdminFixture(t)
			f.draft(t, "draft0000000001", "a.qmd")
			sh := f.share(t, "share0000000001", "draft0000000001", "a.qmd")
			if err := del(f); err != nil {
				t.Fatal(err)
			}
			if _, err := f.s.Share(ctx, sh.ID); !errors.Is(err, comments.ErrNotFound) {
				t.Errorf("grant survived its draft: %v", err)
			}
		})
	}
}

func TestActiveSharesIgnoreGrantsWithoutDraft(t *testing.T) {
	f := newAdminFixture(t)
	f.draft(t, "draft0000000001", "a.qmd")
	f.share(t, "share0000000001", "draft0000000001", "a.qmd")
	// An orphan left by an older bulk delete.
	if _, err := f.app.NonconcurrentDB().Delete(pbstore.DraftsCollection, nil).Execute(); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.ActiveShares(ctx, 7, f.alice.ID, f.at, 10); err != nil || len(got) != 0 {
		t.Errorf("active = %+v, %v", got, err)
	}
}

func TestAddAllowEntryIsBoundedAndAudited(t *testing.T) {
	f := newAdminFixture(t)
	entry := func(id string, gh int64, login string) admin.AllowEntry {
		return admin.AllowEntry{ID: id, RepoID: 7, GitHubID: gh, Login: login, CreatedAt: f.at}
	}
	if err := f.s.AddAllowEntry(ctx, entry("allow0000000001", 1, ""), 2, f.audit(admin.ActionAllowlistAdd)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.AddAllowEntry(ctx, entry("allow0000000002", 1, "x"), 2, f.audit(admin.ActionAllowlistAdd)); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("duplicate id = %v", err)
	}
	if err := f.s.AddAllowEntry(ctx, entry("allow0000000003", 0, "bob"), 2, f.audit(admin.ActionAllowlistAdd)); err != nil {
		t.Fatal(err)
	}
	var ve *comments.ValidationError
	if err := f.s.AddAllowEntry(ctx, entry("allow0000000004", 0, "carol"), 2, f.audit(admin.ActionAllowlistAdd)); !errors.As(err, &ve) || ve.Field != "allowlist" {
		t.Errorf("over the cap = %v", err)
	}
	if f.auditCount(t) != 2 {
		t.Errorf("audit rows = %d, want 2", f.auditCount(t))
	}
	if err := f.s.DeleteAllowEntry(ctx, 7, "allow0000000003", f.audit(admin.ActionAllowlistRemove)); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DeleteAllowEntry(ctx, 7, "allow0000000003", f.audit(admin.ActionAllowlistRemove)); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("second delete = %v", err)
	}
	if f.auditCount(t) != 3 {
		t.Errorf("audit rows = %d, want 3", f.auditCount(t))
	}
}

func TestHasActivityHonoursTheWindow(t *testing.T) {
	f := newAdminFixture(t)
	if err := f.s.TouchActivity(ctx, admin.Activity{UserID: f.alice.ID, RepoID: 7, Level: admin.LevelRead, FirstSeen: f.at, LastSeen: f.at}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := f.s.HasActivity(ctx, f.alice.ID, 7, f.at); !ok {
		t.Error("activity at the boundary not found")
	}
	if ok, _ := f.s.HasActivity(ctx, f.alice.ID, 7, f.at.Add(time.Second)); ok {
		t.Error("activity before the window found")
	}
}

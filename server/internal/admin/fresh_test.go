package admin_test

import (
	"errors"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/comments"
)

func TestMutatingAdminCallsRecheckPermissionFreshly(t *testing.T) {
	e := newEnv(t)
	e.putDraft(t, e.alice, "a.qmd", "x")
	sh, err := e.svc.ShareDraft(ctx, e.alice, repo, "a.qmd")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.chat.Unread(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	entry, err := e.svc.Allow(ctx, e.root, repo, 2, "")
	if err != nil {
		t.Fatal(err)
	}

	// root is demoted on GitHub; the cached permission still says admin.
	e.access.mu.Lock()
	e.access.demoted[e.root.UserID] = pushPerm
	e.access.mu.Unlock()

	if _, err := e.svc.Allow(ctx, e.root, repo, 3, ""); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("allow = %v", err)
	}
	if err := e.svc.Disallow(ctx, e.root, repo, entry.ID); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("disallow = %v", err)
	}
	if err := e.svc.RevokeSessions(ctx, e.root, repo, e.bob.UserID, false); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("revoke = %v", err)
	}
	if _, _, err := e.svc.SharedDraft(ctx, e.root, repo, sh.ID); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("shared draft content = %v", err)
	}
	// Read-only listings use the cached permission.
	if _, err := e.svc.People(ctx, e.root, repo); err != nil {
		t.Errorf("people = %v", err)
	}
}

func TestRevokeSessionsNeedsRecentActivity(t *testing.T) {
	e := newEnv(t)
	if _, err := e.chat.Unread(ctx, e.bob, repo); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(admin.ActivityWindow + time.Hour)
	if err := e.svc.RevokeSessions(ctx, e.root, repo, e.bob.UserID, false); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("revoke after the window = %v", err)
	}
}

func TestSharingIgnoresGrantsOfDeletedDrafts(t *testing.T) {
	e := newEnv(t)
	e.putDraft(t, e.alice, "a.qmd", "x")
	if _, err := e.svc.ShareDraft(ctx, e.alice, repo, "a.qmd"); err != nil {
		t.Fatal(err)
	}
	// Deleting all drafts after a save (a bulk delete, like the idle and
	// revocation purges) removes the draft and must remove its grant.
	if n, err := e.drafts.DeleteAll(ctx, e.alice, repo); err != nil || n != 1 {
		t.Fatalf("delete all = %d, %v", n, err)
	}
	mine, err := e.svc.MyShares(ctx, e.alice, repo)
	if err != nil || len(mine) != 0 {
		t.Errorf("my shares after purge = %+v, %v", mine, err)
	}
	if list, _ := e.svc.SharedDrafts(ctx, e.root, repo); len(list) != 0 {
		t.Errorf("admin listing after purge = %+v", list)
	}
}

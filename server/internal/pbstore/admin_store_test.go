package pbstore_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/pbstore"
)

var adminCollections = []string{pbstore.RepoActivityCollection, pbstore.RepoAllowlistCollection,
	pbstore.DraftSharesCollection, pbstore.AuditCollection}

func TestAdminCollectionsAreSuperuserOnly(t *testing.T) {
	_, app := newStore(t)
	for _, name := range adminCollections {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.ListRule != nil || c.ViewRule != nil || c.CreateRule != nil || c.UpdateRule != nil || c.DeleteRule != nil {
			t.Errorf("%s has a non-nil API rule", name)
		}
	}
}

func TestAdminCollectionsDenyAnonymousRecordAPI(t *testing.T) {
	for _, name := range adminCollections {
		for _, sc := range []tests.ApiScenario{
			{Name: name + " list", Method: http.MethodGet, URL: "/api/collections/" + name + "/records"},
			{Name: name + " create", Method: http.MethodPost, URL: "/api/collections/" + name + "/records", Body: jsonBody(`{"repo_id":7}`)},
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

func TestAdminStoreActivityAndShares(t *testing.T) {
	users, app := newStore(t)
	alice, _ := users.UpsertUser(ctx, auth.GitHubUser{ID: 1, Login: "alice"})
	s := pbstore.NewAdminStore(app)
	at := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)

	if ok, err := s.HasActivity(ctx, alice.ID, 7, at); ok || err != nil {
		t.Fatalf("activity before touch = %v, %v", ok, err)
	}
	for i, lvl := range []admin.Level{admin.LevelRead, admin.LevelAdmin} {
		at := at.Add(time.Duration(i) * time.Hour)
		if err := s.TouchActivity(ctx, admin.Activity{UserID: alice.ID, RepoID: 7, Level: lvl, FirstSeen: at, LastSeen: at}); err != nil {
			t.Fatal(err)
		}
	}
	people, err := s.People(ctx, 7, 10)
	if err != nil || len(people) != 1 {
		t.Fatalf("people = %+v, %v", people, err)
	}
	p := people[0]
	if p.Login != "alice" || p.GitHubID != 1 || p.Level != admin.LevelAdmin || !p.FirstSeen.Equal(at) || !p.LastSeen.Equal(at.Add(time.Hour)) {
		t.Errorf("person = %+v", p)
	}

	ds := pbstore.NewDraftStore(app)
	d := drafts.Record{ID: "draft0000000001", Owner: alice.ID, RepoID: 7, Path: "a.qmd",
		BaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Content: "sealed", Size: 5, Version: "v1", UpdatedAt: at}
	if err := ds.Put(ctx, d, drafts.Precondition{}, drafts.Limits{MaxDrafts: 9, MaxOwnerDrafts: 9, MaxOwnerBytes: 99}, nil); err != nil {
		t.Fatal(err)
	}
	stats, err := s.DraftStats(ctx, 7)
	if err != nil || stats[alice.ID].Count != 1 || stats[alice.ID].Bytes != 5 || !stats[alice.ID].Oldest.Equal(at) {
		t.Errorf("stats = %+v, %v", stats, err)
	}

	sh := admin.Share{ID: "share0000000001", DraftID: d.ID, Owner: alice.ID, RepoID: 7, Path: "a.qmd", CreatedAt: at, ExpiresAt: at.Add(time.Hour)}
	if err := s.CreateShare(ctx, sh, admin.AuditEntry{RepoID: 7, ActorID: alice.ID, Action: admin.ActionShareCreate, At: at}); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.ActiveShares(ctx, 7, "", at.Add(59*time.Minute), 10); len(got) != 1 || got[0].OwnerLogin != "alice" {
		t.Errorf("active = %+v", got)
	}
	if got, _ := s.ActiveShares(ctx, 7, "", at.Add(time.Hour), 10); len(got) != 0 {
		t.Errorf("expired listed: %+v", got)
	}
	ids, err := s.RevokeShares(ctx, alice.ID, 7, "a.qmd", at.Add(time.Minute), admin.AuditEntry{RepoID: 7, ActorID: alice.ID, Action: admin.ActionShareRevoke, At: at})
	if err != nil || len(ids) != 1 || ids[0] != sh.ID {
		t.Fatalf("revoke = %v, %v", ids, err)
	}
	got, _ := s.Share(ctx, sh.ID)
	if got.RevokedAt.IsZero() || got.Active(at.Add(2*time.Minute)) {
		t.Errorf("after revoke = %+v", got)
	}
	// Deleting the draft deletes its grants.
	if err := ds.Delete(ctx, alice.ID, 7, "a.qmd"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Share(ctx, sh.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("grant after draft deletion = %v", err)
	}
}

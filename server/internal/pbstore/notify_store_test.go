package pbstore_test

import (
	"errors"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
	"github.com/FullFran/galley/server/internal/pbstore"
)

func TestNotifyCollectionsAreSuperuserOnlyAndHidden(t *testing.T) {
	_, app := newStore(t)
	for _, name := range []string{pbstore.NotifyPrefsCollection, pbstore.NotifyOutboxCollection} {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.ListRule != nil || c.ViewRule != nil || c.CreateRule != nil || c.UpdateRule != nil || c.DeleteRule != nil {
			t.Errorf("%s has a non-nil API rule", name)
		}
	}
	c, _ := app.FindCollectionByNameOrId(pbstore.NotifyPrefsCollection)
	if f := c.Fields.GetByName("email"); f == nil || !f.GetHidden() {
		t.Error("email is not hidden")
	}
}

func TestNotifyStore(t *testing.T) {
	users, app := newStore(t)
	bob, _ := users.UpsertUser(ctx, auth.GitHubUser{ID: 2, Login: "Bob"})
	s := pbstore.NewNotifyStore(app)

	if id, err := s.UserIDByGitHubID(ctx, 2); err != nil || id != bob.ID {
		t.Errorf("id lookup = %q %v", id, err)
	}
	if _, err := s.UserIDByGitHubID(ctx, 3); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("unknown id err = %v", err)
	}

	if _, err := s.Prefs(ctx, bob.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("missing prefs err = %v", err)
	}
	at := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	p := notify.Prefs{UserID: bob.ID, Email: "sealed", Enabled: true, Kinds: []notify.Kind{notify.KindAssigned}, UpdatedAt: at}
	if err := s.SavePrefs(ctx, p); err != nil {
		t.Fatal(err)
	}
	p.Verified = true
	if err := s.SavePrefs(ctx, p); err != nil {
		t.Fatal(err)
	}
	got, err := s.Prefs(ctx, bob.ID)
	if err != nil || got.Email != "sealed" || !got.Verified || !got.Enabled || len(got.Kinds) != 1 || got.Kinds[0] != notify.KindAssigned {
		t.Errorf("prefs = %+v %v", got, err)
	}
	if err := s.DeletePrefs(ctx, bob.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prefs(ctx, bob.ID); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("after delete err = %v", err)
	}

	key := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if ok, err := s.Reserve(ctx, key, at); err != nil || !ok {
		t.Fatalf("reserve = %v %v", ok, err)
	}
	if ok, err := s.Reserve(ctx, key, at); err != nil || ok {
		t.Errorf("second reserve = %v %v", ok, err)
	}
	if err := s.Release(ctx, key); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Reserve(ctx, key, at); !ok {
		t.Error("released key not reusable")
	}
	if n, err := s.PurgeReservations(ctx, at.Add(time.Hour)); err != nil || n != 1 {
		t.Errorf("purge = %d %v", n, err)
	}
}

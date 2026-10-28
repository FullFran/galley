package pbstore_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/pbstore"
)

func newStore(t *testing.T) (*pbstore.Store, core.App) {
	t.Helper()
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatalf("test app: %v", err)
	}
	t.Cleanup(app.Cleanup)
	return pbstore.New(app), app
}

var ctx = context.Background()

func TestCollectionsAreSuperuserOnly(t *testing.T) {
	_, app := newStore(t)
	for _, name := range []string{pbstore.UsersCollection, pbstore.TokensCollection, pbstore.SessionsCollection} {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.ListRule != nil || c.ViewRule != nil || c.CreateRule != nil || c.UpdateRule != nil || c.DeleteRule != nil {
			t.Errorf("%s has a non-nil API rule", name)
		}
	}
}

func TestUsers(t *testing.T) {
	s, _ := newStore(t)
	u, err := s.UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "octo"})
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := s.UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "octo-new"})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.ID != u.ID || renamed.Login != "octo-new" || renamed.GitHubID != 42 {
		t.Errorf("upsert = %+v, first = %+v", renamed, u)
	}
	got, err := s.UserByGitHubID(ctx, 42)
	if err != nil || got != renamed {
		t.Errorf("by github id = %+v, %v", got, err)
	}
	if _, err := s.UserByGitHubID(ctx, 7); !errors.Is(err, auth.ErrNotFound) {
		t.Errorf("unknown user err = %v", err)
	}
}

func TestRefreshTokens(t *testing.T) {
	s, _ := newStore(t)
	u, _ := s.UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "octo"})
	if _, err := s.LoadRefreshToken(ctx, u.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Fatalf("empty load err = %v", err)
	}
	exp := time.Date(2027, 4, 1, 0, 0, 0, 0, time.UTC)
	if err := s.SaveRefreshToken(ctx, u.ID, auth.StoredToken{Ciphertext: "c1", ExpiresAt: exp}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveRefreshToken(ctx, u.ID, auth.StoredToken{Ciphertext: "c2", ExpiresAt: exp}); err != nil {
		t.Fatal(err)
	}
	got, err := s.LoadRefreshToken(ctx, u.ID)
	if err != nil || got.Ciphertext != "c2" || !got.ExpiresAt.Equal(exp) {
		t.Errorf("load = %+v, %v", got, err)
	}
	if err := s.DeleteRefreshToken(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoadRefreshToken(ctx, u.ID); !errors.Is(err, auth.ErrNotFound) {
		t.Errorf("after delete err = %v", err)
	}
	if err := s.DeleteRefreshToken(ctx, u.ID); err != nil {
		t.Errorf("deleting a missing token = %v", err)
	}
}

func TestSessions(t *testing.T) {
	s, _ := newStore(t)
	a, _ := s.UpsertUser(ctx, auth.GitHubUser{ID: 1, Login: "a"})
	b, _ := s.UpsertUser(ctx, auth.GitHubUser{ID: 2, Login: "b"})
	exp := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	hash := func(c byte) string {
		h := make([]byte, 64)
		for i := range h {
			h[i] = c
		}
		return string(h)
	}
	for _, sess := range []auth.Session{
		{TokenHash: hash('a'), UserID: a.ID, ExpiresAt: exp},
		{TokenHash: hash('b'), UserID: a.ID, ExpiresAt: exp},
		{TokenHash: hash('c'), UserID: b.ID, ExpiresAt: exp},
	} {
		if err := s.CreateSession(ctx, sess); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.CreateSession(ctx, auth.Session{TokenHash: hash('a'), UserID: b.ID, ExpiresAt: exp}); err == nil {
		t.Error("duplicate token hash accepted")
	}

	got, err := s.SessionByHash(ctx, hash('a'))
	if err != nil || got.UserID != a.ID || !got.ExpiresAt.Equal(exp) {
		t.Errorf("by hash = %+v, %v", got, err)
	}
	if err := s.DeleteSession(ctx, hash('a')); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionByHash(ctx, hash('a')); !errors.Is(err, auth.ErrNotFound) {
		t.Errorf("deleted session err = %v", err)
	}
	if err := s.DeleteUserSessions(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SessionByHash(ctx, hash('b')); !errors.Is(err, auth.ErrNotFound) {
		t.Error("user session survived DeleteUserSessions")
	}
	if _, err := s.SessionByHash(ctx, hash('c')); err != nil {
		t.Errorf("other user's session removed: %v", err)
	}
}

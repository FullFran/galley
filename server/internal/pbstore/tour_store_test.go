package pbstore

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
)

func TestTourMigrationPreservesExistingAuth(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	// Recreate the previous user schema in this disposable test database.
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		t.Fatal(err)
	}
	users.Fields.RemoveByName("tour_status")
	if err := app.Save(users); err != nil {
		t.Fatal(err)
	}
	s := New(app)
	ctx := context.Background()
	u, err := s.UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "existing"})
	if err != nil {
		t.Fatal(err)
	}
	token := auth.StoredToken{Ciphertext: "sealed", ExpiresAt: time.Now().UTC().Truncate(time.Second).Add(time.Hour)}
	if err := s.SaveRefreshToken(ctx, u.ID, token); err != nil {
		t.Fatal(err)
	}
	sess := auth.Session{UserID: u.ID, TokenHash: strings.Repeat("a", 64), ExpiresAt: token.ExpiresAt}
	if err := s.CreateSession(ctx, sess); err != nil {
		t.Fatal(err)
	}
	if err := addTourStatus(app); err != nil {
		t.Fatal(err)
	}
	got, err := s.UserByID(ctx, u.ID)
	if err != nil || got != u {
		t.Fatalf("user = %+v %v", got, err)
	}
	gotToken, err := s.LoadRefreshToken(ctx, u.ID)
	if err != nil || gotToken != token {
		t.Fatalf("token = %+v %v", gotToken, err)
	}
	gotSession, err := s.SessionByHash(ctx, sess.TokenHash)
	if err != nil || gotSession != sess {
		t.Fatalf("session = %+v %v", gotSession, err)
	}
	status, err := s.TourStatus(ctx, u.ID)
	if err != nil || status != "" {
		t.Fatalf("initial status = %q %v", status, err)
	}
	if err := s.SaveTourStatus(ctx, u.ID, "done"); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveTourStatus(ctx, u.ID, "started"); err == nil {
		t.Fatal("accepted invalid status")
	}
	if _, err := s.UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "renamed"}); err != nil {
		t.Fatal(err)
	}
	status, err = s.TourStatus(ctx, u.ID)
	if err != nil || status != "done" {
		t.Fatalf("preserved status = %q %v", status, err)
	}
	users, err = app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		t.Fatal(err)
	}
	if users.ListRule != nil || users.ViewRule != nil || users.CreateRule != nil || users.UpdateRule != nil || users.DeleteRule != nil {
		t.Fatal("user collection is public")
	}
	field := users.Fields.GetByName("tour_status")
	if field == nil || !field.GetHidden() {
		t.Fatal("tour status is not hidden")
	}
}

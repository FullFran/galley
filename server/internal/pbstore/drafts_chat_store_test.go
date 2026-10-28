package pbstore_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/chat"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/pbstore"
)

var draftChatCollections = []string{pbstore.DraftsCollection, pbstore.ChatMessagesCollection, pbstore.ChatReadsCollection}

func TestDraftAndChatCollectionsAreSuperuserOnly(t *testing.T) {
	_, app := newStore(t)
	for _, name := range draftChatCollections {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if c.ListRule != nil || c.ViewRule != nil || c.CreateRule != nil || c.UpdateRule != nil || c.DeleteRule != nil {
			t.Errorf("%s has a non-nil API rule", name)
		}
	}
	for name, field := range map[string]string{pbstore.DraftsCollection: "content", pbstore.ChatMessagesCollection: "body"} {
		c, _ := app.FindCollectionByNameOrId(name)
		if f := c.Fields.GetByName(field); f == nil || !f.GetHidden() {
			t.Errorf("%s.%s is not hidden", name, field)
		}
	}
}

func TestDraftAndChatCollectionsDenyAnonymousRecordAPI(t *testing.T) {
	for _, name := range draftChatCollections {
		for _, sc := range []tests.ApiScenario{
			{Name: name + " list", Method: http.MethodGet, URL: "/api/collections/" + name + "/records"},
			{Name: name + " create", Method: http.MethodPost, URL: "/api/collections/" + name + "/records", Body: jsonBody(`{"path":"a"}`)},
			{Name: name + " view", Method: http.MethodGet, URL: "/api/collections/" + name + "/records/abcdefghijklmn0"},
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

func TestDraftStorePutIsCompareAndSet(t *testing.T) {
	users, app := newStore(t)
	alice, _ := users.UpsertUser(ctx, auth.GitHubUser{ID: 1, Login: "alice"})
	s := pbstore.NewDraftStore(app)
	at := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	r := drafts.Record{ID: "draft0000000001", Owner: alice.ID, RepoID: 7, Path: "a.qmd",
		BaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Content: "sealed", Size: 1, Version: "v1v1v1v1", UpdatedAt: at}
	lim := drafts.Limits{MaxDrafts: 10, MaxOwnerDrafts: 10, MaxOwnerBytes: 100}
	if err := s.Put(ctx, r, drafts.Precondition{}, lim, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(ctx, r, drafts.Precondition{}, lim, nil); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("second create = %v", err)
	}
	r2 := r
	r2.UpdatedAt = at.Add(time.Second)
	if err := s.Put(ctx, r2, drafts.Precondition{At: at.Add(time.Millisecond)}, lim, nil); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("stale expected = %v", err)
	}
	r3 := r2
	r3.ID = "draft0000000002"
	if err := s.Put(ctx, r3, drafts.Precondition{At: at}, lim, nil); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("other id = %v", err)
	}
	if err := s.Put(ctx, r2, drafts.Precondition{At: at, Version: "other000"}, lim, nil); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("other id = %v", err)
	}
	if err := s.Put(ctx, r2, drafts.Precondition{At: at, Version: "v1v1v1v1"}, lim, nil); err != nil {
		t.Errorf("matching expected = %v", err)
	}
	got, _ := s.Draft(ctx, alice.ID, 7, "a.qmd")
	if !got.UpdatedAt.Equal(r2.UpdatedAt) {
		t.Errorf("updated_at = %v", got.UpdatedAt)
	}
	list, _ := s.Drafts(ctx, alice.ID, 7, 10)
	if len(list) != 1 || list[0].Content != "" || list[0].Size != 1 {
		t.Errorf("listing = %+v", list)
	}
	n, err := s.DeleteIdle(ctx, at.Add(time.Second))
	if err != nil || n != 0 {
		t.Errorf("idle before its update = %d, %v", n, err)
	}
	if n, _ := s.DeleteIdle(ctx, at.Add(time.Second+time.Millisecond)); n != 1 {
		t.Errorf("idle after = %d", n)
	}
}

func TestChatStoreSequenceIsUniquePerRepo(t *testing.T) {
	users, app := newStore(t)
	alice, _ := users.UpsertUser(ctx, auth.GitHubUser{ID: 1, Login: "alice"})
	s := pbstore.NewChatStore(app)
	for i, repo := range []int64{7, 7, 8} {
		seq, err := s.Append(ctx, chat.Record{ID: "message0000000" + string(rune('a'+i)), RepoID: repo, Author: alice.ID, Body: "x", CreatedAt: time.Now()})
		if err != nil {
			t.Fatal(err)
		}
		want := map[int]int64{0: 1, 1: 2, 2: 1}[i]
		if seq != want {
			t.Errorf("append %d seq = %d, want %d", i, seq, want)
		}
	}
	col, _ := app.FindCollectionByNameOrId(pbstore.ChatMessagesCollection)
	dup := core.NewRecord(col)
	dup.Set("repo_id", 7)
	dup.Set("seq", 2)
	dup.Set("body", "x")
	dup.Set("created_at", time.Now())
	if err := app.Save(dup); err == nil {
		t.Error("duplicate (repo_id, seq) saved")
	}
}

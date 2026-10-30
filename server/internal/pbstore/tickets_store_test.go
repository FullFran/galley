package pbstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/tickets"
)

func TestTicketStore(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	ctx := context.Background()
	u, err := New(app).UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "ana"})
	if err != nil {
		t.Fatal(err)
	}
	s := NewTicketStore(app)
	longest := tickets.Record{
		Ref: "GL-AAAAAA", UserID: u.ID, Login: "ana", Category: "bug", Status: tickets.StatusNew,
		Description: "sealed", Version: strings.Repeat("é", tickets.MaxVersion), Device: strings.Repeat("é", tickets.MaxDevice),
		Diagnostics: strings.Repeat("x", 22<<10),
	}
	if err := s.CreateTicket(ctx, longest, time.Now().Add(-time.Hour), 100); err != nil {
		t.Fatalf("the longest ticket: %v", err)
	}
	if err := s.CreateTicket(ctx, longest, time.Now().Add(-time.Hour), 100); !errors.Is(err, comments.ErrConflict) {
		t.Fatalf("same reference = %v", err)
	}
	later := tickets.Record{Ref: "GL-BBBBBB", UserID: u.ID, Login: "ana", Category: "other", Status: tickets.StatusClosed, Description: "sealed"}
	if err := s.CreateTicket(ctx, later, time.Now().Add(-time.Hour), 100); err != nil {
		t.Fatal(err)
	}

	list, total, err := s.ListTickets(ctx, "", 1, 0)
	if err != nil || total != 2 || len(list) != 1 {
		t.Fatalf("limited list = %v %d %v", list, total, err)
	}
	if list, total, err = s.ListTickets(ctx, tickets.StatusClosed, 10, 0); err != nil || total != 1 || list[0].Ref != "GL-BBBBBB" {
		t.Fatalf("closed = %v %d %v", list, total, err)
	}
	if list[0].CreatedAt.IsZero() {
		t.Fatal("no creation time")
	}
	if list, total, err = s.ListTickets(ctx, "", 10, 1); err != nil || total != 2 || len(list) != 1 {
		t.Fatalf("offset = %v %d %v", list, total, err)
	}
	n, err := s.CountTicketsSince(ctx, time.Now().Add(-time.Hour))
	if err != nil || n != 2 {
		t.Fatalf("since an hour ago = %d %v", n, err)
	}
	if n, err = s.CountTicketsSince(ctx, time.Now().Add(time.Hour)); err != nil || n != 0 {
		t.Fatalf("since the future = %d %v", n, err)
	}

	got, err := s.UpdateTicket(ctx, longest.Ref, tickets.StatusIssue, 7)
	if err != nil || got.Status != tickets.StatusIssue || got.GitHubIssue != 7 {
		t.Fatalf("update = %+v %v", got, err)
	}
	if got, err = s.UpdateTicket(ctx, longest.Ref, tickets.StatusClosed, 0); err != nil || got.GitHubIssue != 7 {
		t.Fatalf("zero keeps the link = %+v %v", got, err)
	}
	if _, err := s.UpdateTicket(ctx, "GL-ZZZZZZ", tickets.StatusClosed, 0); !errors.Is(err, comments.ErrNotFound) {
		t.Fatalf("missing = %v", err)
	}
	if _, err := s.TicketByRef(ctx, "GL-ZZZZZZ"); !errors.Is(err, comments.ErrNotFound) {
		t.Fatalf("missing by ref = %v", err)
	}

	// Being listed is the whole test; the account's name or a repository role is not.
	if ok, err := s.IsTicketAdmin(ctx, u.ID); err != nil || ok {
		t.Fatalf("unlisted = %v %v", ok, err)
	}
	col, err := app.FindCollectionByNameOrId(TicketAdminsCollection)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", u.ID)
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.IsTicketAdmin(ctx, u.ID); err != nil || !ok {
		t.Fatalf("listed = %v %v", ok, err)
	}

	// The account goes: the ticket stays with its login, the admin row does not.
	userRec, err := app.FindRecordById(UsersCollection, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Delete(userRec); err != nil {
		t.Fatal(err)
	}
	kept, err := s.TicketByRef(ctx, longest.Ref)
	if err != nil || kept.UserID != "" || kept.Login != "ana" {
		t.Fatalf("after the account = %+v %v", kept, err)
	}
	if ok, err := s.IsTicketAdmin(ctx, u.ID); err != nil || ok {
		t.Fatalf("deleted admin = %v %v", ok, err)
	}
}

func TestTicketCollectionsAreClosedToTheRecordsAPI(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	for _, name := range []string{TicketsCollection, TicketAdminsCollection} {
		c, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatal(err)
		}
		if c.ListRule != nil || c.ViewRule != nil || c.CreateRule != nil || c.UpdateRule != nil || c.DeleteRule != nil {
			t.Errorf("%s has an open API rule", name)
		}
	}
}

func TestDailyCapHoldsUnderParallelSends(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	ctx := context.Background()
	u, err := New(app).UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "ana"})
	if err != nil {
		t.Fatal(err)
	}
	s := NewTicketStore(app)
	since := time.Now().Add(-time.Hour)
	var wg sync.WaitGroup
	var stored, refused atomic.Int32
	for i := range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := tickets.Record{Ref: fmt.Sprintf("GL-%06d", i), UserID: u.ID, Login: "ana", Category: "bug", Status: tickets.StatusNew, Description: "sealed"}
			switch err := s.CreateTicket(ctx, r, since, 10); {
			case err == nil:
				stored.Add(1)
			case errors.Is(err, tickets.ErrDailyCap):
				refused.Add(1)
			default:
				t.Errorf("create: %v", err)
			}
		}()
	}
	wg.Wait()
	if stored.Load() != 10 || refused.Load() != 20 {
		t.Fatalf("stored %d, refused %d", stored.Load(), refused.Load())
	}
	if n, err := s.CountTicketsSince(ctx, since); err != nil || n != 10 {
		t.Fatalf("count = %d %v", n, err)
	}
}

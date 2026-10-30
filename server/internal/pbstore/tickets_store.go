package pbstore

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/tickets"
)

// Ticket collection names.
const (
	TicketsCollection      = "galley_tickets"
	TicketAdminsCollection = "galley_ticket_admins"
)

// maxSealedField fits the longest sealed ticket field: 16 KB of diagnostics,
// base64 and the seal's overhead.
const maxSealedField = 32 << 10

// As for every galley collection, the API rules stay nil (superusers only). A
// superuser names the ticket admins in the dashboard, so nobody can name
// themselves. A ticket outlives its author's account: the relation empties and
// the login stays.
func init() {
	core.AppMigrations.Register(createTicketCollections,
		dropCollections(TicketAdminsCollection, TicketsCollection),
		"1793707200_galley_tickets.go")
}

func createTicketCollections(app core.App) error {
	users, err := app.FindCollectionByNameOrId(UsersCollection)
	if err != nil {
		return err
	}
	c := core.NewBaseCollection(TicketsCollection)
	c.Fields.Add(
		&core.TextField{Name: "ref", Required: true, Max: 16},
		&core.RelationField{Name: "user", CollectionId: users.Id, MaxSelect: 1},
		&core.TextField{Name: "login", Required: true, Max: 100},
		&core.SelectField{Name: "category", Required: true, MaxSelect: 1, Values: tickets.Categories},
		&core.SelectField{Name: "status", Required: true, MaxSelect: 1, Values: tickets.Statuses},
		&core.TextField{Name: "description", Required: true, Hidden: true, Max: maxSealedField},
		&core.TextField{Name: "steps", Hidden: true, Max: maxSealedField},
		&core.TextField{Name: "diagnostics", Hidden: true, Max: maxSealedField},
		&core.TextField{Name: "version", Max: tickets.MaxVersion},
		&core.TextField{Name: "device", Max: tickets.MaxDevice},
		&core.NumberField{Name: "github_issue", OnlyInt: true},
		&core.AutodateField{Name: "created", OnCreate: true},
		&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
	)
	c.AddIndex("idx_galley_tickets_ref", true, "ref", "")
	c.AddIndex("idx_galley_tickets_status_created", false, "status, created", "")
	c.AddIndex("idx_galley_tickets_created", false, "created", "")
	if err := app.Save(c); err != nil {
		return err
	}
	admins := core.NewBaseCollection(TicketAdminsCollection)
	admins.Fields.Add(
		&core.RelationField{Name: "user", Required: true, CollectionId: users.Id, MaxSelect: 1, CascadeDelete: true},
		&core.AutodateField{Name: "created", OnCreate: true},
	)
	admins.AddIndex("idx_galley_ticket_admins_user", true, "user", "")
	return app.Save(admins)
}

// TicketStore implements tickets.Store on PocketBase.
type TicketStore struct{ app core.App }

var _ tickets.Store = (*TicketStore)(nil)

// NewTicketStore returns the store.
func NewTicketStore(app core.App) *TicketStore { return &TicketStore{app: app} }

// CreateTicket saves r, or returns comments.ErrConflict when its reference is
// taken and tickets.ErrDailyCap when dailyCap tickets exist since the given
// time. The transaction runs on PocketBase's single writer connection, so
// parallel sends cannot overshoot the cap.
func (s *TicketStore) CreateTicket(_ context.Context, r tickets.Record, since time.Time, dailyCap int) error {
	col, err := s.app.FindCollectionByNameOrId(TicketsCollection)
	if err != nil {
		return err
	}
	return s.app.RunInTransaction(func(tx core.App) error {
		today, err := countSince(tx, since)
		if err != nil {
			return err
		}
		if today >= dailyCap {
			return tickets.ErrDailyCap
		}
		_, err = tx.FindFirstRecordByData(TicketsCollection, "ref", r.Ref)
		if err == nil {
			return comments.ErrConflict
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		rec := core.NewRecord(col)
		rec.Load(map[string]any{
			"ref":         r.Ref,
			"user":        r.UserID,
			"login":       r.Login,
			"category":    r.Category,
			"status":      r.Status,
			"description": r.Description,
			"steps":       r.Steps,
			"diagnostics": r.Diagnostics,
			"version":     r.Version,
			"device":      r.Device,
		})
		return tx.Save(rec)
	})
}

// ListTickets returns one page of the newest tickets, and how many match in all.
func (s *TicketStore) ListTickets(_ context.Context, status string, limit, offset int) ([]tickets.Record, int, error) {
	filter, params, conditions := "", dbx.Params{}, []dbx.Expression{}
	if status != "" {
		filter, params["status"] = "status = {:status}", status
		conditions = append(conditions, dbx.HashExp{"status": status})
	}
	records, err := s.app.FindRecordsByFilter(TicketsCollection, filter, "-created,-id", limit, offset, params)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.app.CountRecords(TicketsCollection, conditions...)
	if err != nil {
		return nil, 0, err
	}
	out := make([]tickets.Record, 0, len(records))
	for _, r := range records {
		out = append(out, ticketRecord(r))
	}
	return out, int(total), nil
}

// TicketByRef returns one ticket or comments.ErrNotFound.
func (s *TicketStore) TicketByRef(_ context.Context, ref string) (tickets.Record, error) {
	rec, err := s.app.FindFirstRecordByData(TicketsCollection, "ref", ref)
	if err != nil {
		return tickets.Record{}, ticketNotFound(err)
	}
	return ticketRecord(rec), nil
}

// UpdateTicket sets the status, and the link unless issue is zero.
func (s *TicketStore) UpdateTicket(_ context.Context, ref, status string, issue int) (tickets.Record, error) {
	var out tickets.Record
	err := s.app.RunInTransaction(func(tx core.App) error {
		rec, err := tx.FindFirstRecordByData(TicketsCollection, "ref", ref)
		if err != nil {
			return ticketNotFound(err)
		}
		rec.Set("status", status)
		if issue > 0 {
			rec.Set("github_issue", issue)
		}
		if err := tx.Save(rec); err != nil {
			return err
		}
		out = ticketRecord(rec)
		return nil
	})
	return out, err
}

// CountTicketsSince counts the tickets created from t on.
func (s *TicketStore) CountTicketsSince(_ context.Context, t time.Time) (int, error) {
	return countSince(s.app, t)
}

func countSince(app core.App, t time.Time) (int, error) {
	n, err := app.CountRecords(TicketsCollection, dbx.NewExp("created >= {:start}", dbx.Params{"start": t.UTC().Format(types.DefaultDateLayout)}))
	return int(n), err
}

// IsTicketAdmin reports whether the user is listed as a ticket admin.
func (s *TicketStore) IsTicketAdmin(_ context.Context, userID string) (bool, error) {
	_, err := s.app.FindFirstRecordByData(TicketAdminsCollection, "user", userID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func ticketRecord(r *core.Record) tickets.Record {
	return tickets.Record{
		Ref:         r.GetString("ref"),
		UserID:      r.GetString("user"),
		Login:       r.GetString("login"),
		Category:    r.GetString("category"),
		Status:      r.GetString("status"),
		Description: r.GetString("description"),
		Steps:       r.GetString("steps"),
		Diagnostics: r.GetString("diagnostics"),
		Version:     r.GetString("version"),
		Device:      r.GetString("device"),
		GitHubIssue: r.GetInt("github_issue"),
		CreatedAt:   r.GetDateTime("created").Time(),
	}
}

func ticketNotFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return comments.ErrNotFound
	}
	return err
}

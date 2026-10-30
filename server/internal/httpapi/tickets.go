package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/tickets"
)

// TicketsPrefix is the ticket admins' inbox.
const TicketsPrefix = "/api/galley/tickets"

// maxTicketBody is the largest ticket request read: 2 × 2000 characters of
// text at up to 4 bytes each, 16 KB of diagnostics and room for JSON escaping.
const maxTicketBody = 32 << 10

// TicketsService is what the ticket routes need (tickets.Service).
type TicketsService interface {
	Create(ctx context.Context, a comments.Actor, in tickets.Input) (string, error)
	Access(ctx context.Context, a comments.Actor) bool
	List(ctx context.Context, a comments.Actor, status string, offset int) (tickets.List, error)
	Update(ctx context.Context, a comments.Actor, ref string, c tickets.Change) (tickets.Ticket, error)
}

var _ TicketsService = (*tickets.Service)(nil)

type ticketJSON struct {
	Ref         string          `json:"ref"`
	Login       string          `json:"login"`
	Category    string          `json:"category"`
	Status      string          `json:"status"`
	Description string          `json:"description"`
	Steps       string          `json:"steps"`
	Version     string          `json:"version"`
	Device      string          `json:"device"`
	Diagnostics json.RawMessage `json:"diagnostics"`
	GitHubIssue int             `json:"github_issue"`
	Created     time.Time       `json:"created"`
	Unreadable  bool            `json:"unreadable"`
}

func toTicketJSON(t tickets.Ticket) ticketJSON {
	out := ticketJSON{
		Ref: t.Ref, Login: t.Login, Category: t.Category, Status: t.Status, Description: t.Description, Steps: t.Steps,
		Version: t.Version, Device: t.Device, Diagnostics: t.Diagnostics, GitHubIssue: t.GitHubIssue, Created: t.CreatedAt, Unreadable: t.Unreadable,
	}
	if len(out.Diagnostics) == 0 {
		out.Diagnostics = json.RawMessage("null")
	}
	return out
}

// POST /api/galley/me/tickets stores a ticket and answers {"ref"}.
// GET /api/galley/me/tickets/access answers {"admin"}, so the UI can tell
// whether to offer the inbox; the inbox routes check on every call anyway.
func registerTickets(r *router.Router[*core.RequestEvent], me *router.RouterGroup[*core.RequestEvent], d Deps) {
	me.POST("/tickets", withActor(d, func(e *core.RequestEvent, a comments.Actor) error {
		var in struct {
			Category    string          `json:"category"`
			Description string          `json:"description"`
			Steps       string          `json:"steps"`
			Version     string          `json:"version"`
			Device      string          `json:"device"`
			Diagnostics json.RawMessage `json:"diagnostics"`
		}
		if status := decodeJSONLimit(e.Request, &in, maxTicketBody); status != 0 {
			return errorJSON(e, status)
		}
		ref, err := d.Tickets.Create(e.Request.Context(), a, tickets.Input{
			Category: in.Category, Description: in.Description, Steps: in.Steps, Version: in.Version, Device: in.Device, Diagnostics: in.Diagnostics,
		})
		if err != nil {
			return failJSON(d, e, err, "tickets")
		}
		return e.JSON(http.StatusCreated, map[string]string{"ref": ref})
	}))
	me.GET("/tickets/access", withActor(d, func(e *core.RequestEvent, a comments.Actor) error {
		return e.JSON(http.StatusOK, map[string]bool{"admin": d.Tickets.Access(e.Request.Context(), a)})
	}))

	inbox := credentialedGroup(r, TicketsPrefix, d.FrontendOrigin, credentialedMethods)
	inbox.GET("/inbox", withActor(d, func(e *core.RequestEvent, a comments.Actor) error {
		q := e.Request.URL.Query()
		offset := 0
		if raw := q.Get("offset"); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil {
				return failJSON(d, e, &comments.ValidationError{Field: "offset"}, "tickets")
			}
			offset = n
		}
		list, err := d.Tickets.List(e.Request.Context(), a, q.Get("status"), offset)
		if err != nil {
			return failJSON(d, e, err, "tickets")
		}
		out := struct {
			Tickets []ticketJSON `json:"tickets"`
			Total   int          `json:"total"`
		}{Tickets: make([]ticketJSON, 0, len(list.Tickets)), Total: list.Total}
		for _, t := range list.Tickets {
			out.Tickets = append(out.Tickets, toTicketJSON(t))
		}
		return e.JSON(http.StatusOK, out)
	}))
	inbox.PATCH("/inbox/{ref}", withActor(d, func(e *core.RequestEvent, a comments.Actor) error {
		var in struct {
			Status      string `json:"status"`
			GitHubIssue int    `json:"github_issue"`
		}
		if status := decodeJSONLimit(e.Request, &in, 1024); status != 0 {
			return errorJSON(e, status)
		}
		t, err := d.Tickets.Update(e.Request.Context(), a, e.Request.PathValue("ref"), tickets.Change{Status: in.Status, GitHubIssue: in.GitHubIssue})
		if err != nil {
			return failJSON(d, e, err, "tickets")
		}
		return e.JSON(http.StatusOK, toTicketJSON(t))
	}))
}

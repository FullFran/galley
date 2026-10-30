// Package httpapi registers galley's custom HTTP routes on the PocketBase router.
package httpapi

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// HealthPath is the liveness endpoint.
const HealthPath = "/api/galley/health"

// Deps are the collaborators and settings the routes need.
type Deps struct {
	Auth AuthService
	// FrontendOrigin is the exact browser origin allowed to call the API.
	FrontendOrigin string
	// WebhookSecret verifies GitHub webhook signatures.
	WebhookSecret []byte
	// Logger defaults to slog.Default. Never given tokens, codes, cookies or
	// comment text.
	Logger *slog.Logger
	// Comments enables the comment routes when set.
	Comments CommentsService
	// Drafts enables the draft routes when set.
	Drafts DraftsService
	// Chat enables the chat routes when set (see ChatAdapter).
	Chat ChatService
	// Admin enables the admin and draft-sharing routes when set.
	Admin AdminService
	// Notify enables the notification routes when set.
	Notify NotifyService
	// Tour enables authenticated per-user onboarding state when set.
	Tour TourStore
	// Tickets enables the ticket routes when set.
	Tickets TicketsService
	// ChatHeartbeat is how often a chat stream sends a heartbeat comment and
	// re-checks the session and repository access; defaults to
	// DefaultChatHeartbeat.
	ChatHeartbeat time.Duration
	// OnAccessChange, when set, runs after GitHub webhooks that can change
	// repository permissions (installation, membership, repository), so
	// cached permissions are dropped.
	OnAccessChange func()
}

// Register adds galley routes to r.
func Register(r *router.Router[*core.RequestEvent], d Deps) {
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	r.GET(HealthPath, health)
	registerAuth(r, d)
	if d.Notify != nil || d.Tour != nil || d.Tickets != nil {
		me := credentialedGroup(r, MePrefix, d.FrontendOrigin, credentialedMethods)
		if d.Notify != nil {
			registerNotifyMe(me, d)
		}
		if d.Tour != nil {
			registerTour(me, d)
		}
		if d.Tickets != nil {
			registerTickets(r, me, d)
		}
	}
	if d.Comments == nil && d.Drafts == nil && d.Chat == nil && d.Admin == nil && d.Notify == nil {
		return
	}
	// One group per prefix: its CORS middleware and OPTIONS route are shared
	// by comments, drafts, chat and admin.
	repos := credentialedGroup(r, ReposPrefix, d.FrontendOrigin, credentialedMethods)
	if d.Comments != nil {
		registerComments(r, repos, d)
	}
	if d.Drafts != nil {
		registerDrafts(repos, d)
	}
	if d.Chat != nil {
		registerChat(repos, d)
	}
	if d.Admin != nil {
		registerAdmin(repos, d)
	}
	if d.Notify != nil {
		registerNotify(r, repos, d)
	}
}

func health(e *core.RequestEvent) error {
	return e.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

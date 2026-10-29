package httpapi

import (
	"context"
	"errors"
	"html"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
)

// Notification route prefixes.
const (
	MePrefix        = "/api/galley/me"
	UnsubscribePath = "/api/galley/unsubscribe"
	VerifyPath      = MePrefix + "/notifications/verify"
)

// maxNotifyBody bounds notification request bodies.
const maxNotifyBody = 4 << 10

// NotifyService is the part of notify.Service the handlers use.
type NotifyService interface {
	Settings(ctx context.Context, a comments.Actor) (notify.Settings, error)
	UpdateSettings(ctx context.Context, a comments.Actor, in notify.Update) (notify.Settings, error)
	Verify(ctx context.Context, token string) error
	Unsubscribe(ctx context.Context, token string) error
	ReviewRequested(ctx context.Context, a comments.Actor, repoID int64, number int, reviewer string) (notify.Result, error)
	Assigned(ctx context.Context, a comments.Actor, repoID int64, number int, pullRequest bool, assignee string) (notify.Result, error)
}

var _ NotifyService = (*notify.Service)(nil)

type notifyHandlers struct{ Deps }

func registerNotify(r *router.Router[*core.RequestEvent], repos *router.RouterGroup[*core.RequestEvent], d Deps) {
	h := notifyHandlers{d}
	// Opened from the mail: no Origin and no session; the signed token is
	// the authorization. GET only shows a button (mail scanners fetch
	// links); POST verifies.
	r.GET(VerifyPath, h.verifyForm)
	r.POST(VerifyPath, h.verify)
	r.GET(UnsubscribePath, h.unsubscribeForm)
	r.POST(UnsubscribePath, h.unsubscribe)

	repos.POST("/{repo_id}/notify/review-requested", withActor(d, h.reviewRequested))
	repos.POST("/{repo_id}/notify/assigned", withActor(d, h.assigned))
}

func registerNotifyMe(me *router.RouterGroup[*core.RequestEvent], d Deps) {
	h := notifyHandlers{d}
	me.GET("/notifications", withActor(d, h.settings))
	me.PUT("/notifications", withActor(d, h.update))
}

func withActor(d Deps, fn actorHandler) func(*core.RequestEvent) error {
	return withSession(d, func(e *core.RequestEvent, a comments.Actor, _ string) error { return fn(e, a) })
}

type settingsJSON struct {
	Available bool          `json:"available"`
	Email     string        `json:"email"`
	Verified  bool          `json:"verified"`
	Enabled   bool          `json:"enabled"`
	Kinds     []notify.Kind `json:"kinds"`
}

func toSettingsJSON(s notify.Settings) settingsJSON {
	if s.Kinds == nil {
		s.Kinds = []notify.Kind{}
	}
	return settingsJSON{Available: s.Available, Email: s.Email, Verified: s.Verified, Enabled: s.Enabled, Kinds: s.Kinds}
}

func (h notifyHandlers) settings(e *core.RequestEvent, a comments.Actor) error {
	s, err := h.Notify.Settings(e.Request.Context(), a)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, toSettingsJSON(s))
}

func (h notifyHandlers) update(e *core.RequestEvent, a comments.Actor) error {
	var in struct {
		Email   string         `json:"email"`
		Enabled bool           `json:"enabled"`
		Kinds   *[]notify.Kind `json:"kinds"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxNotifyBody); status != 0 {
		return errorJSON(e, status)
	}
	u := notify.Update{Email: in.Email, Enabled: in.Enabled}
	if in.Kinds != nil {
		u.Kinds = *in.Kinds
		if u.Kinds == nil {
			u.Kinds = []notify.Kind{}
		}
	}
	s, err := h.Notify.UpdateSettings(e.Request.Context(), a, u)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, toSettingsJSON(s))
}

func (h notifyHandlers) reviewRequested(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	var in struct {
		PRNumber      int    `json:"pr_number"`
		ReviewerLogin string `json:"reviewer_login"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxNotifyBody); status != 0 {
		return errorJSON(e, status)
	}
	res, err := h.Notify.ReviewRequested(e.Request.Context(), a, repoID, in.PRNumber, in.ReviewerLogin)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusAccepted, map[string]string{"status": res.Status})
}

func (h notifyHandlers) assigned(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	var in struct {
		PRNumber      int    `json:"pr_number"`
		IssueNumber   int    `json:"issue_number"`
		AssigneeLogin string `json:"assignee_login"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxNotifyBody); status != 0 {
		return errorJSON(e, status)
	}
	if (in.PRNumber == 0) == (in.IssueNumber == 0) {
		return e.JSON(http.StatusUnprocessableEntity, map[string]string{"error": http.StatusText(http.StatusUnprocessableEntity), "field": "number"})
	}
	number, pr := in.IssueNumber, false
	if in.PRNumber != 0 {
		number, pr = in.PRNumber, true
	}
	res, err := h.Notify.Assigned(e.Request.Context(), a, repoID, number, pr, in.AssigneeLogin)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusAccepted, map[string]string{"status": res.Status})
}

func (h notifyHandlers) verifyForm(e *core.RequestEvent) error {
	tok := html.EscapeString(e.Request.URL.Query().Get("token"))
	return page(e, http.StatusOK, "Confirm address", `<form method="post" action="`+VerifyPath+`?token=`+tok+`">`+
		`<p>Send galley notifications for direct requests to this address?</p><button type="submit">Confirm</button></form>`)
}

func (h notifyHandlers) verify(e *core.RequestEvent) error {
	if err := h.Notify.Verify(e.Request.Context(), e.Request.URL.Query().Get("token")); err != nil {
		return h.linkFailed(e, err)
	}
	return page(e, http.StatusOK, "Address confirmed", "<p>Your address is confirmed. galley will email you only when someone asks you directly (a review request or an assignment).</p>")
}

// unsubscribeForm only shows a button: GET must not unsubscribe, because
// mail scanners and link previews fetch links.
func (h notifyHandlers) unsubscribeForm(e *core.RequestEvent) error {
	tok := html.EscapeString(e.Request.URL.Query().Get("token"))
	return page(e, http.StatusOK, "Unsubscribe", `<form method="post" action="`+UnsubscribePath+`?token=`+tok+`">`+
		`<p>Stop all galley emails to this address?</p><button type="submit">Unsubscribe</button></form>`)
}

// unsubscribe handles the button and RFC 8058 one-click POSTs, whose token
// is in the URL of the List-Unsubscribe header.
func (h notifyHandlers) unsubscribe(e *core.RequestEvent) error {
	tok := e.Request.URL.Query().Get("token")
	if err := h.Notify.Unsubscribe(e.Request.Context(), tok); err != nil {
		return h.linkFailed(e, err)
	}
	return page(e, http.StatusOK, "Unsubscribed", "<p>You will not get galley emails any more. You can turn them on again in galley.</p>")
}

func (h notifyHandlers) linkFailed(e *core.RequestEvent, err error) error {
	if errors.Is(err, comments.ErrNotFound) {
		return page(e, http.StatusBadRequest, "Link not valid", "<p>This link is not valid any more. Ask for a new one in galley.</p>")
	}
	h.Logger.Error("notification link failed", "error", err)
	return page(e, http.StatusServiceUnavailable, "Try again later", "<p>Something went wrong. Try the link again later.</p>")
}

// page renders a tiny static HTML page that loads nothing.
func page(e *core.RequestEvent, status int, title, body string) error {
	w := e.Response.Header()
	w.Set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'")
	w.Set("Cache-Control", "no-store")
	w.Set("Referrer-Policy", "no-referrer")
	w.Set("X-Content-Type-Options", "nosniff")
	return e.HTML(status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">`+
		`<title>galley: `+html.EscapeString(title)+`</title></head><body><h1>`+html.EscapeString(title)+`</h1>`+body+`</body></html>`)
}

func (h notifyHandlers) fail(e *core.RequestEvent, err error) error {
	if errors.Is(err, notify.ErrDisabled) {
		return e.JSON(http.StatusConflict, map[string]string{"error": http.StatusText(http.StatusConflict), "reason": "disabled"})
	}
	return failJSON(h.Deps, e, err, "notifications")
}

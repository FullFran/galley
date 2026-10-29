package httpapi

import (
	"context"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/comments"
)

// TourVersion identifies the welcome tour. Not started is an absent status,
// not a persisted terminal state. A new tour version needs an explicit migration.
const TourVersion = 1

// TourStore persists only the authenticated user's terminal tour status.
type TourStore interface {
	TourStatus(context.Context, string) (string, error)
	SaveTourStatus(context.Context, string, string) error
}

type tourJSON struct {
	Version int     `json:"version"`
	Status  *string `json:"status"`
}

// GET /api/galley/me/tour returns {version:1,status:null|"done"|"skipped"}.
// PUT accepts {version:1,status:"done"|"skipped"} and returns that state.
// Both require the exact frontend Origin and a session; PUT also requires
// X-Galley-CSRF: 1. Unknown fields (including user IDs) are rejected.
func registerTour(me *router.RouterGroup[*core.RequestEvent], d Deps) {
	me.GET("/tour", withActor(d, func(e *core.RequestEvent, a comments.Actor) error {
		status, err := d.Tour.TourStatus(e.Request.Context(), a.UserID)
		if err != nil {
			return failJSON(d, e, err, "tour")
		}
		out := tourJSON{Version: TourVersion}
		if status != "" {
			out.Status = &status
		}
		return e.JSON(http.StatusOK, out)
	}))
	me.PUT("/tour", withActor(d, func(e *core.RequestEvent, a comments.Actor) error {
		var in tourJSON
		if status := decodeJSONLimit(e.Request, &in, 1024); status != 0 {
			return errorJSON(e, status)
		}
		if in.Version != TourVersion {
			return failJSON(d, e, &comments.ValidationError{Field: "version"}, "tour")
		}
		if in.Status == nil || (*in.Status != "done" && *in.Status != "skipped") {
			return failJSON(d, e, &comments.ValidationError{Field: "status"}, "tour")
		}
		if err := d.Tour.SaveTourStatus(e.Request.Context(), a.UserID, *in.Status); err != nil {
			return failJSON(d, e, err, "tour")
		}
		return e.JSON(http.StatusOK, in)
	}))
}

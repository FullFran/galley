// Package httpapi registers galley's custom HTTP routes on the PocketBase router.
package httpapi

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// HealthPath is the liveness endpoint.
const HealthPath = "/api/galley/health"

// Register adds galley routes to r.
func Register(r *router.Router[*core.RequestEvent]) {
	r.GET(HealthPath, health)
}

func health(e *core.RequestEvent) error {
	return e.JSON(http.StatusOK, map[string]string{"status": "ok"})
}

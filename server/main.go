// Command server runs the galley API: PocketBase used as a Go framework plus
// galley's custom routes.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/config"
	"github.com/FullFran/galley/server/internal/github"
	"github.com/FullFran/galley/server/internal/httpapi"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/secret"
)

const (
	sessionTTL = 30 * 24 * time.Hour
	loginTTL   = 10 * time.Minute
)

func main() {
	app := pocketbase.New()

	// Configuration is loaded when serving, so PocketBase's admin commands
	// (for example "superuser upsert") work without the galley variables.
	// "serve" fails fast when any variable is missing or invalid.
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		deps, err := newDeps(se.App)
		if err != nil {
			return err
		}
		httpapi.Register(se.Router, deps)
		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func newDeps(app core.App) (httpapi.Deps, error) {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return httpapi.Deps{}, err
	}
	sealer, err := secret.NewSealer(cfg.TokenKey)
	if err != nil {
		return httpapi.Deps{}, fmt.Errorf("token key: %w", err)
	}
	store := pbstore.New(app)
	svc, err := auth.NewService(auth.Config{
		Provider: &github.Client{
			ClientID:     cfg.GitHubClientID,
			ClientSecret: cfg.GitHubClientSecret,
			RedirectURI:  cfg.RedirectURI(),
			HTTPClient:   &http.Client{Timeout: 15 * time.Second},
		},
		Users:      store,
		Sessions:   store,
		Sealer:     sealer,
		SessionTTL: sessionTTL,
		LoginTTL:   loginTTL,
	})
	if err != nil {
		return httpapi.Deps{}, err
	}
	return httpapi.Deps{
		Auth:           svc,
		FrontendOrigin: cfg.FrontendOrigin,
		WebhookSecret:  []byte(cfg.WebhookSecret),
		Logger:         app.Logger(),
	}, nil
}

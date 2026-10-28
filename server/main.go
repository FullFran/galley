// Command server runs the galley API: PocketBase used as a Go framework plus
// galley's custom routes.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/config"
	"github.com/FullFran/galley/server/internal/github"
	"github.com/FullFran/galley/server/internal/httpapi"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/secret"
)

const (
	sessionTTL = 30 * 24 * time.Hour
	loginTTL   = 10 * time.Minute
	// accessTTL is how long a user's repository permission is trusted.
	accessTTL = 5 * time.Minute
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
	dataSealer, err := secret.NewSealer(cfg.DataKey)
	if err != nil {
		return httpapi.Deps{}, fmt.Errorf("data key: %w", err)
	}
	gh := &github.Client{
		ClientID:     cfg.GitHubClientID,
		ClientSecret: cfg.GitHubClientSecret,
		RedirectURI:  cfg.RedirectURI(),
		HTTPClient:   &http.Client{Timeout: 15 * time.Second},
	}
	store := pbstore.New(app)

	// Permission checks list the repositories of the user's app
	// installations with the user's own token. The token is minted on the
	// server from the stored refresh token, never leaves the server, is not
	// scoped to a repository, and is reused until shortly before it expires;
	// tokens the browser obtains are shared with the cache through
	// OnTokenIssued, so neither side keeps rotating the pair.
	var svc *auth.Service
	access := comments.NewCachedAccess(comments.AccessConfig{
		Mint: func(ctx context.Context, userID string) (comments.UserToken, error) {
			tok, err := svc.UserAccessToken(ctx, userID, 0)
			if errors.Is(err, auth.ErrUnauthenticated) {
				return comments.UserToken{}, comments.ErrUnauthenticated
			}
			return comments.UserToken{Token: tok.Token, ExpiresAt: tok.ExpiresAt}, err
		},
		Repos: gh,
		TTL:   accessTTL,
	})

	svc, err = auth.NewService(auth.Config{
		Provider:   gh,
		Users:      store,
		Sessions:   store,
		Sealer:     sealer,
		SessionTTL: sessionTTL,
		LoginTTL:   loginTTL,
		OnRevoke:   access.Invalidate,
		OnTokenIssued: func(userID string, tok auth.AccessToken, repositoryID int64) {
			access.TokenIssued(userID, comments.UserToken{Token: tok.Token, ExpiresAt: tok.ExpiresAt}, repositoryID != 0)
		},
	})
	if err != nil {
		return httpapi.Deps{}, err
	}
	commentSvc, err := comments.NewService(comments.Config{
		Store:  pbstore.NewCommentStore(app),
		Access: access,
		Sealer: dataSealer,
	})
	if err != nil {
		return httpapi.Deps{}, err
	}
	return httpapi.Deps{
		Auth:           svc,
		Comments:       commentSvc,
		OnAccessChange: access.InvalidateAll,
		FrontendOrigin: cfg.FrontendOrigin,
		WebhookSecret:  []byte(cfg.WebhookSecret),
		Logger:         app.Logger(),
	}, nil
}

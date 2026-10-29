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

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/chat"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/config"
	"github.com/FullFran/galley/server/internal/drafts"
	"github.com/FullFran/galley/server/internal/github"
	"github.com/FullFran/galley/server/internal/httpapi"
	"github.com/FullFran/galley/server/internal/notify"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/reanchor"
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
		deps, chatSvc, err := newDeps(se.App)
		if err != nil {
			return err
		}
		// Open chat streams would otherwise hold the graceful shutdown.
		se.Server.RegisterOnShutdown(chatSvc.Shutdown)
		httpapi.Register(se.Router, deps)
		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func newDeps(app core.App) (httpapi.Deps, *chat.Service, error) {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	sealer, err := secret.NewSealer(cfg.TokenKey)
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("token key: %w", err)
	}
	dataSealer, err := secret.NewSealer(cfg.DataKey)
	if err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("data key: %w", err)
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
	// server from the stored refresh token, is not scoped to a repository,
	// and is the same token auth.Service hands the browser: one current token
	// per user, reused until shortly before it expires, so no side rotates
	// the pair away from the others.
	var svc *auth.Service
	access := comments.NewCachedAccess(comments.AccessConfig{
		Mint: func(ctx context.Context, userID, rejected string) (comments.UserToken, error) {
			tok, err := svc.UserAccessToken(ctx, userID, rejected)
			if errors.Is(err, auth.ErrUnauthenticated) {
				return comments.UserToken{}, comments.ErrUnauthenticated
			}
			return comments.UserToken{Token: tok.Token, ExpiresAt: tok.ExpiresAt}, err
		},
		Repos: gh,
		TTL:   accessTTL,
	})
	// Every repository-scoped galley API goes through the guard: it records
	// per-repository activity (throttled) and enforces the repository's
	// allowlist on top of the GitHub permission.
	adminStore := pbstore.NewAdminStore(app)
	guard, err := admin.NewGuard(admin.GuardConfig{
		Inner: access,
		Store: adminStore,
		Users: func(ctx context.Context, userID string) (admin.Identity, error) {
			u, err := store.UserByID(ctx, userID)
			return admin.Identity{GitHubID: u.GitHubID, Login: u.Login}, err
		},
		Logger: app.Logger(),
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}

	draftSvc, err := drafts.NewService(drafts.Config{
		Store:  pbstore.NewDraftStore(app),
		Access: guard,
		Sealer: dataSealer,
		Logger: app.Logger(),
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	if err := drafts.ScheduleRetention(app.Cron(), draftSvc, app.Logger()); err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("drafts retention: %w", err)
	}
	chatSvc, err := chat.NewService(chat.Config{
		Store:  pbstore.NewChatStore(app),
		Access: guard,
		Sealer: dataSealer,
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	logger := app.Logger()
	// OnRevoke must not block: the cache and the streams are dropped in
	// memory, and drafts.Service.Revoke purges in the background.
	onRevoke := func(userID string, reason auth.RevokeReason) {
		logger.Warn("auth revoked", "user", userID, "reason", string(reason))
		access.Invalidate(userID)
		chatSvc.CloseUser(userID)
		// Drafts go only when the user revoked the app (webhook). An
		// expired, unreadable or GitHub-rejected refresh token is not the
		// user's choice (a lost rotation also ends in bad_refresh_token):
		// those drafts stay until the 30-day retention.
		if reason.Revoked() {
			draftSvc.Revoke(userID)
		}
	}

	svc, err = auth.NewService(auth.Config{
		Provider:   gh,
		Users:      store,
		Sessions:   store,
		Sealer:     sealer,
		SessionTTL: sessionTTL,
		LoginTTL:   loginTTL,
		OnRevoke:   onRevoke,
		OnTokenIssued: func(userID string, tok auth.AccessToken) {
			access.TokenIssued(userID, comments.UserToken{Token: tok.Token, ExpiresAt: tok.ExpiresAt}, false)
		},
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	// Re-anchoring and notification checks call GitHub with the viewer's or
	// caller's own token, the same cached server-side token as the
	// permission checks.
	userToken := func(ctx context.Context, userID string) (string, error) {
		tok, err := access.Token(ctx, userID)
		return tok.Token, err
	}
	reanchorer, err := reanchor.New(reanchor.Config{GitHub: gh, Token: userToken, Logger: logger})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	commentSvc, err := comments.NewService(comments.Config{
		Store:      pbstore.NewCommentStore(app),
		Access:     guard,
		Sealer:     dataSealer,
		Reanchorer: reanchorer,
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	notifyStore := pbstore.NewNotifyStore(app)
	var mailer notify.Mailer // nil: notifications disabled
	if cfg.MailEnabled() {
		mailer = &notify.ResendMailer{APIKey: cfg.ResendAPIKey, From: cfg.MailFrom, HTTPClient: &http.Client{Timeout: 10 * time.Second}}
	} else {
		logger.Info("email notifications disabled: GALLEY_RESEND_API_KEY or GALLEY_MAIL_FROM is not set")
	}
	notifySvc, err := notify.NewService(notify.Config{
		Store:          notifyStore,
		Users:          notifyStore,
		GitHub:         gh,
		Access:         guard,
		Token:          userToken,
		Mailer:         mailer,
		Sealer:         dataSealer,
		LinkKey:        cfg.LinkKey,
		PublicURL:      cfg.PublicURL,
		FrontendOrigin: cfg.FrontendOrigin,
		Logger:         logger,
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	if err := app.Cron().Add("galley_notify_outbox_purge", "17 3 * * *", func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if _, err := notifySvc.Purge(ctx); err != nil {
			logger.Error("notification outbox purge failed", "error", err)
		}
	}); err != nil {
		return httpapi.Deps{}, nil, fmt.Errorf("notify purge: %w", err)
	}
	adminSvc, err := admin.NewService(admin.Config{
		Guard:  guard,
		Store:  adminStore,
		Drafts: draftSvc,
		// Only galley sessions go; the user's GitHub authorization and
		// tokens are untouched, and open chat streams end at once.
		DeleteSessions: func(ctx context.Context, userID string) error {
			chatSvc.CloseUser(userID)
			return store.DeleteUserSessions(ctx, userID)
		},
		Logger: logger,
	})
	if err != nil {
		return httpapi.Deps{}, nil, err
	}
	return httpapi.Deps{
		Auth:           svc,
		Admin:          adminSvc,
		Comments:       commentSvc,
		Drafts:         draftSvc,
		Chat:           httpapi.ChatAdapter(chatSvc),
		Notify:         notifySvc,
		Tour:           store,
		OnAccessChange: access.InvalidateAll,
		FrontendOrigin: cfg.FrontendOrigin,
		WebhookSecret:  []byte(cfg.WebhookSecret),
		Logger:         logger,
	}, chatSvc, nil
}

package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/auth"
)

// AuthPrefix is the base path of the sign-in routes.
const AuthPrefix = "/api/galley/auth"

// Cookie names. The __Host- prefix makes browsers require Secure, Path=/ and
// no Domain attribute, so the cookies stay bound to the API host.
const (
	LoginCookie   = "__Host-galley_oauth"
	SessionCookie = "__Host-galley_session"
)

// CSRFHeader must be sent with value "1" on state-changing requests. A custom
// header forces a CORS preflight, which only the frontend origin passes.
const CSRFHeader = "X-Galley-CSRF"

const (
	loginCookieMaxAge = 600
	maxTokenBody      = 4 << 10
	maxWebhookBody    = 1 << 20
	corsMiddlewareID  = "galleyAuthCors"
)

// AuthService is the part of auth.Service the handlers use.
type AuthService interface {
	StartLogin() (auth.Login, error)
	Callback(ctx context.Context, cookie, state, code string) (auth.NewSession, error)
	IssueToken(ctx context.Context, sessionToken string, repositoryID int64) (auth.AccessToken, error)
	Logout(ctx context.Context, sessionToken string) error
	Revoke(ctx context.Context, githubID int64) error
	Authenticate(ctx context.Context, sessionToken string) (auth.User, error)
}

var _ AuthService = (*auth.Service)(nil)

type authHandlers struct{ Deps }

func registerAuth(r *router.Router[*core.RequestEvent], d Deps) {
	h := authHandlers{d}
	g := r.Group(AuthPrefix)

	// PocketBase's global CORS middleware (from --origins) never sends
	// Access-Control-Allow-Credentials, so it is replaced here by one that
	// allows exactly the frontend origin with credentials.
	g.Unbind(apis.DefaultCorsMiddlewareId)
	cors := apis.CORS(apis.CORSConfig{
		AllowOriginFunc:  func(origin string) (bool, error) { return origin == d.FrontendOrigin, nil },
		AllowCredentials: true,
		AllowMethods:     []string{http.MethodGet, http.MethodPost},
		AllowHeaders:     []string{"Content-Type", CSRFHeader},
	})
	cors.Id = corsMiddlewareID
	g.Bind(cors)
	// Preflights must match a route in this group, otherwise they fall through
	// to PocketBase's catch-all route and its global CORS middleware.
	g.OPTIONS("/{path...}", func(e *core.RequestEvent) error { return e.NoContent(http.StatusNoContent) })

	g.GET("/login", h.login)
	g.GET("/callback", h.callback)
	g.POST("/token", h.token)
	g.POST("/logout", h.logout)
	g.POST("/webhook", h.webhook)
}

func (h authHandlers) login(e *core.RequestEvent) error {
	start, err := h.Auth.StartLogin()
	if err != nil {
		h.Logger.Error("auth login failed", "error", err)
		return errorJSON(e, http.StatusInternalServerError)
	}
	e.SetCookie(&http.Cookie{
		Name:     LoginCookie,
		Value:    start.Cookie,
		Path:     "/",
		MaxAge:   loginCookieMaxAge,
		Secure:   true,
		HttpOnly: true,
		// Lax, because the callback is a top-level navigation from github.com
		// and a Strict cookie would not be sent with it.
		SameSite: http.SameSiteLaxMode,
	})
	e.Response.Header().Set("Cache-Control", "no-store")
	return e.Redirect(http.StatusFound, start.URL)
}

func (h authHandlers) callback(e *core.RequestEvent) error {
	e.Response.Header().Set("Cache-Control", "no-store")
	// The URL carries the authorization code; keep it out of Referer headers.
	e.Response.Header().Set("Referrer-Policy", "no-referrer")
	e.SetCookie(expired(LoginCookie, http.SameSiteLaxMode))

	var cookie string
	if c, err := e.Request.Cookie(LoginCookie); err == nil {
		cookie = c.Value
	}
	q := e.Request.URL.Query()
	sess, err := h.Auth.Callback(e.Request.Context(), cookie, q.Get("state"), q.Get("code"))
	if err != nil {
		if !errors.Is(err, auth.ErrInvalidLogin) {
			h.Logger.Error("auth callback failed", "error", err)
		}
		return e.Redirect(http.StatusFound, h.FrontendOrigin+"/?login=failed")
	}

	e.SetCookie(&http.Cookie{
		Name:     SessionCookie,
		Value:    sess.Token,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		MaxAge:   int(time.Until(sess.ExpiresAt).Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	return e.Redirect(http.StatusFound, h.FrontendOrigin+"/")
}

func (h authHandlers) token(e *core.RequestEvent) error {
	if !h.fromFrontend(e.Request) {
		return errorJSON(e, http.StatusForbidden)
	}
	sessionToken := sessionFrom(e.Request)
	if sessionToken == "" {
		return errorJSON(e, http.StatusUnauthorized)
	}
	repoID, ok := readRepositoryID(e.Request)
	if !ok {
		return errorJSON(e, http.StatusBadRequest)
	}

	tok, err := h.Auth.IssueToken(e.Request.Context(), sessionToken, repoID)
	if errors.Is(err, auth.ErrUnauthenticated) {
		return errorJSON(e, http.StatusUnauthorized)
	}
	if err != nil {
		// Transient (database, GitHub outage, timeout): the session may still
		// be valid, so the client should retry rather than sign out.
		h.Logger.Error("auth token refresh failed", "error", err)
		return errorJSON(e, http.StatusServiceUnavailable)
	}
	e.Response.Header().Set("Cache-Control", "no-store")
	e.Response.Header().Set("Pragma", "no-cache")
	return e.JSON(http.StatusOK, map[string]string{
		"access_token": tok.Token,
		"expires_at":   tok.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

func (h authHandlers) logout(e *core.RequestEvent) error {
	if !h.fromFrontend(e.Request) {
		return errorJSON(e, http.StatusForbidden)
	}
	if err := h.Auth.Logout(e.Request.Context(), sessionFrom(e.Request)); err != nil {
		h.Logger.Error("auth logout failed", "error", err)
		return errorJSON(e, http.StatusInternalServerError)
	}
	e.SetCookie(expired(SessionCookie, http.SameSiteStrictMode))
	return e.NoContent(http.StatusNoContent)
}

// accessEvents are webhook events that can change who may pull or push a
// repository. Their payloads are not inspected: the whole permission cache is
// dropped, which is cheap and always safe.
var accessEvents = map[string]bool{
	"installation":              true,
	"installation_repositories": true,
	"member":                    true,
	"membership":                true,
	"organization":              true,
	"team":                      true,
	"repository":                true,
}

func (h authHandlers) webhook(e *core.RequestEvent) error {
	body, err := io.ReadAll(io.LimitReader(e.Request.Body, maxWebhookBody+1))
	if err != nil || len(body) > maxWebhookBody {
		return errorJSON(e, http.StatusBadRequest)
	}
	if !validSignature(h.WebhookSecret, body, e.Request.Header.Get("X-Hub-Signature-256")) {
		return errorJSON(e, http.StatusUnauthorized)
	}
	event := e.Request.Header.Get("X-GitHub-Event")
	if accessEvents[event] {
		if h.OnAccessChange != nil {
			h.OnAccessChange()
		}
		return e.NoContent(http.StatusNoContent)
	}
	if event != "github_app_authorization" {
		return e.NoContent(http.StatusNoContent)
	}

	var payload struct {
		Action string `json:"action"`
		Sender struct {
			ID int64 `json:"id"`
		} `json:"sender"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return errorJSON(e, http.StatusBadRequest)
	}
	if payload.Action == "revoked" && payload.Sender.ID > 0 {
		if err := h.Auth.Revoke(e.Request.Context(), payload.Sender.ID); err != nil {
			h.Logger.Error("auth revoke failed", "error", err)
			return errorJSON(e, http.StatusInternalServerError)
		}
	}
	return e.NoContent(http.StatusNoContent)
}

// fromFrontend requires the exact frontend Origin and the CSRF header.
func (h authHandlers) fromFrontend(r *http.Request) bool {
	return h.FrontendOrigin != "" && r.Header.Get("Origin") == h.FrontendOrigin && r.Header.Get(CSRFHeader) == "1"
}

func sessionFrom(r *http.Request) string {
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

// readRepositoryID parses the optional {"repository_id": <int>} body.
func readRepositoryID(r *http.Request) (int64, bool) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxTokenBody+1))
	if err != nil || len(raw) > maxTokenBody {
		return 0, false
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return 0, true
	}
	var body struct {
		RepositoryID int64 `json:"repository_id"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || body.RepositoryID < 0 {
		return 0, false
	}
	return body.RepositoryID, true
}

func validSignature(secret, body []byte, header string) bool {
	hexSig, ok := strings.CutPrefix(header, "sha256=")
	if !ok || len(secret) == 0 {
		return false
	}
	got, err := hex.DecodeString(hexSig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}

func expired(name string, sameSite http.SameSite) *http.Cookie {
	return &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, Secure: true, HttpOnly: true, SameSite: sameSite}
}

func errorJSON(e *core.RequestEvent, status int) error {
	return e.JSON(status, map[string]string{"error": http.StatusText(status)})
}

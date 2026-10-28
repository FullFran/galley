package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/comments"
)

// Comment route prefixes.
const (
	ReposPrefix    = "/api/galley/repos"
	ThreadsPrefix  = "/api/galley/threads"
	CommentsPrefix = "/api/galley/comments"
)

// maxCommentBody bounds a JSON request: body, suggestion and quote are each
// at most 20 KB, and JSON escaping can grow them.
const maxCommentBody = 128 << 10

// CommentsService is the part of comments.Service the handlers use.
type CommentsService interface {
	ListThreads(ctx context.Context, a comments.Actor, repoID int64, f comments.ListFilter) (comments.ThreadList, error)
	CreateThread(ctx context.Context, a comments.Actor, repoID int64, in comments.NewThread) (comments.Thread, error)
	GetThread(ctx context.Context, a comments.Actor, id string) (comments.Thread, error)
	Reply(ctx context.Context, a comments.Actor, threadID string, in comments.NewComment) (comments.Comment, error)
	EditComment(ctx context.Context, a comments.Actor, id string, in comments.NewComment) (comments.Comment, error)
	DeleteComment(ctx context.Context, a comments.Actor, id string) error
	Resolve(ctx context.Context, a comments.Actor, id string) (comments.Thread, error)
	Reopen(ctx context.Context, a comments.Actor, id string) (comments.Thread, error)
	MarkRead(ctx context.Context, a comments.Actor, id string) error
	Unread(ctx context.Context, a comments.Actor, repoID int64) (comments.Unread, error)
}

var _ CommentsService = (*comments.Service)(nil)

type commentHandlers struct{ Deps }

// credentialedMethods are the methods the credentialed groups allow.
var credentialedMethods = []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}

func registerComments(r *router.Router[*core.RequestEvent], repos *router.RouterGroup[*core.RequestEvent], d Deps) {
	h := commentHandlers{d}
	methods := credentialedMethods

	repos.GET("/{repo_id}/threads", h.wrap(h.listThreads))
	repos.POST("/{repo_id}/threads", h.wrap(h.createThread))
	repos.GET("/{repo_id}/unread", h.wrap(h.unread))

	threads := credentialedGroup(r, ThreadsPrefix, d.FrontendOrigin, methods)
	threads.GET("/{id}", h.wrap(h.getThread))
	threads.POST("/{id}/comments", h.wrap(h.reply))
	threads.POST("/{id}/resolve", h.wrap(h.resolve))
	threads.POST("/{id}/reopen", h.wrap(h.reopen))
	threads.POST("/{id}/read", h.wrap(h.markRead))

	cmts := credentialedGroup(r, CommentsPrefix, d.FrontendOrigin, methods)
	cmts.PATCH("/{id}", h.wrap(h.editComment))
	cmts.DELETE("/{id}", h.wrap(h.deleteComment))
}

// credentialedGroup returns a route group whose CORS handling allows exactly
// the frontend origin with credentials, replacing PocketBase's global CORS
// middleware (which never allows credentials). See registerAuth.
func credentialedGroup(r *router.Router[*core.RequestEvent], prefix, origin string, methods []string) *router.RouterGroup[*core.RequestEvent] {
	g := r.Group(prefix)
	g.Unbind(apis.DefaultCorsMiddlewareId)
	cors := apis.CORS(apis.CORSConfig{
		AllowOriginFunc:  func(o string) (bool, error) { return o == origin, nil },
		AllowCredentials: true,
		AllowMethods:     methods,
		AllowHeaders:     []string{"Content-Type", CSRFHeader, "If-Match", "Last-Event-ID"},
		ExposeHeaders:    []string{"ETag"},
	})
	cors.Id = corsMiddlewareID
	g.Bind(cors)
	g.OPTIONS("/{path...}", func(e *core.RequestEvent) error { return e.NoContent(http.StatusNoContent) })
	return g
}

type actorHandler func(e *core.RequestEvent, a comments.Actor) error

// sessionHandler also receives the session token, for handlers (streams)
// that re-check the session later.
type sessionHandler func(e *core.RequestEvent, a comments.Actor, session string) error

// wrap enforces, in order: the exact frontend Origin on every request, the
// CSRF header on state-changing ones, and a valid session.
func (h commentHandlers) wrap(fn actorHandler) func(*core.RequestEvent) error {
	return withSession(h.Deps, func(e *core.RequestEvent, a comments.Actor, _ string) error { return fn(e, a) })
}

// withSession is the middleware of every credentialed galley API route:
// exact Origin, CSRF header on state-changing methods, no-store, and a
// valid session.
func withSession(d Deps, fn sessionHandler) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		r := e.Request
		if d.FrontendOrigin == "" || r.Header.Get("Origin") != d.FrontendOrigin {
			return errorJSON(e, http.StatusForbidden)
		}
		if r.Method != http.MethodGet && r.Header.Get(CSRFHeader) != "1" {
			return errorJSON(e, http.StatusForbidden)
		}
		e.Response.Header().Set("Cache-Control", "no-store")
		token := sessionFrom(r)
		if token == "" {
			return errorJSON(e, http.StatusUnauthorized)
		}
		u, err := d.Auth.Authenticate(r.Context(), token)
		if errors.Is(err, auth.ErrUnauthenticated) {
			return errorJSON(e, http.StatusUnauthorized)
		}
		if err != nil {
			d.Logger.Error("authenticate failed", "error", err)
			return errorJSON(e, http.StatusServiceUnavailable)
		}
		return fn(e, comments.Actor{UserID: u.ID, Login: u.Login}, token)
	}
}

func (h commentHandlers) listThreads(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	q := e.Request.URL.Query()
	list, err := h.Comments.ListThreads(e.Request.Context(), a, repoID, comments.ListFilter{
		Path: q.Get("path"), Status: comments.Status(q.Get("status")), At: q.Get("at"),
	})
	if err != nil {
		return h.fail(e, err)
	}
	out := struct {
		Threads   []threadJSON `json:"threads"`
		Truncated bool         `json:"truncated"`
	}{Threads: make([]threadJSON, 0, len(list.Threads)), Truncated: list.Truncated}
	for _, t := range list.Threads {
		out.Threads = append(out.Threads, toThreadJSON(t))
	}
	return e.JSON(http.StatusOK, out)
}

func (h commentHandlers) createThread(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	var in struct {
		Path        string `json:"path"`
		CommitSHA   string `json:"commit_sha"`
		StartLine   int    `json:"start_line"`
		EndLine     int    `json:"end_line"`
		StartColumn int    `json:"start_column"`
		EndColumn   int    `json:"end_column"`
		Quote       struct {
			Exact  string `json:"exact"`
			Prefix string `json:"prefix"`
			Suffix string `json:"suffix"`
		} `json:"quote"`
		Origin     string  `json:"origin"`
		Body       string  `json:"body"`
		Suggestion *string `json:"suggestion"`
	}
	if status := decodeJSON(e.Request, &in); status != 0 {
		return errorJSON(e, status)
	}
	t, err := h.Comments.CreateThread(e.Request.Context(), a, repoID, comments.NewThread{
		Path:       in.Path,
		CommitSHA:  in.CommitSHA,
		Range:      comments.Range{StartLine: in.StartLine, EndLine: in.EndLine, StartColumn: in.StartColumn, EndColumn: in.EndColumn},
		Quote:      comments.Quote{Exact: in.Quote.Exact, Prefix: in.Quote.Prefix, Suffix: in.Quote.Suffix},
		Origin:     comments.Origin(in.Origin),
		Body:       in.Body,
		Suggestion: in.Suggestion,
	})
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusCreated, toThreadJSON(t))
}

func (h commentHandlers) unread(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	u, err := h.Comments.Unread(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, map[string]any{
		"repo_id":   u.RepoID,
		"threads":   u.Threads,
		"comments":  u.Comments,
		"by_thread": u.ByThread,
	})
}

func (h commentHandlers) getThread(e *core.RequestEvent, a comments.Actor) error {
	t, err := h.Comments.GetThread(e.Request.Context(), a, e.Request.PathValue("id"))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, toThreadJSON(t))
}

type commentInput struct {
	Body       string  `json:"body"`
	Suggestion *string `json:"suggestion"`
}

func (h commentHandlers) reply(e *core.RequestEvent, a comments.Actor) error {
	var in commentInput
	if status := decodeJSON(e.Request, &in); status != 0 {
		return errorJSON(e, status)
	}
	c, err := h.Comments.Reply(e.Request.Context(), a, e.Request.PathValue("id"), comments.NewComment(in))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusCreated, toCommentJSON(c))
}

func (h commentHandlers) editComment(e *core.RequestEvent, a comments.Actor) error {
	var in commentInput
	if status := decodeJSON(e.Request, &in); status != 0 {
		return errorJSON(e, status)
	}
	c, err := h.Comments.EditComment(e.Request.Context(), a, e.Request.PathValue("id"), comments.NewComment(in))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, toCommentJSON(c))
}

func (h commentHandlers) deleteComment(e *core.RequestEvent, a comments.Actor) error {
	if err := h.Comments.DeleteComment(e.Request.Context(), a, e.Request.PathValue("id")); err != nil {
		return h.fail(e, err)
	}
	return e.NoContent(http.StatusNoContent)
}

func (h commentHandlers) resolve(e *core.RequestEvent, a comments.Actor) error {
	t, err := h.Comments.Resolve(e.Request.Context(), a, e.Request.PathValue("id"))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, toThreadJSON(t))
}

func (h commentHandlers) reopen(e *core.RequestEvent, a comments.Actor) error {
	t, err := h.Comments.Reopen(e.Request.Context(), a, e.Request.PathValue("id"))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, toThreadJSON(t))
}

func (h commentHandlers) markRead(e *core.RequestEvent, a comments.Actor) error {
	if err := h.Comments.MarkRead(e.Request.Context(), a, e.Request.PathValue("id")); err != nil {
		return h.fail(e, err)
	}
	return e.NoContent(http.StatusNoContent)
}

func (h commentHandlers) fail(e *core.RequestEvent, err error) error {
	return failJSON(h.Deps, e, err, "comments")
}

// failJSON maps service errors to generic bodies. Validation errors also
// name the field. Only server-side failures are logged, and service errors
// never carry comment, draft or chat text, quotes or tokens.
func failJSON(d Deps, e *core.RequestEvent, err error, what string) error {
	var ve *comments.ValidationError
	switch {
	case errors.As(err, &ve):
		return e.JSON(http.StatusUnprocessableEntity, map[string]string{
			"error": http.StatusText(http.StatusUnprocessableEntity),
			"field": ve.Field,
		})
	case errors.Is(err, comments.ErrUnauthenticated):
		return errorJSON(e, http.StatusUnauthorized)
	case errors.Is(err, comments.ErrForbidden):
		return errorJSON(e, http.StatusForbidden)
	case errors.Is(err, comments.ErrNotFound):
		return errorJSON(e, http.StatusNotFound)
	case errors.Is(err, comments.ErrConflict):
		return errorJSON(e, http.StatusConflict)
	case errors.Is(err, comments.ErrRateLimited):
		e.Response.Header().Set("Retry-After", "2")
		return errorJSON(e, http.StatusTooManyRequests)
	case errors.Is(err, comments.ErrUnavailable):
		d.Logger.Error(what+" request failed", "error", err)
		return errorJSON(e, http.StatusServiceUnavailable)
	default:
		d.Logger.Error(what+" request failed", "error", err)
		return errorJSON(e, http.StatusInternalServerError)
	}
}

func repoIDFrom(e *core.RequestEvent) (int64, bool) {
	id, err := strconv.ParseInt(e.Request.PathValue("repo_id"), 10, 64)
	return id, err == nil && id > 0
}

// decodeJSON reads one JSON object with no unknown fields. It returns 0 on
// success, 413 for an oversized body and 400 otherwise. An empty body is an
// empty object.
func decodeJSON(r *http.Request, dst any) int {
	return decodeJSONLimit(r, dst, maxCommentBody)
}

// decodeJSONLimit is decodeJSON with a body limit of limit bytes.
func decodeJSONLimit(r *http.Request, dst any, limit int64) int {
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return http.StatusBadRequest
	}
	if int64(len(raw)) > limit {
		return http.StatusRequestEntityTooLarge
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return http.StatusBadRequest
	}
	if _, err := dec.Token(); err != io.EOF {
		return http.StatusBadRequest
	}
	return 0
}

type quoteJSON struct {
	Exact  string `json:"exact"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

type anchorJSON struct {
	Path        string    `json:"path"`
	CommitSHA   string    `json:"commit_sha"`
	StartLine   int       `json:"start_line"`
	EndLine     int       `json:"end_line"`
	StartColumn int       `json:"start_column,omitzero"`
	EndColumn   int       `json:"end_column,omitzero"`
	Quote       quoteJSON `json:"quote"`
}

type positionJSON struct {
	CommitSHA   string `json:"commit_sha"`
	StartLine   int    `json:"start_line"`
	EndLine     int    `json:"end_line"`
	StartColumn int    `json:"start_column,omitzero"`
	EndColumn   int    `json:"end_column,omitzero"`
	State       string `json:"state"`
}

type authorJSON struct {
	Kind     string `json:"kind"`
	Login    string `json:"login"`
	AIClient string `json:"ai_client,omitempty"`
	AIModel  string `json:"ai_model,omitempty"`
}

type suggestionJSON struct {
	Text    string `json:"text"`
	BaseSHA string `json:"base_sha"`
}

type commentJSON struct {
	ID         string          `json:"id"`
	ThreadID   string          `json:"thread_id"`
	Author     authorJSON      `json:"author"`
	Mine       bool            `json:"mine"`
	Body       string          `json:"body"`
	Suggestion *suggestionJSON `json:"suggestion,omitempty"`
	CreatedAt  string          `json:"created_at"`
	EditedAt   string          `json:"edited_at,omitempty"`
}

type threadJSON struct {
	ID           string        `json:"id"`
	RepoID       int64         `json:"repo_id"`
	RepoFullName string        `json:"repo_full_name"`
	Status       string        `json:"status"`
	Origin       string        `json:"origin"`
	Anchor       anchorJSON    `json:"anchor"`
	Position     positionJSON  `json:"position"`
	CreatedBy    string        `json:"created_by"`
	CreatedAt    string        `json:"created_at"`
	UpdatedAt    string        `json:"updated_at"`
	ResolvedBy   string        `json:"resolved_by,omitempty"`
	ResolvedAt   string        `json:"resolved_at,omitempty"`
	Comments     []commentJSON `json:"comments"`
}

func toThreadJSON(t comments.Thread) threadJSON {
	out := threadJSON{
		ID:           t.ID,
		RepoID:       t.RepoID,
		RepoFullName: t.RepoFullName,
		Status:       string(t.Status),
		Origin:       string(t.Origin),
		Anchor: anchorJSON{
			Path: t.Anchor.Path, CommitSHA: t.Anchor.CommitSHA,
			StartLine: t.Anchor.Range.StartLine, EndLine: t.Anchor.Range.EndLine,
			StartColumn: t.Anchor.Range.StartColumn, EndColumn: t.Anchor.Range.EndColumn,
			Quote: quoteJSON(t.Anchor.Quote),
		},
		Position: positionJSON{
			CommitSHA: t.Position.CommitSHA,
			StartLine: t.Position.Range.StartLine, EndLine: t.Position.Range.EndLine,
			StartColumn: t.Position.Range.StartColumn, EndColumn: t.Position.Range.EndColumn,
			State: string(t.Position.State),
		},
		CreatedBy:  t.CreatedBy,
		CreatedAt:  timeJSON(t.CreatedAt),
		UpdatedAt:  timeJSON(t.UpdatedAt),
		ResolvedBy: t.ResolvedBy,
		ResolvedAt: timeJSON(t.ResolvedAt),
		Comments:   make([]commentJSON, 0, len(t.Comments)),
	}
	for _, c := range t.Comments {
		out.Comments = append(out.Comments, toCommentJSON(c))
	}
	return out
}

func toCommentJSON(c comments.Comment) commentJSON {
	out := commentJSON{
		ID:        c.ID,
		ThreadID:  c.ThreadID,
		Author:    authorJSON{Kind: string(c.AuthorKind), Login: c.AuthorLogin, AIClient: c.AIClient, AIModel: c.AIModel},
		Mine:      c.Mine,
		Body:      c.Body,
		CreatedAt: timeJSON(c.CreatedAt),
		EditedAt:  timeJSON(c.EditedAt),
	}
	if c.Suggestion != nil {
		out.Suggestion = &suggestionJSON{Text: c.Suggestion.Text, BaseSHA: c.Suggestion.BaseSHA}
	}
	return out
}

func timeJSON(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

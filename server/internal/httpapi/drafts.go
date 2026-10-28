package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
)

// maxDraftBody bounds a draft PUT: 2 MB of content at the worst-case JSON
// escaping (a control character becomes \u00XX, 6 bytes) plus metadata. The
// decoded content is still limited to 2 MB by the service.
const maxDraftBody = 6*drafts.MaxContentBytes + 64<<10

// draftTime is the wire format of draft times: millisecond precision, so it
// round-trips as expected_updated_at.
const draftTime = "2006-01-02T15:04:05.000Z07:00"

// DraftsService is the part of drafts.Service the handlers use.
type DraftsService interface {
	List(ctx context.Context, a comments.Actor, repoID int64) ([]drafts.Draft, error)
	Get(ctx context.Context, a comments.Actor, repoID int64, path string) (drafts.Draft, error)
	Put(ctx context.Context, a comments.Actor, repoID int64, in drafts.PutInput) (drafts.Draft, error)
	Delete(ctx context.Context, a comments.Actor, repoID int64, path string) error
	DeleteAll(ctx context.Context, a comments.Actor, repoID int64) (int, error)
}

var _ DraftsService = (*drafts.Service)(nil)

type draftHandlers struct{ Deps }

func registerDrafts(repos *router.RouterGroup[*core.RequestEvent], d Deps) {
	h := draftHandlers{d}
	repos.GET("/{repo_id}/drafts", h.wrap(h.list))
	repos.DELETE("/{repo_id}/drafts", h.wrap(h.deleteAll))
	repos.GET("/{repo_id}/drafts/{path...}", h.wrap(h.get))
	repos.PUT("/{repo_id}/drafts/{path...}", h.wrap(h.put))
	repos.DELETE("/{repo_id}/drafts/{path...}", h.wrap(h.delete))
}

func (h draftHandlers) wrap(fn actorHandler) func(*core.RequestEvent) error {
	return withSession(h.Deps, func(e *core.RequestEvent, a comments.Actor, _ string) error { return fn(e, a) })
}

type draftJSON struct {
	Path      string  `json:"path"`
	BaseSHA   string  `json:"base_sha"`
	BaseRef   string  `json:"base_ref,omitempty"`
	Device    string  `json:"device,omitempty"`
	Size      int     `json:"size"`
	UpdatedAt string  `json:"updated_at"`
	ETag      string  `json:"etag"`
	Content   *string `json:"content,omitempty"`
}

func toDraftJSON(d drafts.Draft, withContent bool) draftJSON {
	out := draftJSON{
		Path: d.Path, BaseSHA: d.BaseSHA, BaseRef: d.BaseRef, Device: d.Device, Size: d.Size,
		UpdatedAt: d.UpdatedAt.UTC().Format(draftTime), ETag: d.ETag(),
	}
	if withContent {
		c := d.Content
		out.Content = &c
	}
	return out
}

func (h draftHandlers) list(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	list, err := h.Drafts.List(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	out := struct {
		Drafts []draftJSON `json:"drafts"`
	}{Drafts: make([]draftJSON, 0, len(list))}
	for _, d := range list {
		out.Drafts = append(out.Drafts, toDraftJSON(d, false))
	}
	return e.JSON(http.StatusOK, out)
}

func (h draftHandlers) get(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	d, err := h.Drafts.Get(e.Request.Context(), a, repoID, e.Request.PathValue("path"))
	if err != nil {
		return h.fail(e, err)
	}
	e.Response.Header().Set("ETag", d.ETag())
	return e.JSON(http.StatusOK, toDraftJSON(d, true))
}

func (h draftHandlers) put(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	var in struct {
		BaseSHA           string `json:"base_sha"`
		BaseRef           string `json:"base_ref"`
		Device            string `json:"device"`
		Content           string `json:"content"`
		ExpectedUpdatedAt string `json:"expected_updated_at"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxDraftBody); status != 0 {
		return errorJSON(e, status)
	}
	expected, field := draftPrecondition(e.Request.Header.Get("If-Match"), in.ExpectedUpdatedAt)
	if field != "" {
		return h.fail(e, &comments.ValidationError{Field: field})
	}
	d, err := h.Drafts.Put(e.Request.Context(), a, repoID, drafts.PutInput{
		Path: e.Request.PathValue("path"), BaseSHA: in.BaseSHA, BaseRef: in.BaseRef, Device: in.Device,
		Content: in.Content, Expected: expected.At, ExpectedVersion: expected.Nonce,
	})
	if err != nil {
		return h.fail(e, err)
	}
	e.Response.Header().Set("ETag", d.ETag())
	status := http.StatusOK
	if expected.At.IsZero() {
		status = http.StatusCreated
	}
	return e.JSON(status, toDraftJSON(d, false))
}

// draftPrecondition reads the version the client last saw from If-Match
// (time and nonce) or expected_updated_at (time only); when both are given
// the times must agree. It returns the invalid field's name on error.
func draftPrecondition(ifMatch, expectedAt string) (drafts.Tag, string) {
	var tag drafts.Tag
	if ifMatch != "" {
		t, err := drafts.ParseETag(ifMatch)
		if err != nil {
			return drafts.Tag{}, "if_match"
		}
		tag = t
	}
	if expectedAt != "" {
		t, err := time.Parse(time.RFC3339Nano, expectedAt)
		if err != nil {
			return drafts.Tag{}, "expected_updated_at"
		}
		at := t.UTC().Truncate(time.Millisecond)
		if !tag.At.IsZero() && !tag.At.Equal(at) {
			return drafts.Tag{}, "expected_updated_at"
		}
		tag.At = at
	}
	return tag, ""
}

func (h draftHandlers) delete(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	if err := h.Drafts.Delete(e.Request.Context(), a, repoID, e.Request.PathValue("path")); err != nil {
		return h.fail(e, err)
	}
	return e.NoContent(http.StatusNoContent)
}

func (h draftHandlers) deleteAll(e *core.RequestEvent, a comments.Actor) error {
	repoID, ok := repoIDFrom(e)
	if !ok {
		return errorJSON(e, http.StatusNotFound)
	}
	n, err := h.Drafts.DeleteAll(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, map[string]int{"deleted": n})
}

// fail answers a conflict with the draft's current metadata (never its
// content), so the client can offer to reload or keep its copy.
func (h draftHandlers) fail(e *core.RequestEvent, err error) error {
	var ce *drafts.ConflictError
	if errors.As(err, &ce) {
		body := map[string]any{"error": http.StatusText(http.StatusConflict), "current": nil}
		if ce.Current != nil {
			body["current"] = toDraftJSON(*ce.Current, false)
		}
		return e.JSON(http.StatusConflict, body)
	}
	return failJSON(h.Deps, e, err, "drafts")
}

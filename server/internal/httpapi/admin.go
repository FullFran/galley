package httpapi

import (
	"context"
	"net/http"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/admin"
	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
)

// maxAdminBody bounds admin request bodies (small JSON objects).
const maxAdminBody = 4 << 10

// AdminService is the part of admin.Service the handlers use.
type AdminService interface {
	People(ctx context.Context, a comments.Actor, repoID int64) ([]admin.PersonView, error)
	RevokeSessions(ctx context.Context, a comments.Actor, repoID int64, userID string, confirmSelf bool) error
	Allowlist(ctx context.Context, a comments.Actor, repoID int64) ([]admin.AllowEntry, error)
	Allow(ctx context.Context, a comments.Actor, repoID, githubID int64, login string) (admin.AllowEntry, error)
	Disallow(ctx context.Context, a comments.Actor, repoID int64, id string) error
	SharedDrafts(ctx context.Context, a comments.Actor, repoID int64) ([]admin.SharedDraft, error)
	SharedDraft(ctx context.Context, a comments.Actor, repoID int64, id string) (admin.Share, drafts.Draft, error)
	Audit(ctx context.Context, a comments.Actor, repoID int64) ([]admin.AuditEntry, error)
	ShareDraft(ctx context.Context, a comments.Actor, repoID int64, path string) (admin.Share, error)
	UnshareDraft(ctx context.Context, a comments.Actor, repoID int64, path string) error
	MyShares(ctx context.Context, a comments.Actor, repoID int64) ([]admin.Share, error)
}

var _ AdminService = (*admin.Service)(nil)

type adminHandlers struct{ Deps }

type repoHandler func(e *core.RequestEvent, a comments.Actor, repoID int64) error

func registerAdmin(repos *router.RouterGroup[*core.RequestEvent], d Deps) {
	h := adminHandlers{d}
	repos.GET("/{repo_id}/admin/people", h.wrap(h.people))
	repos.POST("/{repo_id}/admin/people/{user_id}/revoke-sessions", h.wrap(h.revokeSessions))
	repos.GET("/{repo_id}/admin/allowlist", h.wrap(h.allowlist))
	repos.POST("/{repo_id}/admin/allowlist", h.wrap(h.allow))
	repos.DELETE("/{repo_id}/admin/allowlist/{id}", h.wrap(h.disallow))
	repos.GET("/{repo_id}/admin/shared-drafts", h.wrap(h.sharedDrafts))
	repos.GET("/{repo_id}/admin/shared-drafts/{id}", h.wrap(h.sharedDraft))
	repos.GET("/{repo_id}/admin/audit", h.wrap(h.audit))

	// The owner's side of draft sharing. A separate prefix, because a
	// wildcard path cannot be followed by "/share".
	repos.GET("/{repo_id}/draft-shares", h.wrap(h.myShares))
	repos.POST("/{repo_id}/draft-shares/{path...}", h.wrap(h.share))
	repos.DELETE("/{repo_id}/draft-shares/{path...}", h.wrap(h.unshare))
}

func (h adminHandlers) wrap(fn repoHandler) func(*core.RequestEvent) error {
	return withSession(h.Deps, func(e *core.RequestEvent, a comments.Actor, _ string) error {
		repoID, ok := repoIDFrom(e)
		if !ok {
			return errorJSON(e, http.StatusNotFound)
		}
		return fn(e, a, repoID)
	})
}

type draftStatsJSON struct {
	Count  int    `json:"count"`
	Bytes  int64  `json:"bytes"`
	Oldest string `json:"oldest_updated_at,omitempty"`
	Newest string `json:"newest_updated_at,omitempty"`
}

type personJSON struct {
	UserID     string         `json:"user_id"`
	Login      string         `json:"login"`
	GitHubID   int64          `json:"github_id"`
	Permission string         `json:"permission"`
	FirstSeen  string         `json:"first_seen"`
	LastSeen   string         `json:"last_seen"`
	Blocked    bool           `json:"blocked"`
	Drafts     draftStatsJSON `json:"drafts"`
}

func (h adminHandlers) people(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	list, err := h.Admin.People(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	out := make([]personJSON, 0, len(list))
	for _, p := range list {
		out = append(out, personJSON{
			UserID: p.UserID, Login: p.Login, GitHubID: p.GitHubID, Permission: string(p.Level),
			FirstSeen: timeJSON(p.FirstSeen), LastSeen: timeJSON(p.LastSeen), Blocked: p.Blocked,
			Drafts: draftStatsJSON{Count: p.Drafts.Count, Bytes: p.Drafts.Bytes, Oldest: timeJSON(p.Drafts.Oldest), Newest: timeJSON(p.Drafts.Newest)},
		})
	}
	return e.JSON(http.StatusOK, map[string]any{"people": out})
}

func (h adminHandlers) revokeSessions(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	var in struct {
		ConfirmSelf bool `json:"confirm_self"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxAdminBody); status != 0 {
		return errorJSON(e, status)
	}
	if err := h.Admin.RevokeSessions(e.Request.Context(), a, repoID, e.Request.PathValue("user_id"), in.ConfirmSelf); err != nil {
		return h.fail(e, err)
	}
	return e.NoContent(http.StatusNoContent)
}

type allowJSON struct {
	ID        string `json:"id"`
	GitHubID  int64  `json:"github_id,omitzero"`
	Login     string `json:"login,omitempty"`
	CreatedAt string `json:"created_at"`
}

func toAllowJSON(x admin.AllowEntry) allowJSON {
	return allowJSON{ID: x.ID, GitHubID: x.GitHubID, Login: x.Login, CreatedAt: timeJSON(x.CreatedAt)}
}

func (h adminHandlers) allowlist(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	list, err := h.Admin.Allowlist(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	out := make([]allowJSON, 0, len(list))
	for _, x := range list {
		out = append(out, toAllowJSON(x))
	}
	return e.JSON(http.StatusOK, map[string]any{"entries": out})
}

func (h adminHandlers) allow(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	var in struct {
		GitHubID int64  `json:"github_id"`
		Login    string `json:"login"`
	}
	if status := decodeJSONLimit(e.Request, &in, maxAdminBody); status != 0 {
		return errorJSON(e, status)
	}
	x, err := h.Admin.Allow(e.Request.Context(), a, repoID, in.GitHubID, in.Login)
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusCreated, toAllowJSON(x))
}

func (h adminHandlers) disallow(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	if err := h.Admin.Disallow(e.Request.Context(), a, repoID, e.Request.PathValue("id")); err != nil {
		return h.fail(e, err)
	}
	return e.NoContent(http.StatusNoContent)
}

type ownerJSON struct {
	UserID string `json:"user_id"`
	Login  string `json:"login,omitempty"`
}

type shareJSON struct {
	ID        string    `json:"id"`
	RepoID    int64     `json:"repo_id"`
	Path      string    `json:"path"`
	Owner     ownerJSON `json:"owner"`
	CreatedAt string    `json:"created_at"`
	ExpiresAt string    `json:"expires_at"`
	Size      *int      `json:"size,omitempty"`
	UpdatedAt string    `json:"updated_at,omitempty"`
}

func toShareJSON(s admin.Share) shareJSON {
	return shareJSON{ID: s.ID, RepoID: s.RepoID, Path: s.Path, Owner: ownerJSON{UserID: s.Owner, Login: s.OwnerLogin},
		CreatedAt: timeJSON(s.CreatedAt), ExpiresAt: timeJSON(s.ExpiresAt)}
}

func (h adminHandlers) sharedDrafts(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	list, err := h.Admin.SharedDrafts(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	out := make([]shareJSON, 0, len(list))
	for _, s := range list {
		j := toShareJSON(s.Share)
		size := s.Size
		j.Size, j.UpdatedAt = &size, s.UpdatedAt.UTC().Format(draftTime)
		out = append(out, j)
	}
	return e.JSON(http.StatusOK, map[string]any{"shared_drafts": out})
}

func (h adminHandlers) sharedDraft(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	s, d, err := h.Admin.SharedDraft(e.Request.Context(), a, repoID, e.Request.PathValue("id"))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusOK, map[string]any{
		"share":      toShareJSON(s),
		"read_only":  true,
		"path":       d.Path,
		"base_sha":   d.BaseSHA,
		"base_ref":   d.BaseRef,
		"size":       d.Size,
		"updated_at": d.UpdatedAt.UTC().Format(draftTime),
		"content":    d.Content,
	})
}

func (h adminHandlers) audit(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	list, err := h.Admin.Audit(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	type entryJSON struct {
		ID     string    `json:"id"`
		Actor  ownerJSON `json:"actor"`
		Action string    `json:"action"`
		Target string    `json:"target"`
		At     string    `json:"at"`
	}
	out := make([]entryJSON, 0, len(list))
	for _, x := range list {
		out = append(out, entryJSON{ID: x.ID, Actor: ownerJSON{UserID: x.ActorID, Login: x.ActorLogin}, Action: x.Action,
			Target: x.Target, At: timeJSON(x.At)})
	}
	return e.JSON(http.StatusOK, map[string]any{"entries": out})
}

func (h adminHandlers) myShares(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	list, err := h.Admin.MyShares(e.Request.Context(), a, repoID)
	if err != nil {
		return h.fail(e, err)
	}
	out := make([]shareJSON, 0, len(list))
	for _, s := range list {
		out = append(out, toShareJSON(s))
	}
	return e.JSON(http.StatusOK, map[string]any{"shares": out})
}

func (h adminHandlers) share(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	if status := decodeJSONLimit(e.Request, &struct{}{}, maxAdminBody); status != 0 {
		return errorJSON(e, status)
	}
	s, err := h.Admin.ShareDraft(e.Request.Context(), a, repoID, e.Request.PathValue("path"))
	if err != nil {
		return h.fail(e, err)
	}
	return e.JSON(http.StatusCreated, toShareJSON(s))
}

func (h adminHandlers) unshare(e *core.RequestEvent, a comments.Actor, repoID int64) error {
	if err := h.Admin.UnshareDraft(e.Request.Context(), a, repoID, e.Request.PathValue("path")); err != nil {
		return h.fail(e, err)
	}
	return e.NoContent(http.StatusNoContent)
}

func (h adminHandlers) fail(e *core.RequestEvent, err error) error {
	return failJSON(h.Deps, e, err, "admin")
}

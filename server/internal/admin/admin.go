// Package admin implements galley's repository administration: who used
// galley on a repository and when, a per-repository allowlist of galley
// users, revoking a user's galley sessions, consent-based read-only sharing
// of drafts with the repository's admins, and an audit trail of every admin
// action.
//
// An admin is a user with GitHub's admin permission on the repository. Admin
// actions never touch another user's GitHub token: galley only manages its
// own data (sessions, allowlist, grants). The allowlist restricts galley
// features (comments, drafts, chat), never GitHub access.
//
// It reuses the comments package as a shared kernel (actors, repository
// access, error sentinels and validation errors), like drafts and chat.
package admin

import (
	"context"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
)

// Level is a user's permission on a repository, as last seen by galley.
type Level string

// Permission levels.
const (
	LevelRead  Level = "read"
	LevelWrite Level = "write"
	LevelAdmin Level = "admin"
)

// LevelOf maps a repository permission to its level ("" without pull).
func LevelOf(p comments.RepoPermission) Level {
	switch {
	case p.Admin:
		return LevelAdmin
	case p.Push:
		return LevelWrite
	case p.Pull:
		return LevelRead
	}
	return ""
}

// Audit actions.
const (
	ActionViewPeople       = "view_people"
	ActionRevokeSessions   = "revoke_sessions"
	ActionViewAllowlist    = "view_allowlist"
	ActionAllowlistAdd     = "allowlist_add"
	ActionAllowlistRemove  = "allowlist_remove"
	ActionViewSharedDrafts = "view_shared_drafts"
	ActionViewSharedDraft  = "view_shared_draft"
	ActionViewAudit        = "view_audit"
	ActionShareCreate      = "share_create"
	ActionShareRevoke      = "share_revoke"
)

// Limits and defaults.
const (
	// DefaultShareTTL is how long a draft share grant lasts.
	DefaultShareTTL = 24 * time.Hour
	// DefaultTouchEvery throttles last_seen writes per user and repository.
	DefaultTouchEvery = 5 * time.Minute
	// DefaultAllowlistTTL is how long a repository's allowlist is cached.
	DefaultAllowlistTTL = 30 * time.Second
	// MaxAuditList is how many audit entries a listing returns.
	MaxAuditList = 200
	// MaxPeople bounds the people listing.
	MaxPeople = 1000
	// MaxAllowlist bounds a repository's allowlist.
	MaxAllowlist = 1000
	// MaxSharesPerOwner bounds one owner's active grants per repository.
	MaxSharesPerOwner = 50
	// ActivityWindow: sessions can be revoked only for users seen on the
	// repository within it.
	ActivityWindow = 180 * 24 * time.Hour
)

// Identity is the GitHub identity of a galley user.
type Identity struct {
	GitHubID int64
	Login    string
}

// Activity is a user's use of galley on a repository.
type Activity struct {
	UserID    string
	RepoID    int64
	Level     Level
	FirstSeen time.Time
	LastSeen  time.Time
}

// Person is an Activity with the user's GitHub identity.
type Person struct {
	Activity
	Login    string
	GitHubID int64
}

// DraftStats summarizes a user's drafts on a repository: metadata only.
type DraftStats struct {
	Count  int
	Bytes  int64
	Oldest time.Time // updated_at of the least recently written draft
	Newest time.Time
}

// PersonView is a person as admins see them.
type PersonView struct {
	Person
	Drafts DraftStats
	// Blocked: the repository has a non-empty allowlist the user is not on
	// (admins are never blocked).
	Blocked bool
}

// AllowEntry is an allowlist entry: a GitHub user id, a login, or both.
// Logins are stored lowercase.
type AllowEntry struct {
	ID        string
	RepoID    int64
	GitHubID  int64
	Login     string
	AddedBy   string // user id
	CreatedAt time.Time
}

// Matches reports whether the entry names the identity.
func (e AllowEntry) Matches(id Identity) bool {
	if e.GitHubID != 0 {
		return e.GitHubID == id.GitHubID
	}
	return e.Login != "" && e.Login == lower(id.Login)
}

// Share is a read-only grant of one draft to the repository's admins.
type Share struct {
	ID         string
	DraftID    string
	Owner      string // user id
	OwnerLogin string // filled by listings
	RepoID     int64
	Path       string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	RevokedAt  time.Time
}

// Active reports whether the grant is usable at now.
func (s Share) Active(now time.Time) bool {
	return s.RevokedAt.IsZero() && now.Before(s.ExpiresAt)
}

// SharedDraft is an active grant with the draft's current metadata.
type SharedDraft struct {
	Share
	Size      int
	UpdatedAt time.Time
}

// AuditEntry records one admin or sharing action. It never holds content.
type AuditEntry struct {
	ID         string
	RepoID     int64
	ActorID    string
	ActorLogin string
	Action     string
	Target     string // "user:<id>", "share:<id>", "allow:<id>" or "repo"
	At         time.Time
}

// Store persists activity, allowlists, grants and the audit trail. Missing
// records return comments.ErrNotFound. Methods that take an AuditEntry write
// it in the same transaction as the change, and only when the change is
// made; an empty AuditEntry.ID gets a generated id, and RevokeShares writes
// one entry per revoked grant with Target "share:<id>".
type Store interface {
	// TouchActivity creates or updates the user's activity on the
	// repository: FirstSeen is kept, LastSeen and Level replaced.
	TouchActivity(ctx context.Context, a Activity) error
	// HasActivity reports activity on the repository at or after since.
	HasActivity(ctx context.Context, userID string, repoID int64, since time.Time) (bool, error)
	// People lists the repository's activity, most recent first.
	People(ctx context.Context, repoID int64, limit int) ([]Person, error)
	// DraftStats aggregates draft metadata per owner on the repository.
	DraftStats(ctx context.Context, repoID int64) (map[string]DraftStats, error)

	Allowlist(ctx context.Context, repoID int64, limit int) ([]AllowEntry, error)
	// AddAllowEntry inserts e atomically: comments.ErrConflict when an entry
	// with the same GitHub id (or, for login-only entries, the same login)
	// exists, ErrAllowlistFull when the repository already has max entries.
	AddAllowEntry(ctx context.Context, e AllowEntry, max int, audit AuditEntry) error
	// DeleteAllowEntry deletes the entry with id on the repository.
	DeleteAllowEntry(ctx context.Context, repoID int64, id string, audit AuditEntry) error

	CreateShare(ctx context.Context, s Share, audit AuditEntry) error
	// ExtendShare sets the expiry of a grant that is still active at now
	// (not revoked, not expired); otherwise it returns comments.ErrNotFound.
	ExtendShare(ctx context.Context, id string, now, expiresAt time.Time, audit AuditEntry) error
	Share(ctx context.Context, id string) (Share, error)
	// ActiveShares lists the repository's active grants at now whose draft
	// still exists, newest first; owner, when set, narrows it to that owner.
	ActiveShares(ctx context.Context, repoID int64, owner string, now time.Time, limit int) ([]Share, error)
	// RevokeShares revokes the owner's active grants on the draft path and
	// returns their ids.
	RevokeShares(ctx context.Context, owner string, repoID int64, path string, now time.Time, audit AuditEntry) ([]string, error)

	AppendAudit(ctx context.Context, e AuditEntry) error
	// Audit lists the repository's audit entries, newest first.
	Audit(ctx context.Context, repoID int64, limit int) ([]AuditEntry, error)
}

// ErrAllowlistFull means the repository's allowlist has MaxAllowlist entries.
var ErrAllowlistFull error = &comments.ValidationError{Field: "allowlist"}

// FreshAccess answers a permission from GitHub now, bypassing any cache
// (comments.CachedAccess implements it). The Guard uses it, when the inner
// access has it, for admin actions that change data or reveal a draft.
type FreshAccess interface {
	FreshPermission(ctx context.Context, userID string, repoID int64) (comments.RepoPermission, error)
}

// Drafts is the part of drafts.Service sharing needs. Neither method checks
// repository access: the admin Service does.
type Drafts interface {
	// Lookup returns the id and metadata of the owner's draft.
	Lookup(ctx context.Context, owner string, repoID int64, path string) (string, drafts.Draft, error)
	// OpenByID returns the owner's draft with its content, only when the
	// draft at path still has id.
	OpenByID(ctx context.Context, owner string, repoID int64, path, id string) (drafts.Draft, error)
}

var _ Drafts = (*drafts.Service)(nil)

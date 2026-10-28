// Package comments implements galley's line-anchored comment threads: the
// domain types, the use cases (Service) and the ports its adapters implement.
// Comment text and quotes are sealed before they reach the Store; the Store
// only ever sees ciphertext for them.
package comments

import (
	"context"
	"errors"
	"time"
)

// Errors returned by the Service. Adapters map them to transport codes.
var (
	// ErrUnauthenticated means the user must sign in again.
	ErrUnauthenticated = errors.New("comments: unauthenticated")
	// ErrForbidden means the user can see the thread but not do this.
	ErrForbidden = errors.New("comments: forbidden")
	// ErrNotFound covers unknown records and repositories the user cannot see.
	ErrNotFound = errors.New("comments: not found")
	// ErrConflict means the record is not in the state the action needs.
	ErrConflict = errors.New("comments: conflict")
	// ErrRateLimited means the user sent too many writes.
	ErrRateLimited = errors.New("comments: rate limited")
	// ErrUnavailable means a dependency (GitHub, the database) failed; retry.
	ErrUnavailable = errors.New("comments: unavailable")
)

// ValidationError names the first invalid input field. It never carries the
// value.
type ValidationError struct{ Field string }

func (e *ValidationError) Error() string { return "comments: invalid " + e.Field }

// Status of a thread.
type Status string

// Thread statuses.
const (
	StatusOpen     Status = "open"
	StatusResolved Status = "resolved"
)

// Origin is where the thread was started.
type Origin string

// Thread origins.
const (
	OriginSource  Origin = "source"
	OriginPreview Origin = "preview"
)

// AnchorState says how the current position relates to the original anchor.
type AnchorState string

// Anchor states (phase 2 re-anchoring fills the others).
const (
	AnchorExact    AnchorState = "exact"
	AnchorMoved    AnchorState = "moved"
	AnchorFuzzy    AnchorState = "fuzzy"
	AnchorOrphaned AnchorState = "orphaned"
)

// AuthorKind tells human comments from AI ones (AI comes in phase 3).
type AuthorKind string

// Author kinds.
const (
	AuthorHuman AuthorKind = "human"
	AuthorAI    AuthorKind = "ai"
)

// Actor is the signed-in galley user acting.
type Actor struct {
	UserID string
	Login  string
}

// Range is a 1-based inclusive line range. Columns are 1-based and 0 when
// the range covers whole lines.
type Range struct {
	StartLine   int
	EndLine     int
	StartColumn int
	EndColumn   int
}

// Quote is a W3C TextQuoteSelector: the quoted text and its context.
type Quote struct {
	Exact  string
	Prefix string
	Suffix string
}

// Anchor is where a thread was created.
type Anchor struct {
	Path      string
	CommitSHA string
	Range     Range
	Quote     Quote
}

// Position is where a thread currently sits. Path differs from the anchor's
// when the file was renamed; the service fills it with the anchor's path
// when a Reanchorer leaves it empty.
type Position struct {
	Path      string
	CommitSHA string
	Range     Range
	State     AnchorState
}

// Suggestion is replacement text for the anchored range.
type Suggestion struct {
	Text    string
	BaseSHA string
}

// Comment is one message of a thread, in plaintext.
type Comment struct {
	ID          string
	ThreadID    string
	AuthorKind  AuthorKind
	AuthorLogin string
	AIClient    string
	AIModel     string
	Mine        bool
	Body        string
	Suggestion  *Suggestion
	CreatedAt   time.Time
	EditedAt    time.Time
}

// Thread is a comment thread with its comments, in plaintext.
type Thread struct {
	ID           string
	RepoID       int64
	RepoFullName string
	Anchor       Anchor
	Position     Position
	Origin       Origin
	Status       Status
	CreatedBy    string // login
	CreatedAt    time.Time
	UpdatedAt    time.Time
	ResolvedBy   string // login
	ResolvedAt   time.Time
	Comments     []Comment
}

// ThreadRecord is a thread as stored. Quote fields hold ciphertext.
type ThreadRecord struct {
	ID              string
	RepoID          int64
	RepoFullName    string
	Path            string
	CommitSHA       string
	Range           Range
	QuoteExact      string
	QuotePrefix     string
	QuoteSuffix     string
	Position        Position
	Origin          Origin
	Status          Status
	CreatedBy       string // user id
	CreatedByLogin  string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ResolvedBy      string // user id
	ResolvedByLogin string
	ResolvedAt      time.Time
}

// CommentRecord is a comment as stored. Body and Suggestion hold ciphertext;
// an empty Suggestion means there is none.
type CommentRecord struct {
	ID                string
	ThreadID          string
	AuthorKind        AuthorKind
	AuthorUser        string
	AuthorLogin       string
	AIClient          string
	AIModel           string
	Body              string
	Suggestion        string
	SuggestionBaseSHA string
	CreatedAt         time.Time
	EditedAt          time.Time
}

// ListFilter narrows a thread listing. Empty fields do not filter.
type ListFilter struct {
	Path   string
	Status Status
	// At is the head commit the caller is viewing; re-anchoring uses it.
	At string
}

// RepoPermission is what a user may do on a repository. Admin is GitHub's
// admin permission on the repository (it implies Push and Pull).
type RepoPermission struct {
	FullName string
	Pull     bool
	Push     bool
	Admin    bool
}

// RepoAccess answers the user's permission on a repository, by GitHub
// repository id. Repositories the user cannot see return ErrNotFound.
type RepoAccess interface {
	Permission(ctx context.Context, userID string, repoID int64) (RepoPermission, error)
}

// Store persists threads, comments and read markers. Lookups of missing
// records return ErrNotFound.
type Store interface {
	// CreateThread saves a thread and its first comment atomically.
	CreateThread(ctx context.Context, t ThreadRecord, first CommentRecord) error
	Thread(ctx context.Context, id string) (ThreadRecord, error)
	// Threads lists a repository's threads ordered by path and line, at most
	// limit of them.
	Threads(ctx context.Context, repoID int64, f ListFilter, limit int) ([]ThreadRecord, error)
	// Comments returns the comments of the threads, oldest first.
	Comments(ctx context.Context, threadIDs []string) ([]CommentRecord, error)
	Comment(ctx context.Context, id string) (CommentRecord, error)
	// AddComment saves a reply and bumps the thread's UpdatedAt.
	AddComment(ctx context.Context, c CommentRecord) error
	// UpdateComment replaces body, suggestion and EditedAt.
	UpdateComment(ctx context.Context, c CommentRecord) error
	// DeleteComment deletes a comment, and its thread when it was the last.
	DeleteComment(ctx context.Context, id string, at time.Time) (threadDeleted bool, err error)
	// SetThreadStatus moves a thread from one status to another and returns
	// ErrConflict when it is not in status from.
	SetThreadStatus(ctx context.Context, id string, from, to Status, by Actor, at time.Time) error
	// MarkRead records that userID has read the thread up to at.
	MarkRead(ctx context.Context, userID, threadID string, at time.Time) error
	// UnreadCounts returns, per thread of the repository, the comments by
	// other authors created after the user's read marker.
	UnreadCounts(ctx context.Context, userID string, repoID int64) (map[string]int, error)
}

// Sealer encrypts and authenticates values; secret.Sealer implements it.
type Sealer interface {
	Seal(plaintext, aad []byte) (string, error)
	Open(sealed string, aad []byte) ([]byte, error)
}

// Clock tells the time.
type Clock interface{ Now() time.Time }

// ClockFunc adapts a function to Clock.
type ClockFunc func() time.Time

// Now implements Clock.
func (f ClockFunc) Now() time.Time { return f() }

// Reanchorer computes where a thread sits at commit at, for the user
// viewing it (whose GitHub token it may use). reanchor.Service implements it
// (shift through compare hunks, exact quote search, bounded fuzzy match,
// orphaning). The quote is passed in plaintext. It must never change the
// stored anchor.
type Reanchorer interface {
	Position(ctx context.Context, userID string, t ThreadRecord, quote Quote, at string) (Position, error)
}

// StoredPosition is the Reanchorer without GitHub: the stored position,
// unchanged.
type StoredPosition struct{}

// Position implements Reanchorer.
func (StoredPosition) Position(_ context.Context, _ string, t ThreadRecord, _ Quote, _ string) (Position, error) {
	return t.Position, nil
}

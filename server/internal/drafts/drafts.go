// Package drafts implements galley's server-side drafts: one sealed working
// copy per user, repository and path, readable only by its owner. Drafts are
// purged after a successful save, after DefaultRetention idle and when the
// user's GitHub authorization is revoked.
//
// It reuses the comments package as a shared kernel: actors, repository
// access, the rate limiter, the sealer port, the error sentinels (so the HTTP
// adapter maps them the same way) and the text and path validation rules.
package drafts

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// Limits.
const (
	MaxContentBytes = 2 << 20
	MaxDeviceBytes  = 64
	MaxRefBytes     = 255
	// DefaultMaxDrafts is the number of drafts one user may keep per repository.
	DefaultMaxDrafts = 200
	// DefaultMaxOwnerDrafts and DefaultMaxOwnerBytes bound one user's drafts
	// across all repositories (bytes count plaintext content).
	DefaultMaxOwnerDrafts       = 1000
	DefaultMaxOwnerBytes  int64 = 50 << 20
	// DefaultRetention is how long an untouched draft is kept.
	DefaultRetention = 30 * 24 * time.Hour
)

// ErrLimit means the user already has the maximum number of drafts in the
// repository. It is a validation error on the field "drafts".
var ErrLimit error = &comments.ValidationError{Field: "drafts"}

// ErrOwnerDrafts and ErrOwnerStorage mean the user's drafts across all
// repositories reached DefaultMaxOwnerDrafts or DefaultMaxOwnerBytes.
var (
	ErrOwnerDrafts  error = &comments.ValidationError{Field: "owner_drafts"}
	ErrOwnerStorage error = &comments.ValidationError{Field: "owner_storage"}
)

// Draft is a draft in plaintext. Listings leave Content empty.
type Draft struct {
	Path      string
	BaseSHA   string
	BaseRef   string
	Device    string
	Size      int
	UpdatedAt time.Time
	// Version is a random nonce renewed on every write, so a draft deleted
	// and recreated within one millisecond still gets a new ETag.
	Version string
	Content string
}

// ETag is the draft's version: `"<UpdatedAt in Unix ms>-<Version>"`.
func (d Draft) ETag() string {
	return `"` + strconv.FormatInt(d.UpdatedAt.UnixMilli(), 10) + "-" + d.Version + `"`
}

// Tag is a parsed ETag.
type Tag struct {
	At    time.Time
	Nonce string
}

var errETag = errors.New("drafts: malformed etag")

// ParseETag parses a strong ETag made by Draft.ETag.
func ParseETag(tag string) (Tag, error) {
	inner, ok := strings.CutPrefix(tag, `"`)
	if !ok {
		return Tag{}, errETag
	}
	inner, ok = strings.CutSuffix(inner, `"`)
	if !ok {
		return Tag{}, errETag
	}
	ms, nonce, ok := strings.Cut(inner, "-")
	if !ok || ms == "" || len(ms) > 19 || !validNonce(nonce) {
		return Tag{}, errETag
	}
	for i := 0; i < len(ms); i++ {
		if ms[i] < '0' || ms[i] > '9' {
			return Tag{}, errETag
		}
	}
	n, err := strconv.ParseInt(ms, 10, 64)
	if err != nil {
		return Tag{}, errETag
	}
	return Tag{At: time.UnixMilli(n).UTC(), Nonce: nonce}, nil
}

func validNonce(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if (s[i] < 'a' || s[i] > 'z') && (s[i] < '0' || s[i] > '9') {
			return false
		}
	}
	return true
}

// Precondition is the version a write expects. A zero At means "the draft
// must not exist". An empty Version (from expected_updated_at) only
// compares the time.
type Precondition struct {
	At      time.Time
	Version string
}

// Limits bound a create or replace.
type Limits struct {
	MaxDrafts      int // per owner and repository
	MaxOwnerDrafts int
	MaxOwnerBytes  int64
}

// ConflictError is returned when a write's precondition does not hold.
// Current is the draft's metadata now (no content), or nil when there is no
// draft at that path.
type ConflictError struct{ Current *Draft }

func (e *ConflictError) Error() string { return "drafts: conflict" }

// Unwrap makes errors.Is(err, comments.ErrConflict) hold.
func (e *ConflictError) Unwrap() error { return comments.ErrConflict }

// Record is a draft as stored. Content holds ciphertext.
type Record struct {
	ID        string
	Owner     string // galley user id
	RepoID    int64
	Path      string
	BaseSHA   string
	BaseRef   string
	Device    string
	Size      int
	Content   string
	Version   string
	UpdatedAt time.Time
}

// Store persists drafts. Every lookup is scoped by owner. Missing drafts
// return comments.ErrNotFound.
type Store interface {
	Draft(ctx context.Context, owner string, repoID int64, path string) (Record, error)
	// Drafts lists the owner's drafts in the repository, newest first,
	// without content, at most limit of them.
	Drafts(ctx context.Context, owner string, repoID int64, limit int) ([]Record, error)
	// Put creates r when pre.At is zero and no draft exists at its place, or
	// replaces the draft with id r.ID that matches pre (time at millisecond
	// precision, and Version when set), atomically; otherwise it returns
	// comments.ErrConflict. Inside the same transaction it calls guard (when
	// set) and returns its error, and enforces lim: ErrLimit, ErrOwnerDrafts
	// or ErrOwnerStorage.
	Put(ctx context.Context, r Record, pre Precondition, lim Limits, guard func() error) error
	Delete(ctx context.Context, owner string, repoID int64, path string) error
	DeleteRepo(ctx context.Context, owner string, repoID int64) (int, error)
	DeleteOwner(ctx context.Context, owner string) (int, error)
	// DeleteIdle deletes every draft last updated before before.
	DeleteIdle(ctx context.Context, before time.Time) (int, error)
}

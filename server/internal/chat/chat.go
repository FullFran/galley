// Package chat implements galley's per-paper chat: sealed messages numbered
// per repository, read markers, and an in-process broker that pushes new
// messages to the open streams of users who may read the repository.
//
// Like drafts, it reuses the comments package as a shared kernel (actors,
// repository access, rate limiter, sealer, error sentinels and text rules).
package chat

import (
	"context"
	"fmt"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// Limits and defaults.
const (
	MaxBodyBytes             = 4 << 10
	DefaultPageSize          = 50
	MaxPageSize              = 200
	DefaultMaxStreamsPerUser = 5
	DefaultMaxStreams        = 1000
	DefaultReplayLimit       = 200
	DefaultStreamBuffer      = 64
	DefaultPostBurst         = 20
	DefaultPostEvery         = time.Second
)

// ErrTooManyStreams means the user (or the server) has too many open chat
// streams. It is a rate-limit error.
var ErrTooManyStreams = fmt.Errorf("%w: too many chat streams", comments.ErrRateLimited)

// Message is a chat message in plaintext, as seen by one user.
type Message struct {
	ID          string
	RepoID      int64
	Seq         int64
	AuthorLogin string
	Mine        bool
	Body        string
	CreatedAt   time.Time
}

// Record is a message as stored. Body holds ciphertext.
type Record struct {
	ID          string
	RepoID      int64
	Seq         int64
	Author      string // galley user id
	AuthorLogin string
	Body        string
	CreatedAt   time.Time
}

// Unread is what a user has not read in a repository's chat.
type Unread struct {
	RepoID      int64
	Count       int // messages by others after the marker
	LastReadSeq int64
	LatestSeq   int64
}

// Page is one page of history, oldest first.
type Page struct {
	Messages []Message
	// HasMore is set when older messages exist before the page.
	HasMore bool
}

// Store persists messages and read markers.
type Store interface {
	// Append saves r with the repository's next sequence number, atomically,
	// and returns that number.
	Append(ctx context.Context, r Record) (int64, error)
	// Before returns up to limit messages with seq < beforeSeq (any seq when
	// beforeSeq is 0), newest first.
	Before(ctx context.Context, repoID, beforeSeq int64, limit int) ([]Record, error)
	// After returns up to limit messages with seq > afterSeq, oldest first.
	After(ctx context.Context, repoID, afterSeq int64, limit int) ([]Record, error)
	// MarkRead moves the user's marker to seq (the newest message when seq
	// is 0 or beyond it), never backwards, and returns the stored marker.
	MarkRead(ctx context.Context, userID string, repoID, seq int64) (int64, error)
	Unread(ctx context.Context, userID string, repoID int64) (Unread, error)
}

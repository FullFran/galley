package chat

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// Config wires a Service; zero fields take the defaults.
type Config struct {
	Store  Store
	Access comments.RepoAccess
	Sealer comments.Sealer
	Clock  comments.Clock
	// Limiter limits posts per user.
	Limiter           *comments.RateLimiter
	MaxStreamsPerUser int
	MaxStreams        int
	ReplayLimit       int
	StreamBuffer      int
	NewID             func() string
}

// Service runs the chat use cases. Everything needs pull on an installed
// repository.
type Service struct {
	cfg    Config
	broker *broker
	// postMu orders append and publish, so streams see increasing seqs.
	postMu sync.Mutex
}

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Access == nil || cfg.Sealer == nil {
		return nil, errors.New("chat: store, access and sealer are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.Limiter == nil {
		cfg.Limiter = comments.NewRateLimiter(DefaultPostBurst, DefaultPostEvery, cfg.Clock)
	}
	if cfg.MaxStreamsPerUser <= 0 {
		cfg.MaxStreamsPerUser = DefaultMaxStreamsPerUser
	}
	if cfg.MaxStreams <= 0 {
		cfg.MaxStreams = DefaultMaxStreams
	}
	if cfg.ReplayLimit <= 0 {
		cfg.ReplayLimit = DefaultReplayLimit
	}
	if cfg.StreamBuffer <= 0 {
		cfg.StreamBuffer = DefaultStreamBuffer
	}
	if cfg.NewID == nil {
		cfg.NewID = comments.NewID
	}
	return &Service{cfg: cfg, broker: newBroker(cfg.MaxStreamsPerUser, cfg.MaxStreams, cfg.StreamBuffer)}, nil
}

// History returns up to limit messages before beforeSeq (the newest when 0),
// oldest first.
func (s *Service) History(ctx context.Context, a comments.Actor, repoID, beforeSeq int64, limit int) (Page, error) {
	if beforeSeq < 0 {
		return Page{}, invalid("before_seq")
	}
	if limit < 0 || limit > MaxPageSize {
		return Page{}, invalid("limit")
	}
	if limit == 0 {
		limit = DefaultPageSize
	}
	if err := s.Check(ctx, a, repoID); err != nil {
		return Page{}, err
	}
	recs, err := s.cfg.Store.Before(ctx, repoID, beforeSeq, limit+1)
	if err != nil {
		return Page{}, storeErr(err)
	}
	page := Page{}
	if len(recs) > limit {
		recs, page.HasMore = recs[:limit], true
	}
	page.Messages = make([]Message, len(recs))
	for i, r := range recs {
		m, err := s.open(r, a.UserID)
		if err != nil {
			return Page{}, err
		}
		page.Messages[len(recs)-1-i] = m
	}
	return page, nil
}

// Post saves a message and pushes it to the repository's streams.
func (s *Service) Post(ctx context.Context, a comments.Actor, repoID int64, body string) (Message, error) {
	if len(body) > MaxBodyBytes || !comments.ValidText(body) || strings.TrimSpace(body) == "" {
		return Message{}, invalid("body")
	}
	if a.UserID == "" {
		return Message{}, comments.ErrUnauthenticated
	}
	if !s.cfg.Limiter.Allow(a.UserID) {
		return Message{}, comments.ErrRateLimited
	}
	if err := s.Check(ctx, a, repoID); err != nil {
		return Message{}, err
	}
	r := Record{ID: s.cfg.NewID(), RepoID: repoID, Author: a.UserID, AuthorLogin: a.Login, CreatedAt: s.cfg.Clock.Now().UTC()}
	sealed, err := s.cfg.Sealer.Seal([]byte(body), bodyAAD(r))
	if err != nil {
		return Message{}, fmt.Errorf("chat: seal: %w", err)
	}
	r.Body = sealed

	s.postMu.Lock()
	defer s.postMu.Unlock()
	if r.Seq, err = s.cfg.Store.Append(ctx, r); err != nil {
		return Message{}, storeErr(err)
	}
	m := Message{ID: r.ID, RepoID: repoID, Seq: r.Seq, AuthorLogin: a.Login, Body: body, CreatedAt: r.CreatedAt}
	s.broker.publish(m, a.UserID)
	m.Mine = true
	return m, nil
}

// MarkRead moves the actor's read marker (see Store.MarkRead).
func (s *Service) MarkRead(ctx context.Context, a comments.Actor, repoID, seq int64) (int64, error) {
	if seq < 0 {
		return 0, invalid("seq")
	}
	if err := s.Check(ctx, a, repoID); err != nil {
		return 0, err
	}
	n, err := s.cfg.Store.MarkRead(ctx, a.UserID, repoID, seq)
	return n, storeErr(err)
}

// Unread counts the messages by others after the actor's marker.
func (s *Service) Unread(ctx context.Context, a comments.Actor, repoID int64) (Unread, error) {
	if err := s.Check(ctx, a, repoID); err != nil {
		return Unread{}, err
	}
	u, err := s.cfg.Store.Unread(ctx, a.UserID, repoID)
	return u, storeErr(err)
}

// Subscribe opens a stream of the repository's new messages. afterSeq is the
// last sequence number the client saw (SSE Last-Event-ID); when positive,
// the messages after it are replayed through Backlog.
func (s *Service) Subscribe(ctx context.Context, a comments.Actor, repoID, afterSeq int64) (*Subscription, error) {
	if afterSeq < 0 {
		return nil, invalid("last_event_id")
	}
	if err := s.Check(ctx, a, repoID); err != nil {
		return nil, err
	}
	sub, err := s.broker.subscribe(a.UserID, repoID)
	if err != nil {
		return nil, err
	}
	if afterSeq == 0 {
		return sub, nil
	}
	recs, err := s.cfg.Store.After(ctx, repoID, afterSeq, s.cfg.ReplayLimit+1)
	if err != nil {
		sub.Close()
		return nil, storeErr(err)
	}
	if len(recs) > s.cfg.ReplayLimit {
		recs, sub.resync = recs[:s.cfg.ReplayLimit], true
	}
	for _, r := range recs {
		m, err := s.open(r, a.UserID)
		if err != nil {
			sub.Close()
			return nil, err
		}
		sub.backlog = append(sub.backlog, m)
	}
	return sub, nil
}

// Check returns nil while the actor may read the repository's chat. Streams
// call it periodically, so revoked access ends them.
func (s *Service) Check(ctx context.Context, a comments.Actor, repoID int64) error {
	if a.UserID == "" {
		return comments.ErrUnauthenticated
	}
	if repoID <= 0 {
		return invalid("repo_id")
	}
	perm, err := s.cfg.Access.Permission(ctx, a.UserID, repoID)
	switch {
	case errors.Is(err, comments.ErrNotFound), errors.Is(err, comments.ErrUnauthenticated), errors.Is(err, comments.ErrRateLimited):
		return err
	case err != nil:
		return fmt.Errorf("%w: %w", comments.ErrUnavailable, err)
	case !perm.Pull:
		return comments.ErrForbidden
	}
	return nil
}

// CloseUser ends every stream of the user (after revocation). It does not
// block.
func (s *Service) CloseUser(userID string) { s.broker.closeUser(userID) }

// Shutdown ends every stream and refuses new ones (server shutdown, so open
// streams do not hold the graceful shutdown).
func (s *Service) Shutdown() { s.broker.closeAll() }

func (s *Service) open(r Record, viewer string) (Message, error) {
	plain, err := s.cfg.Sealer.Open(r.Body, bodyAAD(r))
	if err != nil {
		return Message{}, fmt.Errorf("chat: open message %s: %w", r.ID, err)
	}
	return Message{
		ID: r.ID, RepoID: r.RepoID, Seq: r.Seq, AuthorLogin: r.AuthorLogin, Mine: r.Author == viewer,
		Body: string(plain), CreatedAt: r.CreatedAt.UTC(),
	}, nil
}

// bodyAAD binds the sealed body to its message, repository and author, so a
// body copied to another message or reattributed does not open.
func bodyAAD(r Record) []byte {
	return []byte("galley/v1/chat/" + r.ID + "/body/" + strconv.FormatInt(r.RepoID, 10) + "/" + r.Author)
}

func invalid(field string) error { return &comments.ValidationError{Field: field} }

func storeErr(err error) error {
	if err == nil || errors.Is(err, comments.ErrNotFound) || errors.Is(err, comments.ErrConflict) {
		return err
	}
	return fmt.Errorf("%w: store: %w", comments.ErrUnavailable, err)
}

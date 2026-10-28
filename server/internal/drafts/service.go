package drafts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/FullFran/galley/server/internal/comments"
)

// Defaults for Config.
const (
	DefaultWriteBurst = 60
	DefaultWriteEvery = time.Second
)

// Config wires a Service.
type Config struct {
	Store  Store
	Access comments.RepoAccess
	Sealer comments.Sealer
	Clock  comments.Clock
	// Limiter limits writes (put and delete) per user; defaults to
	// DefaultWriteBurst at once and one more every DefaultWriteEvery.
	Limiter        *comments.RateLimiter
	MaxDrafts      int
	MaxOwnerDrafts int
	MaxOwnerBytes  int64
	Retention      time.Duration
	// RevokeTTL is how long writes stay refused after Revoke (default
	// DefaultRevokeTTL); SecondPurgeDelay is when Revoke purges again
	// (default DefaultSecondPurgeDelay).
	RevokeTTL        time.Duration
	SecondPurgeDelay time.Duration
	Logger           *slog.Logger
	NewID            func() string
}

// Revocation defaults.
const (
	DefaultRevokeTTL        = 2 * time.Minute
	DefaultSecondPurgeDelay = 30 * time.Second
	purgeTimeout            = time.Minute
)

// Service runs the draft use cases. Every call needs pull on an installed
// repository, and only ever touches the actor's own drafts: another user's
// draft is ErrNotFound, whatever their permission on the repository.
type Service struct {
	cfg Config

	mu      sync.Mutex
	revoked map[string]time.Time // user id -> marker expiry
}

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Access == nil || cfg.Sealer == nil {
		return nil, errors.New("drafts: store, access and sealer are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.Limiter == nil {
		cfg.Limiter = comments.NewRateLimiter(DefaultWriteBurst, DefaultWriteEvery, cfg.Clock)
	}
	if cfg.MaxDrafts <= 0 {
		cfg.MaxDrafts = DefaultMaxDrafts
	}
	if cfg.MaxOwnerDrafts <= 0 {
		cfg.MaxOwnerDrafts = DefaultMaxOwnerDrafts
	}
	if cfg.MaxOwnerBytes <= 0 {
		cfg.MaxOwnerBytes = DefaultMaxOwnerBytes
	}
	if cfg.Retention <= 0 {
		cfg.Retention = DefaultRetention
	}
	if cfg.RevokeTTL <= 0 {
		cfg.RevokeTTL = DefaultRevokeTTL
	}
	if cfg.SecondPurgeDelay <= 0 {
		cfg.SecondPurgeDelay = DefaultSecondPurgeDelay
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.NewID == nil {
		cfg.NewID = comments.NewID
	}
	return &Service{cfg: cfg, revoked: map[string]time.Time{}}, nil
}

// PutInput is a draft write. Expected is the UpdatedAt the client last saw
// (from the ETag or expected_updated_at), ExpectedVersion the ETag's nonce;
// a zero Expected means "create only", so a device that never saw the draft
// cannot overwrite it.
type PutInput struct {
	Path            string
	BaseSHA         string
	BaseRef         string
	Device          string
	Content         string
	Expected        time.Time
	ExpectedVersion string
}

// Validate checks every field.
func (in PutInput) Validate() error {
	switch {
	case !comments.ValidPath(in.Path):
		return invalid("path")
	case !comments.ValidSHA(in.BaseSHA):
		return invalid("base_sha")
	case in.BaseRef != "" && !validRef(in.BaseRef):
		return invalid("base_ref")
	case len(in.Device) > MaxDeviceBytes || !validLabel(in.Device):
		return invalid("device")
	case len(in.Content) > MaxContentBytes || !validContent(in.Content):
		return invalid("content")
	}
	return nil
}

// List returns the actor's drafts in the repository, newest first, without
// content.
func (s *Service) List(ctx context.Context, a comments.Actor, repoID int64) ([]Draft, error) {
	if err := s.check(ctx, a, repoID); err != nil {
		return nil, err
	}
	recs, err := s.cfg.Store.Drafts(ctx, a.UserID, repoID, s.cfg.MaxDrafts)
	if err != nil {
		return nil, storeErr(err)
	}
	out := make([]Draft, len(recs))
	for i, r := range recs {
		out[i] = meta(r)
	}
	return out, nil
}

// Get returns one of the actor's drafts with its content.
func (s *Service) Get(ctx context.Context, a comments.Actor, repoID int64, path string) (Draft, error) {
	if !comments.ValidPath(path) {
		return Draft{}, invalid("path")
	}
	if err := s.check(ctx, a, repoID); err != nil {
		return Draft{}, err
	}
	r, err := s.cfg.Store.Draft(ctx, a.UserID, repoID, path)
	if err != nil {
		return Draft{}, storeErr(err)
	}
	return s.open(r)
}

// Put creates or replaces one of the actor's drafts (see PutInput.Expected).
func (s *Service) Put(ctx context.Context, a comments.Actor, repoID int64, in PutInput) (Draft, error) {
	if err := in.Validate(); err != nil {
		return Draft{}, err
	}
	if err := s.allowWrite(a); err != nil {
		return Draft{}, err
	}
	if err := s.check(ctx, a, repoID); err != nil {
		return Draft{}, err
	}
	if s.isRevoked(a.UserID) {
		return Draft{}, comments.ErrUnauthenticated
	}
	pre := Precondition{At: in.Expected.UTC().Truncate(time.Millisecond), Version: in.ExpectedVersion}
	cur, err := s.cfg.Store.Draft(ctx, a.UserID, repoID, in.Path)
	exists := err == nil
	if err != nil && !errors.Is(err, comments.ErrNotFound) {
		return Draft{}, storeErr(err)
	}
	if exists != !pre.At.IsZero() || (exists && !matches(cur, pre)) {
		return Draft{}, s.conflict(ctx, a.UserID, repoID, in.Path)
	}

	now := s.cfg.Clock.Now().UTC().Truncate(time.Millisecond)
	rec := Record{
		ID: s.cfg.NewID(), Owner: a.UserID, RepoID: repoID, Path: in.Path,
		BaseSHA: in.BaseSHA, BaseRef: in.BaseRef, Device: in.Device, Size: len(in.Content),
		Version: s.cfg.NewID()[:8], UpdatedAt: now,
	}
	if exists {
		rec.ID = cur.ID
		// Keep the time strictly increasing, even within one millisecond or
		// when the clock steps back.
		if prev := cur.UpdatedAt.Truncate(time.Millisecond); !now.After(prev) {
			rec.UpdatedAt = prev.Add(time.Millisecond)
		}
	}
	if rec.Content, err = s.cfg.Sealer.Seal([]byte(in.Content), contentAAD(rec)); err != nil {
		return Draft{}, fmt.Errorf("drafts: seal: %w", err)
	}
	lim := Limits{MaxDrafts: s.cfg.MaxDrafts, MaxOwnerDrafts: s.cfg.MaxOwnerDrafts, MaxOwnerBytes: s.cfg.MaxOwnerBytes}
	guard := func() error {
		if s.isRevoked(a.UserID) {
			return comments.ErrUnauthenticated
		}
		return nil
	}
	switch err := s.cfg.Store.Put(ctx, rec, pre, lim, guard); {
	case errors.Is(err, ErrLimit), errors.Is(err, ErrOwnerDrafts), errors.Is(err, ErrOwnerStorage),
		errors.Is(err, comments.ErrUnauthenticated):
		return Draft{}, err
	case errors.Is(err, comments.ErrConflict):
		return Draft{}, s.conflict(ctx, a.UserID, repoID, in.Path)
	case err != nil:
		return Draft{}, storeErr(err)
	}
	d := meta(rec)
	d.Content = in.Content
	return d, nil
}

func matches(cur Record, pre Precondition) bool {
	return cur.UpdatedAt.Truncate(time.Millisecond).Equal(pre.At) && (pre.Version == "" || pre.Version == cur.Version)
}

// Delete deletes one of the actor's drafts.
func (s *Service) Delete(ctx context.Context, a comments.Actor, repoID int64, path string) error {
	if !comments.ValidPath(path) {
		return invalid("path")
	}
	if err := s.allowWrite(a); err != nil {
		return err
	}
	if err := s.check(ctx, a, repoID); err != nil {
		return err
	}
	return storeErr(s.cfg.Store.Delete(ctx, a.UserID, repoID, path))
}

// DeleteAll deletes all of the actor's drafts in the repository (after a
// successful save) and returns how many there were.
func (s *Service) DeleteAll(ctx context.Context, a comments.Actor, repoID int64) (int, error) {
	if err := s.allowWrite(a); err != nil {
		return 0, err
	}
	if err := s.check(ctx, a, repoID); err != nil {
		return 0, err
	}
	n, err := s.cfg.Store.DeleteRepo(ctx, a.UserID, repoID)
	return n, storeErr(err)
}

// PurgeIdle deletes drafts untouched for longer than the retention.
func (s *Service) PurgeIdle(ctx context.Context) (int, error) {
	n, err := s.cfg.Store.DeleteIdle(ctx, s.cfg.Clock.Now().UTC().Add(-s.cfg.Retention))
	return n, storeErr(err)
}

// PurgeUser deletes every draft of a user (after revocation). It needs no
// repository access: the user's authorization is already gone.
func (s *Service) PurgeUser(ctx context.Context, userID string) (int, error) {
	if userID == "" {
		return 0, errors.New("drafts: purge needs a user id")
	}
	n, err := s.cfg.Store.DeleteOwner(ctx, userID)
	return n, storeErr(err)
}

// Revoke handles a real revocation of the user's GitHub authorization. It
// does not block: it marks the user so writes are refused (inside the store
// transaction, so a write in flight either lands before the purge or not at
// all) for RevokeTTL, then purges the user's drafts now and once more after
// SecondPurgeDelay.
func (s *Service) Revoke(userID string) {
	if userID == "" {
		return
	}
	now := s.cfg.Clock.Now()
	s.mu.Lock()
	for id, until := range s.revoked {
		if !now.Before(until) {
			delete(s.revoked, id)
		}
	}
	s.revoked[userID] = now.Add(s.cfg.RevokeTTL)
	s.mu.Unlock()

	purge := func() {
		ctx, cancel := context.WithTimeout(context.Background(), purgeTimeout)
		defer cancel()
		if _, err := s.PurgeUser(ctx, userID); err != nil {
			s.cfg.Logger.Error("drafts purge after revocation failed", "error", err)
		}
	}
	go purge()
	time.AfterFunc(s.cfg.SecondPurgeDelay, purge)
}

func (s *Service) isRevoked(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	until, ok := s.revoked[userID]
	return ok && s.cfg.Clock.Now().Before(until)
}

// RetentionJobID is the PocketBase cron job id of the idle-draft purge.
const RetentionJobID = "galley_drafts_retention"

// Scheduler is the part of PocketBase's cron the retention job needs.
type Scheduler interface {
	Add(jobID, cronExpr string, fn func()) error
}

// ScheduleRetention runs PurgeIdle hourly. Failures are logged without
// details beyond the error; drafts are never logged.
func ScheduleRetention(c Scheduler, s *Service, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	return c.Add(RetentionJobID, "0 * * * *", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		n, err := s.PurgeIdle(ctx)
		if err != nil {
			logger.Error("drafts retention failed", "error", err)
			return
		}
		if n > 0 {
			logger.Info("drafts retention purged idle drafts", "count", n)
		}
	})
}

func (s *Service) check(ctx context.Context, a comments.Actor, repoID int64) error {
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

func (s *Service) allowWrite(a comments.Actor) error {
	if a.UserID == "" {
		return comments.ErrUnauthenticated
	}
	if !s.cfg.Limiter.Allow(a.UserID) {
		return comments.ErrRateLimited
	}
	return nil
}

func (s *Service) conflict(ctx context.Context, owner string, repoID int64, path string) error {
	cur, err := s.cfg.Store.Draft(ctx, owner, repoID, path)
	switch {
	case errors.Is(err, comments.ErrNotFound):
		return &ConflictError{}
	case err != nil:
		return storeErr(err)
	}
	d := meta(cur)
	return &ConflictError{Current: &d}
}

func (s *Service) open(r Record) (Draft, error) {
	plain, err := s.cfg.Sealer.Open(r.Content, contentAAD(r))
	if err != nil {
		// The id is safe to log; the content and path are not included.
		return Draft{}, fmt.Errorf("drafts: open draft %s: %w", r.ID, err)
	}
	d := meta(r)
	d.Content = string(plain)
	return d, nil
}

func meta(r Record) Draft {
	return Draft{Path: r.Path, BaseSHA: r.BaseSHA, BaseRef: r.BaseRef, Device: r.Device, Size: r.Size,
		Version: r.Version, UpdatedAt: r.UpdatedAt.UTC()}
}

// contentAAD binds the sealed content to its record, owner, repository and
// path, so ciphertext copied anywhere else does not open.
func contentAAD(r Record) []byte {
	return []byte("galley/v1/draft/" + r.ID + "/content/" + r.Owner + "/" + strconv.FormatInt(r.RepoID, 10) + "/" + r.Path)
}

func invalid(field string) error { return &comments.ValidationError{Field: field} }

func storeErr(err error) error {
	if err == nil || errors.Is(err, comments.ErrNotFound) || errors.Is(err, comments.ErrConflict) {
		return err
	}
	return fmt.Errorf("%w: store: %w", comments.ErrUnavailable, err)
}

// validContent accepts UTF-8 without NUL. Bidi controls are allowed: the
// draft is the owner's own copy of a repository file, shown only to them.
func validContent(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// validLabel accepts short single-line text: no control or format characters.
func validLabel(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// validRef accepts a branch or tag name following git's check-ref-format
// rules closely enough for display and comparison.
func validRef(s string) bool {
	if len(s) > MaxRefBytes || !validLabel(s) || strings.HasPrefix(s, "-") || strings.HasPrefix(s, "/") ||
		strings.HasSuffix(s, "/") || strings.HasSuffix(s, ".") || strings.HasSuffix(s, ".lock") ||
		strings.Contains(s, "..") || strings.Contains(s, "//") || strings.Contains(s, "@{") || s == "@" {
		return false
	}
	return !strings.ContainsAny(s, " ~^:?*[\\")
}

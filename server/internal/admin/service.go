package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/drafts"
)

// Config wires a Service.
type Config struct {
	Guard  *Guard
	Store  Store
	Drafts Drafts
	// DeleteSessions deletes every galley session of the user (and should
	// end their open streams). It never touches GitHub tokens.
	DeleteSessions func(ctx context.Context, userID string) error
	Clock          comments.Clock
	// ShareTTL is how long a share grant lasts (default DefaultShareTTL).
	ShareTTL time.Duration
	NewID    func() string
	Logger   *slog.Logger
}

// Service runs the admin and sharing use cases. Admin calls need GitHub's
// admin permission on the repository: without access they return
// ErrNotFound, with access but not admin ErrForbidden. Every admin call that
// passes the check is audited before it acts or reveals anything; when the
// audit cannot be written the call fails.
type Service struct {
	cfg Config
}

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Guard == nil || cfg.Store == nil || cfg.Drafts == nil || cfg.DeleteSessions == nil {
		return nil, errors.New("admin: guard, store, drafts and session deletion are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.ShareTTL <= 0 {
		cfg.ShareTTL = DefaultShareTTL
	}
	if cfg.NewID == nil {
		cfg.NewID = comments.NewID
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Service{cfg: cfg}, nil
}

// People lists the users who used galley on the repository, with their
// draft metadata (never content) and whether the allowlist blocks them.
func (s *Service) People(ctx context.Context, a comments.Actor, repoID int64) ([]PersonView, error) {
	if err := s.requireAdmin(ctx, a, repoID, ActionViewPeople, "repo"); err != nil {
		return nil, err
	}
	people, err := s.cfg.Store.People(ctx, repoID, MaxPeople)
	if err != nil {
		return nil, storeErr(err)
	}
	stats, err := s.cfg.Store.DraftStats(ctx, repoID)
	if err != nil {
		return nil, storeErr(err)
	}
	list, err := s.cfg.Store.Allowlist(ctx, repoID, MaxAllowlist)
	if err != nil {
		return nil, storeErr(err)
	}
	out := make([]PersonView, len(people))
	for i, p := range people {
		out[i] = PersonView{
			Person:  p,
			Drafts:  stats[p.UserID],
			Blocked: len(list) > 0 && p.Level != LevelAdmin && !allowed(list, Identity{GitHubID: p.GitHubID, Login: p.Login}),
		}
	}
	return out, nil
}

// RevokeSessions deletes every galley session of a user who used galley on
// the repository (sessions are global, not per repository). Revoking your
// own sessions needs confirmSelf.
func (s *Service) RevokeSessions(ctx context.Context, a comments.Actor, repoID int64, userID string, confirmSelf bool) error {
	if !validID(userID) {
		return invalid("user_id")
	}
	if err := s.checkAdminFresh(ctx, a, repoID); err != nil {
		return err
	}
	if userID == a.UserID && !confirmSelf {
		return invalid("confirm_self")
	}
	since := s.cfg.Clock.Now().UTC().Add(-ActivityWindow)
	ok, err := s.cfg.Store.HasActivity(ctx, userID, repoID, since)
	if err != nil {
		return storeErr(err)
	}
	if !ok {
		return comments.ErrNotFound
	}
	if err := s.audit(ctx, a, repoID, ActionRevokeSessions, "user:"+userID); err != nil {
		return err
	}
	if err := s.cfg.DeleteSessions(ctx, userID); err != nil {
		return fmt.Errorf("%w: delete sessions: %w", comments.ErrUnavailable, err)
	}
	return nil
}

// Allowlist returns the repository's allowlist.
func (s *Service) Allowlist(ctx context.Context, a comments.Actor, repoID int64) ([]AllowEntry, error) {
	if err := s.requireAdmin(ctx, a, repoID, ActionViewAllowlist, "repo"); err != nil {
		return nil, err
	}
	list, err := s.cfg.Store.Allowlist(ctx, repoID, MaxAllowlist)
	return list, storeErr(err)
}

var loginPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

// Allow adds a GitHub user id, a login, or both to the allowlist. When the
// id is set it decides the match; the login is then only a label. An entry
// that duplicates an existing id or login is ErrConflict.
func (s *Service) Allow(ctx context.Context, a comments.Actor, repoID int64, githubID int64, login string) (AllowEntry, error) {
	switch {
	case githubID < 0:
		return AllowEntry{}, invalid("github_id")
	case login != "" && !loginPattern.MatchString(login):
		return AllowEntry{}, invalid("login")
	case githubID == 0 && login == "":
		return AllowEntry{}, invalid("github_id")
	}
	if err := s.checkAdminFresh(ctx, a, repoID); err != nil {
		return AllowEntry{}, err
	}
	e := AllowEntry{ID: s.cfg.NewID(), RepoID: repoID, GitHubID: githubID, Login: lower(login), AddedBy: a.UserID,
		CreatedAt: s.cfg.Clock.Now().UTC()}
	defer s.cfg.Guard.invalidate(repoID)
	if err := s.cfg.Store.AddAllowEntry(ctx, e, MaxAllowlist, s.entry(a, repoID, ActionAllowlistAdd, "allow:"+e.ID)); err != nil {
		return AllowEntry{}, storeErr(err)
	}
	return e, nil
}

// Disallow removes an allowlist entry of the repository.
func (s *Service) Disallow(ctx context.Context, a comments.Actor, repoID int64, id string) error {
	if !validID(id) {
		return comments.ErrNotFound
	}
	if err := s.checkAdminFresh(ctx, a, repoID); err != nil {
		return err
	}
	defer s.cfg.Guard.invalidate(repoID)
	return storeErr(s.cfg.Store.DeleteAllowEntry(ctx, repoID, id, s.entry(a, repoID, ActionAllowlistRemove, "allow:"+id)))
}

// SharedDrafts lists the repository's active grants with the drafts'
// current metadata.
func (s *Service) SharedDrafts(ctx context.Context, a comments.Actor, repoID int64) ([]SharedDraft, error) {
	if err := s.requireAdmin(ctx, a, repoID, ActionViewSharedDrafts, "repo"); err != nil {
		return nil, err
	}
	shares, err := s.cfg.Store.ActiveShares(ctx, repoID, "", s.cfg.Clock.Now().UTC(), MaxAuditList)
	if err != nil {
		return nil, storeErr(err)
	}
	out := make([]SharedDraft, 0, len(shares))
	for _, sh := range shares {
		id, d, err := s.cfg.Drafts.Lookup(ctx, sh.Owner, sh.RepoID, sh.Path)
		switch {
		case errors.Is(err, comments.ErrNotFound) || (err == nil && id != sh.DraftID):
			continue // the draft is gone; the grant no longer applies
		case err != nil:
			return nil, storeErr(err)
		}
		out = append(out, SharedDraft{Share: sh, Size: d.Size, UpdatedAt: d.UpdatedAt})
	}
	return out, nil
}

// SharedDraft returns a shared draft with its content: the draft's current
// version, only while the grant is active and the draft is the one that was
// shared (a draft deleted and recreated at the same path is not).
func (s *Service) SharedDraft(ctx context.Context, a comments.Actor, repoID int64, shareID string) (Share, drafts.Draft, error) {
	if err := s.checkAdminFresh(ctx, a, repoID); err != nil {
		return Share{}, drafts.Draft{}, err
	}
	if !validID(shareID) {
		return Share{}, drafts.Draft{}, comments.ErrNotFound
	}
	sh, err := s.cfg.Store.Share(ctx, shareID)
	switch {
	case errors.Is(err, comments.ErrNotFound):
		return Share{}, drafts.Draft{}, err
	case err != nil:
		return Share{}, drafts.Draft{}, storeErr(err)
	case sh.RepoID != repoID || !sh.Active(s.cfg.Clock.Now()):
		return Share{}, drafts.Draft{}, comments.ErrNotFound
	}
	if err := s.audit(ctx, a, repoID, ActionViewSharedDraft, "share:"+sh.ID); err != nil {
		return Share{}, drafts.Draft{}, err
	}
	d, err := s.cfg.Drafts.OpenByID(ctx, sh.Owner, sh.RepoID, sh.Path, sh.DraftID)
	if err != nil {
		return Share{}, drafts.Draft{}, err
	}
	return sh, d, nil
}

// Audit returns the repository's last MaxAuditList audit entries, newest
// first (this view included).
func (s *Service) Audit(ctx context.Context, a comments.Actor, repoID int64) ([]AuditEntry, error) {
	if err := s.requireAdmin(ctx, a, repoID, ActionViewAudit, "repo"); err != nil {
		return nil, err
	}
	list, err := s.cfg.Store.Audit(ctx, repoID, MaxAuditList)
	return list, storeErr(err)
}

// ShareDraft grants the repository's admins read-only access to one of the
// actor's drafts for ShareTTL. Sharing it again renews the grant.
func (s *Service) ShareDraft(ctx context.Context, a comments.Actor, repoID int64, path string) (Share, error) {
	if !comments.ValidPath(path) {
		return Share{}, invalid("path")
	}
	if err := s.checkMember(ctx, a, repoID); err != nil {
		return Share{}, err
	}
	draftID, _, err := s.cfg.Drafts.Lookup(ctx, a.UserID, repoID, path)
	if err != nil {
		return Share{}, err
	}
	now := s.cfg.Clock.Now().UTC()
	mine, err := s.cfg.Store.ActiveShares(ctx, repoID, a.UserID, now, MaxSharesPerOwner+1)
	if err != nil {
		return Share{}, storeErr(err)
	}
	exp := now.Add(s.cfg.ShareTTL)
	for _, sh := range mine {
		if sh.DraftID != draftID || sh.Path != path {
			continue
		}
		err := s.cfg.Store.ExtendShare(ctx, sh.ID, now, exp, s.entry(a, repoID, ActionShareCreate, "share:"+sh.ID))
		switch {
		case err == nil:
			sh.ExpiresAt = exp
			return sh, nil
		case !errors.Is(err, comments.ErrNotFound):
			return Share{}, storeErr(err)
		}
		// Revoked or expired meanwhile: create a fresh grant below.
	}
	if len(mine) >= MaxSharesPerOwner {
		return Share{}, invalid("shares")
	}
	sh := Share{ID: s.cfg.NewID(), DraftID: draftID, Owner: a.UserID, OwnerLogin: a.Login, RepoID: repoID, Path: path,
		CreatedAt: now, ExpiresAt: exp}
	if err := s.cfg.Store.CreateShare(ctx, sh, s.entry(a, repoID, ActionShareCreate, "share:"+sh.ID)); err != nil {
		return Share{}, storeErr(err)
	}
	return sh, nil
}

// UnshareDraft revokes the actor's active grants on the draft at path. It
// needs no repository access, so consent can always be withdrawn.
func (s *Service) UnshareDraft(ctx context.Context, a comments.Actor, repoID int64, path string) error {
	if a.UserID == "" {
		return comments.ErrUnauthenticated
	}
	if !comments.ValidPath(path) {
		return invalid("path")
	}
	if repoID <= 0 {
		return comments.ErrNotFound
	}
	ids, err := s.cfg.Store.RevokeShares(ctx, a.UserID, repoID, path, s.cfg.Clock.Now().UTC(),
		s.entry(a, repoID, ActionShareRevoke, ""))
	if err != nil {
		return storeErr(err)
	}
	if len(ids) == 0 {
		return comments.ErrNotFound
	}
	return nil
}

// MyShares lists the actor's active grants on the repository.
func (s *Service) MyShares(ctx context.Context, a comments.Actor, repoID int64) ([]Share, error) {
	if a.UserID == "" {
		return nil, comments.ErrUnauthenticated
	}
	if repoID <= 0 {
		return nil, comments.ErrNotFound
	}
	list, err := s.cfg.Store.ActiveShares(ctx, repoID, a.UserID, s.cfg.Clock.Now().UTC(), MaxSharesPerOwner)
	return list, storeErr(err)
}

// requireAdmin checks admin permission and audits the action.
func (s *Service) requireAdmin(ctx context.Context, a comments.Actor, repoID int64, action, target string) error {
	if err := s.checkAdmin(ctx, a, repoID); err != nil {
		return err
	}
	return s.audit(ctx, a, repoID, action, target)
}

func (s *Service) checkAdmin(ctx context.Context, a comments.Actor, repoID int64) error {
	return s.adminCheck(ctx, a, repoID, s.cfg.Guard.Check)
}

// checkAdminFresh re-asks GitHub (bypassing the 5-minute cache), so an admin
// demoted on GitHub cannot change data or read a shared draft meanwhile.
func (s *Service) checkAdminFresh(ctx context.Context, a comments.Actor, repoID int64) error {
	return s.adminCheck(ctx, a, repoID, s.cfg.Guard.CheckFresh)
}

type checkFunc func(ctx context.Context, userID string, repoID int64) (comments.RepoPermission, bool, error)

func (s *Service) adminCheck(ctx context.Context, a comments.Actor, repoID int64, check checkFunc) error {
	if a.UserID == "" {
		return comments.ErrUnauthenticated
	}
	if repoID <= 0 {
		return comments.ErrNotFound
	}
	p, _, err := check(ctx, a.UserID, repoID)
	switch {
	case err != nil:
		return accessErr(err)
	case !p.Pull:
		return comments.ErrNotFound
	case !p.Admin:
		return comments.ErrForbidden
	}
	return nil
}

// checkMember is the drafts and chat check: pull and not blocked.
func (s *Service) checkMember(ctx context.Context, a comments.Actor, repoID int64) error {
	if a.UserID == "" {
		return comments.ErrUnauthenticated
	}
	if repoID <= 0 {
		return comments.ErrNotFound
	}
	p, err := s.cfg.Guard.Permission(ctx, a.UserID, repoID)
	switch {
	case err != nil:
		return accessErr(err)
	case !p.Pull:
		return comments.ErrForbidden
	}
	return nil
}

func (s *Service) entry(a comments.Actor, repoID int64, action, target string) AuditEntry {
	return AuditEntry{ID: s.cfg.NewID(), RepoID: repoID, ActorID: a.UserID, ActorLogin: a.Login,
		Action: action, Target: target, At: s.cfg.Clock.Now().UTC()}
}

func (s *Service) audit(ctx context.Context, a comments.Actor, repoID int64, action, target string) error {
	err := s.cfg.Store.AppendAudit(ctx, s.entry(a, repoID, action, target))
	if err != nil {
		return fmt.Errorf("%w: audit: %w", comments.ErrUnavailable, err)
	}
	return nil
}

func accessErr(err error) error {
	switch {
	case errors.Is(err, comments.ErrNotFound), errors.Is(err, comments.ErrUnauthenticated),
		errors.Is(err, comments.ErrRateLimited), errors.Is(err, comments.ErrUnavailable):
		return err
	}
	return fmt.Errorf("%w: %w", comments.ErrUnavailable, err)
}

func storeErr(err error) error {
	var ve *comments.ValidationError
	if err == nil || errors.Is(err, comments.ErrNotFound) || errors.Is(err, comments.ErrConflict) || errors.As(err, &ve) {
		return err
	}
	return fmt.Errorf("%w: store: %w", comments.ErrUnavailable, err)
}

func invalid(field string) error { return &comments.ValidationError{Field: field} }

// validID accepts PocketBase record ids: 15 characters of [a-z0-9].
func validID(s string) bool {
	if len(s) != 15 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if (s[i] < 'a' || s[i] > 'z') && (s[i] < '0' || s[i] > '9') {
			return false
		}
	}
	return true
}

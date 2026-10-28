// Package notify sends galley's email notifications. Only direct asks are
// mailed (a review was requested from you, you were assigned), never
// activity digests; recipients opt in with a verified address, and every
// trigger is checked on GitHub with the caller's own token.
package notify

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/mail"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
)

// Kind is a kind of direct ask.
type Kind string

// Notification kinds. KindInvited is reserved for paper invitations.
const (
	KindReviewRequested Kind = "review_requested"
	KindAssigned        Kind = "assigned"
	KindInvited         Kind = "invited"
)

// AllKinds are the kinds a user can choose; new users get all of them.
var AllKinds = []Kind{KindReviewRequested, KindAssigned, KindInvited}

// Trigger results. Accepted does not say whether a mail went out, so callers
// cannot probe who opted in.
const (
	StatusAccepted = "accepted"
	StatusDisabled = "disabled"
)

// ErrDisabled means email is not configured on this server.
var ErrDisabled = errors.New("notify: disabled")

// Prefs are a user's notification settings as stored. Email holds the
// sealed address.
type Prefs struct {
	UserID    string
	Email     string
	Verified  bool
	Enabled   bool
	Kinds     []Kind
	UpdatedAt time.Time
}

// Store persists preferences and idempotency reservations. Missing
// preferences are comments.ErrNotFound.
type Store interface {
	Prefs(ctx context.Context, userID string) (Prefs, error)
	SavePrefs(ctx context.Context, p Prefs) error
	DeletePrefs(ctx context.Context, userID string) error
	// Reserve records an idempotency key (a hash) and reports false when it
	// already exists.
	Reserve(ctx context.Context, key string, at time.Time) (bool, error)
	Release(ctx context.Context, key string) error
	PurgeReservations(ctx context.Context, before time.Time) (int, error)
}

// Users maps a GitHub account id to the galley user id of someone who
// signed in to galley; others are comments.ErrNotFound. Ids, not logins:
// a login can be renamed and then taken by someone else.
type Users interface {
	UserIDByGitHubID(ctx context.Context, githubID int64) (string, error)
}

// Account is a GitHub user as GitHub reports it.
type Account struct {
	ID    int64
	Login string
}

// Issue is what the assignment check needs of an issue or pull request.
type Issue struct {
	Assignees   []Account
	PullRequest bool
}

// GitHub answers trigger checks with the caller's token. Missing pull
// requests and issues are comments.ErrNotFound.
type GitHub interface {
	RequestedReviewers(ctx context.Context, token, fullName string, number int) ([]Account, error)
	Issue(ctx context.Context, token, fullName string, number int) (Issue, error)
}

// Message is one email.
type Message struct {
	To, Subject, Text, HTML string
	IdempotencyKey          string
	Headers                 map[string]string
}

// Mailer delivers email (ResendMailer).
type Mailer interface {
	Send(ctx context.Context, m Message) error
}

// TokenSource returns the user's GitHub token (comments.CachedAccess.Token).
type TokenSource func(ctx context.Context, userID string) (string, error)

// Defaults for Config.
const (
	DefaultVerifyTTL      = 24 * time.Hour
	DefaultUnsubscribeTTL = 365 * 24 * time.Hour
	// ReservationRetention is how long idempotency keys are kept; they are
	// per day, so two days cover every time zone edge.
	ReservationRetention = 48 * time.Hour
)

// Config wires a Service.
type Config struct {
	Store  Store
	Users  Users
	GitHub GitHub
	// Access answers the caller's permission (the admin guard).
	Access comments.RepoAccess
	Token  TokenSource
	// Mailer nil disables notifications (no Resend key configured).
	Mailer Mailer
	// Sealer seals addresses at rest (the data key).
	Sealer comments.Sealer
	// LinkKey signs verification and unsubscribe links (HKDF from
	// GALLEY_TOKEN_KEY); at least 32 bytes.
	LinkKey []byte
	// PublicURL is the API base for links; FrontendOrigin the galley app.
	PublicURL      string
	FrontendOrigin string
	Clock          comments.Clock
	Logger         *slog.Logger
	// CallerLimiter limits triggers per caller (default 20, one per 30 s).
	CallerLimiter *comments.RateLimiter
	// RecipientLimiter limits mails per recipient (default 10, one per
	// 6 minutes); over the limit mails are dropped, not queued.
	RecipientLimiter *comments.RateLimiter
	// VerifyLimiter limits verification mails per user (default 3, one per
	// 10 minutes).
	VerifyLimiter *comments.RateLimiter
	// AddressLimiter limits verification mails per address, whoever asks
	// (default 3, one more every 8 hours: about 3 a day).
	AddressLimiter *comments.RateLimiter
	// GlobalVerifyLimiter caps verification mails for the whole server
	// (default 60, one more per minute).
	GlobalVerifyLimiter *comments.RateLimiter
	VerifyTTL           time.Duration
	UnsubscribeTTL      time.Duration
}

// Service runs the notification use cases.
type Service struct{ cfg Config }

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Users == nil || cfg.GitHub == nil || cfg.Access == nil || cfg.Token == nil || cfg.Sealer == nil {
		return nil, errors.New("notify: store, users, github, access, token and sealer are required")
	}
	if len(cfg.LinkKey) < 32 || cfg.PublicURL == "" || cfg.FrontendOrigin == "" {
		return nil, errors.New("notify: link key, public URL and frontend origin are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.CallerLimiter == nil {
		cfg.CallerLimiter = comments.NewRateLimiter(20, 30*time.Second, cfg.Clock)
	}
	if cfg.RecipientLimiter == nil {
		cfg.RecipientLimiter = comments.NewRateLimiter(10, 6*time.Minute, cfg.Clock)
	}
	if cfg.VerifyLimiter == nil {
		cfg.VerifyLimiter = comments.NewRateLimiter(3, 10*time.Minute, cfg.Clock)
	}
	if cfg.AddressLimiter == nil {
		cfg.AddressLimiter = comments.NewRateLimiter(3, 8*time.Hour, cfg.Clock)
	}
	if cfg.GlobalVerifyLimiter == nil {
		cfg.GlobalVerifyLimiter = comments.NewRateLimiter(60, time.Minute, cfg.Clock)
	}
	if cfg.VerifyTTL <= 0 {
		cfg.VerifyTTL = DefaultVerifyTTL
	}
	if cfg.UnsubscribeTTL <= 0 {
		cfg.UnsubscribeTTL = DefaultUnsubscribeTTL
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	cfg.FrontendOrigin = strings.TrimRight(cfg.FrontendOrigin, "/")
	return &Service{cfg: cfg}, nil
}

// Available reports whether email is configured.
func (s *Service) Available() bool { return s.cfg.Mailer != nil }

// Settings is what a user sees of their preferences.
type Settings struct {
	Available bool
	Email     string
	Verified  bool
	Enabled   bool
	Kinds     []Kind
}

// Update is a settings change. An empty Email (with Enabled false) deletes
// the preferences. Nil Kinds means every kind.
type Update struct {
	Email   string
	Enabled bool
	Kinds   []Kind
}

// Settings returns the actor's preferences.
func (s *Service) Settings(ctx context.Context, a comments.Actor) (Settings, error) {
	if a.UserID == "" {
		return Settings{}, comments.ErrUnauthenticated
	}
	if !s.Available() {
		return Settings{Available: false, Kinds: []Kind{}}, nil
	}
	p, email, err := s.prefs(ctx, a.UserID)
	if errors.Is(err, comments.ErrNotFound) {
		return Settings{Available: true, Kinds: slices.Clone(AllKinds)}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	return Settings{Available: true, Email: email, Verified: p.Verified, Enabled: p.Enabled, Kinds: p.Kinds}, nil
}

// UpdateSettings stores the actor's preferences. A new address is stored
// unverified and gets a verification mail; saving an unverified address
// again resends it (rate limited).
func (s *Service) UpdateSettings(ctx context.Context, a comments.Actor, in Update) (Settings, error) {
	if a.UserID == "" {
		return Settings{}, comments.ErrUnauthenticated
	}
	if !s.Available() {
		return Settings{}, ErrDisabled
	}
	in.Email = strings.TrimSpace(in.Email)
	if in.Email == "" {
		if in.Enabled {
			return Settings{}, &comments.ValidationError{Field: "email"}
		}
		if err := s.cfg.Store.DeletePrefs(ctx, a.UserID); err != nil && !errors.Is(err, comments.ErrNotFound) {
			return Settings{}, unavailable(err)
		}
		return s.Settings(ctx, a)
	}
	if !validEmail(in.Email) {
		return Settings{}, &comments.ValidationError{Field: "email"}
	}
	kinds := AllKinds
	if in.Kinds != nil {
		kinds = nil
		for _, k := range in.Kinds {
			if !slices.Contains(AllKinds, k) {
				return Settings{}, &comments.ValidationError{Field: "kinds"}
			}
			if !slices.Contains(kinds, k) {
				kinds = append(kinds, k)
			}
		}
	}

	old, oldEmail, err := s.prefs(ctx, a.UserID)
	if err != nil && !errors.Is(err, comments.ErrNotFound) {
		return Settings{}, err
	}
	verified := err == nil && old.Verified && strings.EqualFold(oldEmail, in.Email)
	if !verified && !s.allowVerification(a.UserID, in.Email) {
		return Settings{}, comments.ErrRateLimited
	}
	sealed, err := s.cfg.Sealer.Seal([]byte(in.Email), emailAAD(a.UserID))
	if err != nil {
		return Settings{}, err
	}
	p := Prefs{UserID: a.UserID, Email: sealed, Verified: verified, Enabled: in.Enabled, Kinds: slices.Clone(kinds), UpdatedAt: s.cfg.Clock.Now().UTC()}
	if err := s.cfg.Store.SavePrefs(ctx, p); err != nil {
		return Settings{}, unavailable(err)
	}
	if !verified {
		if err := s.sendVerification(ctx, a, in.Email); err != nil {
			return Settings{}, err
		}
	}
	return Settings{Available: true, Email: in.Email, Verified: verified, Enabled: in.Enabled, Kinds: p.Kinds}, nil
}

// allowVerification applies the per-user, per-address and global limits on
// verification mails, so nobody can use galley to flood an inbox.
func (s *Service) allowVerification(userID, email string) bool {
	return s.cfg.VerifyLimiter.Allow(userID) &&
		s.cfg.AddressLimiter.Allow(emailHash(email)) &&
		s.cfg.GlobalVerifyLimiter.Allow("global")
}

// sendVerification mails the link. The mail does not name the requester:
// the address may not be theirs.
func (s *Service) sendVerification(ctx context.Context, a comments.Actor, email string) error {
	tok := signLink(s.cfg.LinkKey, purposeVerify, a.UserID, email, s.cfg.Clock.Now().Add(s.cfg.VerifyTTL))
	link := s.cfg.PublicURL + "/api/galley/me/notifications/verify?token=" + url.QueryEscape(tok)
	text := "Someone using galley asked to send notifications to this address. To confirm, open:\n\n" + link +
		"\n\nThe link works for 24 hours. If you did not ask for this, ignore this email: nothing will be sent to you.\n"
	h := "<p>Someone using galley asked to send notifications to this address.</p>" +
		`<p><a href="` + html.EscapeString(link) + `">Confirm address</a></p>` +
		"<p>The link works for 24 hours. If you did not ask for this, ignore this email: nothing will be sent to you.</p>"
	err := s.cfg.Mailer.Send(ctx, Message{To: email, Subject: "Confirm your galley notification address", Text: text, HTML: h})
	if err != nil {
		s.cfg.Logger.Error("verification mail failed", "to", MaskEmail(email), "error", err)
		return fmt.Errorf("%w: verification mail", comments.ErrUnavailable)
	}
	s.cfg.Logger.Info("verification mail sent", "to", MaskEmail(email))
	return nil
}

// Verify marks the address of a verification link verified. Invalid,
// expired or stale links are comments.ErrNotFound.
func (s *Service) Verify(ctx context.Context, token string) error {
	return s.applyLink(ctx, token, purposeVerify, func(p *Prefs) { p.Verified = true })
}

// Unsubscribe turns notifications off for the address of an unsubscribe
// link. It is idempotent.
func (s *Service) Unsubscribe(ctx context.Context, token string) error {
	err := s.applyLink(ctx, token, purposeUnsubscribe, func(p *Prefs) { p.Enabled = false })
	if errors.Is(err, errNoPrefs) {
		return nil // already gone
	}
	return err
}

var errNoPrefs = errors.New("notify: no preferences")

func (s *Service) applyLink(ctx context.Context, token, purpose string, apply func(*Prefs)) error {
	c, err := openLink(s.cfg.LinkKey, token, purpose, s.cfg.Clock.Now())
	if err != nil {
		return comments.ErrNotFound
	}
	p, email, err := s.prefs(ctx, c.User)
	switch {
	case errors.Is(err, comments.ErrNotFound) && purpose == purposeUnsubscribe:
		return errNoPrefs
	case errors.Is(err, comments.ErrNotFound):
		return comments.ErrNotFound
	case err != nil:
		return err
	}
	if emailHash(email) != c.Email {
		return comments.ErrNotFound
	}
	apply(&p)
	p.UpdatedAt = s.cfg.Clock.Now().UTC()
	if err := s.cfg.Store.SavePrefs(ctx, p); err != nil {
		return unavailable(err)
	}
	return nil
}

// Result is a trigger's outcome.
type Result struct{ Status string }

// ReviewRequested mails reviewer that the actor requested their review on
// pull request number. The actor needs push, and reviewer must be among the
// pull request's requested reviewers on GitHub (checked with the actor's
// token).
func (s *Service) ReviewRequested(ctx context.Context, a comments.Actor, repoID int64, number int, reviewer string) (Result, error) {
	return s.trigger(ctx, a, KindReviewRequested, repoID, number, true, reviewer, func(token, repo string) (int64, error) {
		accounts, err := s.cfg.GitHub.RequestedReviewers(ctx, token, repo, number)
		if err != nil {
			return 0, githubErr(err)
		}
		return member(accounts, reviewer)
	})
}

// Assigned mails assignee that the actor assigned them to an issue or pull
// request (pullRequest says which number was given). The actor needs push,
// and assignee must be among its assignees on GitHub.
func (s *Service) Assigned(ctx context.Context, a comments.Actor, repoID int64, number int, pullRequest bool, assignee string) (Result, error) {
	return s.trigger(ctx, a, KindAssigned, repoID, number, pullRequest, assignee, func(token, repo string) (int64, error) {
		is, err := s.cfg.GitHub.Issue(ctx, token, repo, number)
		if err != nil {
			return 0, githubErr(err)
		}
		if is.PullRequest != pullRequest {
			return 0, comments.ErrNotFound
		}
		return member(is.Assignees, assignee)
	})
}

var loginPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)

const maxNumber = 1_000_000_000

func (s *Service) trigger(ctx context.Context, a comments.Actor, kind Kind, repoID int64, number int, pullRequest bool, login string, check func(token, repo string) (githubID int64, err error)) (Result, error) {
	if a.UserID == "" {
		return Result{}, comments.ErrUnauthenticated
	}
	if !s.Available() {
		return Result{Status: StatusDisabled}, nil
	}
	switch {
	case repoID <= 0:
		return Result{}, &comments.ValidationError{Field: "repo_id"}
	case number <= 0 || number > maxNumber:
		return Result{}, &comments.ValidationError{Field: "number"}
	case !loginPattern.MatchString(login):
		return Result{}, &comments.ValidationError{Field: "login"}
	}
	if !s.cfg.CallerLimiter.Allow(a.UserID) {
		return Result{}, comments.ErrRateLimited
	}
	perm, err := s.cfg.Access.Permission(ctx, a.UserID, repoID)
	if err != nil {
		return Result{}, err
	}
	if !perm.Push {
		return Result{}, comments.ErrForbidden
	}
	token, err := s.cfg.Token(ctx, a.UserID)
	if errors.Is(err, comments.ErrUnauthenticated) {
		return Result{}, err
	}
	if err != nil {
		return Result{}, unavailable(err)
	}
	githubID, err := check(token, perm.FullName)
	if err != nil {
		return Result{}, err
	}

	accepted := Result{Status: StatusAccepted}
	recipient, err := s.cfg.Users.UserIDByGitHubID(ctx, githubID)
	if errors.Is(err, comments.ErrNotFound) || (err == nil && recipient == a.UserID) {
		return accepted, nil
	}
	if err != nil {
		return Result{}, unavailable(err)
	}
	p, email, err := s.prefs(ctx, recipient)
	if errors.Is(err, comments.ErrNotFound) {
		return accepted, nil
	}
	if err != nil {
		return Result{}, err
	}
	if !p.Verified || !p.Enabled || !slices.Contains(p.Kinds, kind) {
		return accepted, nil
	}

	now := s.cfg.Clock.Now().UTC()
	key := idempotencyKey(kind, repoID, number, recipient, now)
	fresh, err := s.cfg.Store.Reserve(ctx, key, now)
	if err != nil {
		return Result{}, unavailable(err)
	}
	if !fresh {
		return accepted, nil
	}
	if !s.cfg.RecipientLimiter.Allow(recipient) {
		_ = s.cfg.Store.Release(ctx, key)
		s.cfg.Logger.Warn("notification dropped: recipient rate limited", "kind", string(kind), "to", MaskEmail(email))
		return accepted, nil
	}
	msg := s.message(a, kind, perm.FullName, number, pullRequest, recipient, email)
	msg.IdempotencyKey = key
	if err := s.cfg.Mailer.Send(ctx, msg); err != nil {
		_ = s.cfg.Store.Release(ctx, key)
		s.cfg.Logger.Error("notification failed", "kind", string(kind), "to", MaskEmail(email), "error", err)
		return Result{}, fmt.Errorf("%w: notification mail", comments.ErrUnavailable)
	}
	s.cfg.Logger.Info("notification sent", "kind", string(kind), "to", MaskEmail(email))
	return accepted, nil
}

// message builds a mail with no paper text: who asked what, where, a link to
// the galley route and the unsubscribe link.
func (s *Service) message(a comments.Actor, kind Kind, repo string, number int, pullRequest bool, recipient, email string) Message {
	owner, name, _ := strings.Cut(repo, "/")
	base := s.cfg.FrontendOrigin + "/#/r/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	what, link := "issue", base
	if pullRequest {
		what, link = "proposal", base+"/proposals/"+strconv.Itoa(number)
	}
	where := fmt.Sprintf("%s #%d in %s", what, number, repo)
	var subject, line string
	switch kind {
	case KindReviewRequested:
		subject = fmt.Sprintf("Review requested: %s #%d", repo, number)
		line = a.Login + " asked you to review " + where + "."
	default:
		subject = fmt.Sprintf("Assigned: %s #%d", repo, number)
		line = a.Login + " assigned you to " + where + "."
	}
	// The expiry counts from the UTC day, so every mail of a day (and a
	// retried send) carries the same link.
	day := s.cfg.Clock.Now().UTC().Truncate(24 * time.Hour)
	unsub := s.cfg.PublicURL + "/api/galley/unsubscribe?token=" +
		url.QueryEscape(signLink(s.cfg.LinkKey, purposeUnsubscribe, recipient, email, day.Add(s.cfg.UnsubscribeTTL)))
	footer := "You get this because you turned on galley email for direct requests."
	text := line + "\n\nOpen it in galley:\n" + link + "\n\n--\n" + footer + "\nUnsubscribe: " + unsub + "\n"
	h := "<p>" + html.EscapeString(line) + "</p>" +
		`<p><a href="` + html.EscapeString(link) + `">Open it in galley</a></p>` +
		`<p style="color:#666;font-size:12px">` + html.EscapeString(footer) +
		` <a href="` + html.EscapeString(unsub) + `">Unsubscribe</a></p>`
	return Message{
		To: email, Subject: subject, Text: text, HTML: h,
		Headers: map[string]string{
			"List-Unsubscribe":      "<" + unsub + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	}
}

// idempotencyKey hashes (kind, repo, number, recipient, UTC day).
func idempotencyKey(kind Kind, repoID int64, number int, recipient string, now time.Time) string {
	sum := sha256.Sum256(fmt.Appendf(nil, "%s|%d|%d|%s|%s", kind, repoID, number, recipient, now.Format("2006-01-02")))
	return hex.EncodeToString(sum[:])
}

// prefs loads and opens a user's preferences.
func (s *Service) prefs(ctx context.Context, userID string) (Prefs, string, error) {
	p, err := s.cfg.Store.Prefs(ctx, userID)
	if errors.Is(err, comments.ErrNotFound) {
		return Prefs{}, "", comments.ErrNotFound
	}
	if err != nil {
		return Prefs{}, "", unavailable(err)
	}
	email, err := s.cfg.Sealer.Open(p.Email, emailAAD(userID))
	if err != nil {
		return Prefs{}, "", fmt.Errorf("notify: open address: %w", err)
	}
	return p, string(email), nil
}

func emailAAD(userID string) []byte { return []byte("galley/v1/notify/" + userID + "/email") }

// validEmail accepts a bare ASCII address (no display name), at most 254
// bytes, with a dot in the domain.
func validEmail(s string) bool {
	if len(s) > 254 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] <= ' ' || s[i] >= 0x7f {
			return false
		}
	}
	addr, err := mail.ParseAddress(s)
	if err != nil || addr.Address != s || addr.Name != "" {
		return false
	}
	local, domain, _ := strings.Cut(s, "@")
	return len(local) <= 64 && strings.Contains(domain, ".") && !strings.HasPrefix(domain, ".") && !strings.HasSuffix(domain, ".")
}

// member returns the GitHub id of login among accounts.
func member(accounts []Account, login string) (int64, error) {
	for _, a := range accounts {
		if a.ID > 0 && strings.EqualFold(a.Login, login) {
			return a.ID, nil
		}
	}
	return 0, comments.ErrConflict
}

func githubErr(err error) error {
	switch {
	case errors.Is(err, comments.ErrNotFound), errors.Is(err, comments.ErrUnauthenticated):
		return err
	default:
		return unavailable(err)
	}
}

func unavailable(err error) error { return fmt.Errorf("%w: %w", comments.ErrUnavailable, err) }

// Purge drops idempotency keys older than ReservationRetention.
func (s *Service) Purge(ctx context.Context) (int, error) {
	return s.cfg.Store.PurgeReservations(ctx, s.cfg.Clock.Now().Add(-ReservationRetention))
}

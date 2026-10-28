package notify_test

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
	"github.com/FullFran/galley/server/internal/secret"
)

var ctx = context.Background()

type memStore struct {
	mu       sync.Mutex
	prefs    map[string]notify.Prefs
	reserved map[string]time.Time
}

func (s *memStore) Prefs(_ context.Context, userID string) (notify.Prefs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.prefs[userID]
	if !ok {
		return notify.Prefs{}, comments.ErrNotFound
	}
	return p, nil
}

func (s *memStore) SavePrefs(_ context.Context, p notify.Prefs) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prefs[p.UserID] = p
	return nil
}

func (s *memStore) DeletePrefs(_ context.Context, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.prefs, userID)
	return nil
}

func (s *memStore) Reserve(_ context.Context, key string, at time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.reserved[key]; ok {
		return false, nil
	}
	s.reserved[key] = at
	return true, nil
}

func (s *memStore) Release(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.reserved, key)
	return nil
}

func (s *memStore) PurgeReservations(_ context.Context, before time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k, at := range s.reserved {
		if at.Before(before) {
			delete(s.reserved, k)
			n++
		}
	}
	return n, nil
}

type users map[int64]string // GitHub id -> user id

func (u users) UserIDByGitHubID(_ context.Context, id int64) (string, error) {
	if uid, ok := u[id]; ok {
		return uid, nil
	}
	return "", comments.ErrNotFound
}

// GitHub accounts: ids are what map to galley users, never logins.
var (
	frank = notify.Account{ID: 1, Login: "fran"}
	bobby = notify.Account{ID: 2, Login: "Bob"}
)

type fakeGH struct {
	reviewers []notify.Account
	issue     notify.Issue
	token     string
}

func (f *fakeGH) RequestedReviewers(_ context.Context, token, fullName string, n int) ([]notify.Account, error) {
	f.token = token
	if fullName != "o/r" || n != 12 {
		return nil, comments.ErrNotFound
	}
	return f.reviewers, nil
}

func (f *fakeGH) Issue(_ context.Context, token, fullName string, n int) (notify.Issue, error) {
	f.token = token
	if fullName != "o/r" || n != 12 {
		return notify.Issue{}, comments.ErrNotFound
	}
	return f.issue, nil
}

type access map[string]comments.RepoPermission

func (a access) Permission(_ context.Context, userID string, repoID int64) (comments.RepoPermission, error) {
	if p, ok := a[userID]; ok && repoID == 7 {
		return p, nil
	}
	return comments.RepoPermission{}, comments.ErrNotFound
}

type outbox struct {
	mu   sync.Mutex
	sent []notify.Message
	err  error
}

func (o *outbox) Send(_ context.Context, m notify.Message) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err != nil {
		return o.err
	}
	o.sent = append(o.sent, m)
	return nil
}

func (o *outbox) last() notify.Message {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.sent[len(o.sent)-1]
}

func (o *outbox) count() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.sent)
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

type env struct {
	svc   *notify.Service
	store *memStore
	mail  *outbox
	gh    *fakeGH
	clock *fakeClock
	fran  comments.Actor // pusher
	bob   comments.Actor // reviewer
	eve   comments.Actor // pull only
}

func newEnv(t *testing.T, mut ...func(*notify.Config)) *env {
	t.Helper()
	sealer, err := secret.NewSealer(bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{
		store: &memStore{prefs: map[string]notify.Prefs{}, reserved: map[string]time.Time{}},
		mail:  &outbox{},
		gh:    &fakeGH{reviewers: []notify.Account{bobby}, issue: notify.Issue{Assignees: []notify.Account{bobby}, PullRequest: true}},
		clock: &fakeClock{now: time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)},
		fran:  comments.Actor{UserID: "ufran", Login: "fran"},
		bob:   comments.Actor{UserID: "ubob", Login: "bob"},
		eve:   comments.Actor{UserID: "ueve", Login: "eve"},
	}
	cfg := notify.Config{
		Store:  e.store,
		Users:  users{1: "ufran", 2: "ubob", 3: "ueve"},
		GitHub: e.gh,
		Access: access{
			"ufran": {FullName: "o/r", Pull: true, Push: true},
			"ubob":  {FullName: "o/r", Pull: true, Push: true},
			"ueve":  {FullName: "o/r", Pull: true},
		},
		Token:          func(_ context.Context, userID string) (string, error) { return "tok-" + userID, nil },
		Mailer:         e.mail,
		Sealer:         sealer,
		LinkKey:        bytes.Repeat([]byte{2}, 32),
		PublicURL:      "https://api.example.com",
		FrontendOrigin: "https://galley.example.com",
		Clock:          e.clock,
	}
	for _, m := range mut {
		m(&cfg)
	}
	if e.svc, err = notify.NewService(cfg); err != nil {
		t.Fatal(err)
	}
	return e
}

// tokenFrom extracts the token query parameter of the first link in text
// that contains path.
func tokenFrom(t *testing.T, text, path string) string {
	t.Helper()
	for _, f := range strings.Fields(text) {
		f = strings.Trim(f, "<>")
		if strings.Contains(f, path) {
			u, err := url.Parse(f)
			if err != nil {
				t.Fatal(err)
			}
			return u.Query().Get("token")
		}
	}
	t.Fatalf("no %s link in %q", path, text)
	return ""
}

// optIn subscribes bob and verifies the address.
func (e *env) optIn(t *testing.T) {
	t.Helper()
	if _, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "bob@example.com", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Verify(ctx, tokenFrom(t, e.mail.last().Text, "/verify")); err != nil {
		t.Fatal(err)
	}
}

func TestVerificationMailDoesNotNameTheRequester(t *testing.T) {
	e := newEnv(t)
	if _, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "victim@example.com", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	m := e.mail.last()
	if strings.Contains(m.Text, "bob") || strings.Contains(m.HTML, "bob") || !strings.Contains(m.Text, "Someone using galley") {
		t.Errorf("mail = %q", m.Text)
	}
}

func TestVerificationMailsAreLimitedPerAddressAndGlobally(t *testing.T) {
	e := newEnv(t)
	// Many users asking for one address: at most 3 mails to it a day.
	var err error
	sent := 0
	for i := 0; i < 6; i++ {
		a := comments.Actor{UserID: "u" + string(rune('a'+i)), Login: "x"}
		if _, err = e.svc.UpdateSettings(ctx, a, notify.Update{Email: "Victim@example.com", Enabled: true}); err == nil {
			sent++
		}
	}
	if sent != 3 || !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("sent %d to one address, last err %v", sent, err)
	}

	e = newEnv(t, func(c *notify.Config) { c.GlobalVerifyLimiter = comments.NewRateLimiter(2, time.Hour, c.Clock) })
	sent = 0
	for i := 0; i < 4; i++ {
		a := comments.Actor{UserID: "u" + string(rune('a'+i)), Login: "x"}
		if _, err = e.svc.UpdateSettings(ctx, a, notify.Update{Email: "v" + string(rune('a'+i)) + "@example.com", Enabled: true}); err == nil {
			sent++
		}
	}
	if sent != 2 || !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("global cap: sent %d, last err %v", sent, err)
	}
}

func TestRecipientsAreMappedByGitHubID(t *testing.T) {
	e := newEnv(t)
	e.optIn(t)
	n := e.mail.count()
	// Someone now holds the login "bob" on GitHub, but with another id: the
	// galley user bob (id 2) must not get the mail.
	e.gh.reviewers = []notify.Account{{ID: 99, Login: "bob"}}
	if r, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil || r.Status != notify.StatusAccepted || e.mail.count() != n {
		t.Errorf("renamed login = %+v %v, mails %d", r, err, e.mail.count()-n)
	}
}

func TestUnsubscribeLinkIsStableWithinADay(t *testing.T) {
	e := newEnv(t)
	e.optIn(t)
	e.gh.issue = notify.Issue{Assignees: []notify.Account{bobby}, PullRequest: true}
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil {
		t.Fatal(err)
	}
	first := e.mail.last().Headers["List-Unsubscribe"]
	e.clock.Advance(3 * time.Hour)
	if _, err := e.svc.Assigned(ctx, e.fran, 7, 12, true, "bob"); err != nil {
		t.Fatal(err)
	}
	if got := e.mail.last().Headers["List-Unsubscribe"]; got != first {
		t.Errorf("unsubscribe link changed within the day:\n%s\n%s", first, got)
	}
}

func TestOptInAndVerification(t *testing.T) {
	e := newEnv(t)
	s, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "bob@example.com", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if !s.Available || s.Verified || !s.Enabled || s.Email != "bob@example.com" || len(s.Kinds) == 0 {
		t.Errorf("settings = %+v", s)
	}
	if p := e.store.prefs["ubob"]; strings.Contains(p.Email, "bob@") {
		t.Error("the address must be sealed in the store")
	}
	msg := e.mail.last()
	if msg.To != "bob@example.com" || !strings.Contains(msg.Text, "https://api.example.com/api/galley/me/notifications/verify?token=") {
		t.Errorf("verification mail = %+v", msg)
	}
	tok := tokenFrom(t, msg.Text, "/verify")

	// Unverified addresses get nothing.
	if r, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil || r.Status != notify.StatusAccepted || e.mail.count() != 1 {
		t.Errorf("unverified send = %+v %v (mails %d)", r, err, e.mail.count())
	}

	if err := e.svc.Verify(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.svc.Settings(ctx, e.bob); !s.Verified {
		t.Error("not verified")
	}
	// The token is bound to the user and the address.
	if err := e.svc.Verify(ctx, tok+"x"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("tampered err = %v", err)
	}
	if _, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "bob2@example.com", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Verify(ctx, tok); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("token of an old address err = %v", err)
	}
	if s, _ := e.svc.Settings(ctx, e.bob); s.Verified {
		t.Error("a changed address must be verified again")
	}

	// Verification links expire.
	tok2 := tokenFrom(t, e.mail.last().Text, "/verify")
	e.clock.Advance(25 * time.Hour)
	if err := e.svc.Verify(ctx, tok2); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("expired err = %v", err)
	}
}

func TestSettingsValidation(t *testing.T) {
	e := newEnv(t)
	var ve *comments.ValidationError
	for _, in := range []notify.Update{
		{Email: "not an email", Enabled: true},
		{Email: "Bob <bob@example.com>", Enabled: true},
		{Email: "bob@example.com\r\nBcc: x@y.z", Enabled: true},
		{Email: strings.Repeat("a", 250) + "@example.com", Enabled: true},
		{Email: "bob@example.com", Enabled: true, Kinds: []notify.Kind{"digest"}},
		{Email: "", Enabled: true},
	} {
		if _, err := e.svc.UpdateSettings(ctx, e.bob, in); !errors.As(err, &ve) {
			t.Errorf("UpdateSettings(%+v) err = %v", in, err)
		}
	}
	// Clearing the address deletes the preferences.
	e.optIn(t)
	if _, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{}); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.svc.Settings(ctx, e.bob); s.Email != "" || s.Enabled {
		t.Errorf("after clearing = %+v", s)
	}
}

func TestVerificationMailsAreRateLimited(t *testing.T) {
	e := newEnv(t, func(c *notify.Config) { c.AddressLimiter = comments.NewRateLimiter(100, time.Second, c.Clock) })
	var err error
	for i := 0; i < 5 && err == nil; i++ {
		_, err = e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "bob@example.com", Enabled: true})
	}
	if !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("err = %v", err)
	}
}

func TestReviewRequestedSendsOneMail(t *testing.T) {
	e := newEnv(t)
	e.optIn(t)
	before := e.mail.count()
	r, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob")
	if err != nil || r.Status != notify.StatusAccepted {
		t.Fatalf("send = %+v %v", r, err)
	}
	if e.mail.count() != before+1 {
		t.Fatalf("mails = %d", e.mail.count()-before)
	}
	if e.gh.token != "tok-ufran" {
		t.Errorf("reviewers checked with %q, want the caller's token", e.gh.token)
	}
	m := e.mail.last()
	if m.To != "bob@example.com" || !strings.Contains(m.Subject, "o/r #12") || !strings.Contains(m.Text, "fran") ||
		!strings.Contains(m.Text, "https://galley.example.com/#/r/o/r/proposals/12") || m.IdempotencyKey == "" {
		t.Errorf("mail = %+v", m)
	}
	if !strings.HasPrefix(m.Headers["List-Unsubscribe"], "<https://api.example.com/api/galley/unsubscribe?token=") ||
		m.Headers["List-Unsubscribe-Post"] != "List-Unsubscribe=One-Click" {
		t.Errorf("headers = %v", m.Headers)
	}
	if !strings.Contains(m.HTML, "proposals/12") || strings.Contains(m.HTML, "<script") {
		t.Errorf("html = %q", m.HTML)
	}

	// Idempotent per (kind, repo, number, recipient, day).
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "Bob"); err != nil || e.mail.count() != before+1 {
		t.Errorf("duplicate sent (%v)", err)
	}
	if _, err := e.svc.Assigned(ctx, e.fran, 7, 12, true, "bob"); err != nil || e.mail.count() != before+2 {
		t.Errorf("another kind not sent (%v)", err)
	}
	e.clock.Advance(24 * time.Hour)
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil || e.mail.count() != before+3 {
		t.Errorf("next day not sent (%v)", err)
	}
}

func TestTriggerVerification(t *testing.T) {
	e := newEnv(t)
	e.optIn(t)
	before := e.mail.count()
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "eve"); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("reviewer not requested err = %v", err)
	}
	if _, err := e.svc.ReviewRequested(ctx, e.eve, 7, 12, "bob"); !errors.Is(err, comments.ErrForbidden) {
		t.Errorf("caller without push err = %v", err)
	}
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 8, 12, "bob"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("invisible repository err = %v", err)
	}
	if _, err := e.svc.Assigned(ctx, e.fran, 7, 12, false, "bob"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("issue_number for a pull request err = %v", err)
	}
	if _, err := e.svc.Assigned(ctx, e.fran, 7, 12, true, "eve"); !errors.Is(err, comments.ErrConflict) {
		t.Errorf("not assigned err = %v", err)
	}
	var ve *comments.ValidationError
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bad login!"); !errors.As(err, &ve) {
		t.Errorf("bad login err = %v", err)
	}
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 0, "bob"); !errors.As(err, &ve) {
		t.Errorf("bad number err = %v", err)
	}
	if e.mail.count() != before {
		t.Errorf("mails = %d", e.mail.count()-before)
	}
}

func TestRecipientsWhoDidNotOptInGetNothing(t *testing.T) {
	e := newEnv(t)
	e.gh.reviewers = []notify.Account{bobby, {ID: 50, Login: "stranger"}, frank}
	for _, login := range []string{"bob", "stranger", "fran"} {
		r, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, login)
		if err != nil || r.Status != notify.StatusAccepted {
			t.Errorf("%s = %+v %v", login, r, err)
		}
	}
	if e.mail.count() != 0 {
		t.Errorf("mails = %d", e.mail.count())
	}
	// Opted out of the kind.
	if _, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "bob@example.com", Enabled: true, Kinds: []notify.Kind{notify.KindAssigned}}); err != nil {
		t.Fatal(err)
	}
	_ = e.svc.Verify(ctx, tokenFrom(t, e.mail.last().Text, "/verify"))
	n := e.mail.count()
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil || e.mail.count() != n {
		t.Errorf("kind not chosen was sent (%v)", err)
	}
}

func TestSendFailureReleasesTheKey(t *testing.T) {
	e := newEnv(t)
	e.optIn(t)
	e.mail.err = errors.New("resend down")
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); !errors.Is(err, comments.ErrUnavailable) {
		t.Errorf("err = %v", err)
	}
	e.mail.err = nil
	n := e.mail.count()
	if _, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil || e.mail.count() != n+1 {
		t.Errorf("retry not sent (%v)", err)
	}
}

func TestSendsAreRateLimited(t *testing.T) {
	e := newEnv(t, func(c *notify.Config) {
		c.CallerLimiter = comments.NewRateLimiter(2, time.Hour, c.Clock)
	})
	var err error
	for n := 0; n < 3 && err == nil; n++ {
		_, err = e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob")
	}
	if !errors.Is(err, comments.ErrRateLimited) {
		t.Errorf("caller limit err = %v", err)
	}

	e = newEnv(t, func(c *notify.Config) {
		c.RecipientLimiter = comments.NewRateLimiter(1, time.Hour, c.Clock)
	})
	e.optIn(t)
	n := e.mail.count()
	_, _ = e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob")
	r, err := e.svc.Assigned(ctx, e.fran, 7, 12, true, "bob")
	if err != nil || r.Status != notify.StatusAccepted || e.mail.count() != n+1 {
		t.Errorf("recipient limit = %+v %v, mails %d", r, err, e.mail.count()-n)
	}
}

func TestUnsubscribe(t *testing.T) {
	e := newEnv(t)
	e.optIn(t)
	_, _ = e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob")
	h := e.mail.last().Headers["List-Unsubscribe"]
	tok := tokenFrom(t, h, "/unsubscribe")
	if err := e.svc.Unsubscribe(ctx, "bogus"); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("bogus err = %v", err)
	}
	if err := e.svc.Unsubscribe(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Unsubscribe(ctx, tok); err != nil {
		t.Errorf("second unsubscribe err = %v", err)
	}
	if s, _ := e.svc.Settings(ctx, e.bob); s.Enabled {
		t.Error("still enabled")
	}
	n := e.mail.count()
	if _, err := e.svc.Assigned(ctx, e.fran, 7, 12, true, "bob"); err != nil || e.mail.count() != n {
		t.Errorf("sent after unsubscribing (%v)", err)
	}
	// A verification token cannot unsubscribe and vice versa.
	if err := e.svc.Verify(ctx, tok); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("unsubscribe token verified: %v", err)
	}
}

func TestDisabledWithoutMailer(t *testing.T) {
	e := newEnv(t, func(c *notify.Config) { c.Mailer = nil })
	if s, err := e.svc.Settings(ctx, e.bob); err != nil || s.Available {
		t.Errorf("settings = %+v %v", s, err)
	}
	if _, err := e.svc.UpdateSettings(ctx, e.bob, notify.Update{Email: "bob@example.com", Enabled: true}); !errors.Is(err, notify.ErrDisabled) {
		t.Errorf("update err = %v", err)
	}
	if r, err := e.svc.ReviewRequested(ctx, e.fran, 7, 12, "bob"); err != nil || r.Status != notify.StatusDisabled {
		t.Errorf("trigger = %+v %v", r, err)
	}
}

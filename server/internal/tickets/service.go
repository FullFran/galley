// Package tickets lets signed-in people report a problem with galley, and lets
// the deployment's ticket admins triage the reports. It is not tied to a
// repository: a ticket belongs to the deployment. What people type and the
// technical snapshot are sealed at rest, because a report can quote an
// unpublished paper; mail never carries them. Nothing becomes public: an admin
// opens a GitHub issue by hand.
package tickets

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
)

// Field limits, in characters (diagnostics in bytes).
const (
	MaxDescription      = 2000
	MaxSteps            = 2000
	MaxVersion          = 40
	MaxDevice           = 200
	MaxDiagnosticsBytes = 16 << 10
)

// Statuses a ticket moves through while being triaged.
const (
	StatusNew     = "new"
	StatusTriaged = "triaged"
	StatusIssue   = "issue"
	StatusClosed  = "closed"
)

// Defaults for Config.
const (
	// DefaultDailyCap is how many tickets the server stores per UTC day, so a
	// flood cannot fill the disk or bury the real ones.
	DefaultDailyCap = 200
	// DefaultMailDailyLimit is how many tickets per UTC day send mail. Past it
	// they still wait in the inbox: a flood must not spend the quota that
	// notification mails share.
	DefaultMailDailyLimit = 20
	// DefaultListLimit is the most tickets one list answers.
	DefaultListLimit = 200
	writeBurst       = 5
	writeEvery       = 2 * time.Minute
	refAttempts      = 5
	mailTimeout      = 30 * time.Second
)

// refAlphabet is what a reference is drawn from; references identify, they are
// not secrets.
const refAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

var (
	// Categories a person can pick, in form order.
	Categories = []string{"bug", "saving", "preview", "interface", "performance", "suggestion", "other"}
	// Statuses are the values of a ticket's status.
	Statuses = []string{StatusNew, StatusTriaged, StatusIssue, StatusClosed}

	validRef = regexp.MustCompile(`^GL-[A-Z0-9]{6}$`)
)

// Input is what a person sends.
type Input struct {
	Category, Description, Steps, Version, Device string
	Diagnostics                                   json.RawMessage
}

// Record is a stored ticket. Description, Steps and Diagnostics are sealed;
// Diagnostics is empty when none were sent.
type Record struct {
	Ref, UserID, Login, Category, Status string
	Description, Steps, Diagnostics      string
	Version, Device                      string
	GitHubIssue                          int
	CreatedAt                            time.Time
}

// Ticket is what an admin reads.
type Ticket struct {
	Ref, Login, Category, Status string
	Description, Steps           string
	Version, Device              string
	Diagnostics                  json.RawMessage
	GitHubIssue                  int
	CreatedAt                    time.Time
	// Unreadable means a sealed field did not open (a changed key, a moved
	// value): the text is empty, the rest still reads and triages.
	Unreadable bool
}

// List is one page of the inbox, newest first; Total counts past the limit.
type List struct {
	Tickets []Ticket
	Total   int
}

// Change is an admin's triage. GitHubIssue zero keeps the current link.
type Change struct {
	Status      string
	GitHubIssue int
}

// Store persists tickets and the list of admins (pbstore.TicketStore).
type Store interface {
	// CreateTicket returns comments.ErrConflict when the reference is taken.
	CreateTicket(ctx context.Context, r Record) error
	ListTickets(ctx context.Context, status string, limit int) ([]Record, int, error)
	TicketByRef(ctx context.Context, ref string) (Record, error)
	// UpdateTicket sets the status, and the link unless issue is zero.
	UpdateTicket(ctx context.Context, ref, status string, issue int) (Record, error)
	CountTicketsSince(ctx context.Context, t time.Time) (int, error)
	IsTicketAdmin(ctx context.Context, userID string) (bool, error)
}

// Config wires a Service.
type Config struct {
	Store  Store
	Sealer comments.Sealer
	// Mailer and MailTo are optional; without both a new ticket only waits in
	// the inbox.
	Mailer         notify.Mailer
	MailTo         string
	Limiter        *comments.RateLimiter
	Clock          comments.Clock
	Logger         *slog.Logger
	DailyCap       int
	MailDailyLimit int
	ListLimit      int
}

// Service implements tickets. Every inbox method goes through one guard.
type Service struct {
	cfg  Config
	mail sync.WaitGroup
}

// NewService validates cfg and returns a Service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Sealer == nil {
		return nil, errors.New("tickets: store and sealer are required")
	}
	if cfg.Clock == nil {
		cfg.Clock = comments.ClockFunc(time.Now)
	}
	if cfg.Limiter == nil {
		cfg.Limiter = comments.NewRateLimiter(writeBurst, writeEvery, cfg.Clock)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.DailyCap <= 0 {
		cfg.DailyCap = DefaultDailyCap
	}
	if cfg.MailDailyLimit <= 0 {
		cfg.MailDailyLimit = DefaultMailDailyLimit
	}
	if cfg.ListLimit <= 0 {
		cfg.ListLimit = DefaultListLimit
	}
	return &Service{cfg: cfg}, nil
}

// Create validates and stores a ticket and answers its reference.
func (s *Service) Create(ctx context.Context, a comments.Actor, in Input) (string, error) {
	clean, err := validate(in)
	if err != nil {
		return "", err
	}
	if !s.cfg.Limiter.Allow(a.UserID) {
		return "", comments.ErrRateLimited
	}
	today, err := s.cfg.Store.CountTicketsSince(ctx, startOfDay(s.cfg.Clock.Now()))
	if err != nil {
		return "", fmt.Errorf("%w: %v", comments.ErrUnavailable, err)
	}
	if today >= s.cfg.DailyCap {
		s.cfg.Logger.Warn("tickets: daily cap reached", "cap", s.cfg.DailyCap)
		return "", comments.ErrUnavailable
	}
	for range refAttempts {
		ref, err := newRef()
		if err != nil {
			return "", err
		}
		rec, err := s.sealed(ref, a, clean)
		if err != nil {
			return "", err
		}
		err = s.cfg.Store.CreateTicket(ctx, rec)
		if errors.Is(err, comments.ErrConflict) {
			continue
		}
		if err != nil {
			return "", err
		}
		s.announce(rec)
		return ref, nil
	}
	return "", errors.New("tickets: no free reference")
}

// WaitMail blocks until the mail already started has finished.
func (s *Service) WaitMail() { s.mail.Wait() }

// Access reports whether a may triage tickets. It fails closed.
func (s *Service) Access(ctx context.Context, a comments.Actor) bool {
	ok, err := s.cfg.Store.IsTicketAdmin(ctx, a.UserID)
	if err != nil {
		s.cfg.Logger.Error("tickets: reading the admins failed", "error", err)
		return false
	}
	return ok
}

// List returns the inbox, optionally for one status.
func (s *Service) List(ctx context.Context, a comments.Actor, status string) (List, error) {
	if !s.Access(ctx, a) {
		return List{}, comments.ErrForbidden
	}
	if status != "" && !slices.Contains(Statuses, status) {
		return List{}, &comments.ValidationError{Field: "status"}
	}
	records, total, err := s.cfg.Store.ListTickets(ctx, status, s.cfg.ListLimit)
	if err != nil {
		return List{}, err
	}
	out := List{Tickets: make([]Ticket, 0, len(records)), Total: total}
	for _, r := range records {
		out.Tickets = append(out.Tickets, s.opened(r))
	}
	return out, nil
}

// Update applies an admin's triage. Status "issue" needs a link, given now or
// from before; leaving it keeps the link.
func (s *Service) Update(ctx context.Context, a comments.Actor, ref string, c Change) (Ticket, error) {
	if !s.Access(ctx, a) {
		return Ticket{}, comments.ErrForbidden
	}
	if !validRef.MatchString(ref) {
		return Ticket{}, comments.ErrNotFound
	}
	if !slices.Contains(Statuses, c.Status) {
		return Ticket{}, &comments.ValidationError{Field: "status"}
	}
	if c.GitHubIssue < 0 {
		return Ticket{}, &comments.ValidationError{Field: "github_issue"}
	}
	current, err := s.cfg.Store.TicketByRef(ctx, ref)
	if err != nil {
		return Ticket{}, err
	}
	if c.Status == StatusIssue && c.GitHubIssue == 0 && current.GitHubIssue == 0 {
		return Ticket{}, &comments.ValidationError{Field: "github_issue"}
	}
	r, err := s.cfg.Store.UpdateTicket(ctx, ref, c.Status, c.GitHubIssue)
	if err != nil {
		return Ticket{}, err
	}
	return s.opened(r), nil
}

// announce tells whoever is told about a new ticket. It runs apart, so sending
// never holds up or fails the ticket, and it names no text.
func (s *Service) announce(r Record) {
	if s.cfg.Mailer == nil || s.cfg.MailTo == "" {
		return
	}
	s.mail.Add(1)
	go func() {
		defer s.mail.Done()
		ctx, cancel := context.WithTimeout(context.Background(), mailTimeout)
		defer cancel()
		// It counts the ticket being announced. It refuses when the count
		// cannot be read: mail is the part that can wait.
		today, err := s.cfg.Store.CountTicketsSince(ctx, startOfDay(s.cfg.Clock.Now()))
		if err != nil {
			s.cfg.Logger.Error("tickets: counting today's tickets failed", "error", err)
			return
		}
		if today > s.cfg.MailDailyLimit {
			return
		}
		err = s.cfg.Mailer.Send(ctx, notify.Message{
			To:             s.cfg.MailTo,
			Subject:        fmt.Sprintf("New galley ticket %s (%s)", r.Ref, r.Category),
			Text:           fmt.Sprintf("Ticket %s, category %s, from %s.\n\nRead and triage it in galley: Help > Tickets.\n", r.Ref, r.Category, r.Login),
			IdempotencyKey: "ticket-" + r.Ref,
		})
		if err != nil {
			s.cfg.Logger.Error("tickets: announcing a ticket failed", "error", err)
		}
	}()
}

func (s *Service) sealed(ref string, a comments.Actor, in Input) (Record, error) {
	r := Record{Ref: ref, UserID: a.UserID, Login: a.Login, Category: in.Category, Status: StatusNew, Version: in.Version, Device: in.Device}
	for _, f := range []struct {
		name  string
		plain string
		out   *string
	}{
		{"description", in.Description, &r.Description},
		{"steps", in.Steps, &r.Steps},
		{"diagnostics", string(in.Diagnostics), &r.Diagnostics},
	} {
		if f.plain == "" {
			continue
		}
		out, err := s.cfg.Sealer.Seal([]byte(f.plain), fieldAAD(ref, f.name))
		if err != nil {
			return Record{}, fmt.Errorf("tickets: seal: %w", err)
		}
		*f.out = out
	}
	return r, nil
}

// opened never fails: one ticket that does not open must not hide the others.
func (s *Service) opened(r Record) Ticket {
	t := Ticket{Ref: r.Ref, Login: r.Login, Category: r.Category, Status: r.Status, Version: r.Version, Device: r.Device, GitHubIssue: r.GitHubIssue, CreatedAt: r.CreatedAt}
	for _, f := range []struct {
		name   string
		sealed string
		out    func(string)
	}{
		{"description", r.Description, func(v string) { t.Description = v }},
		{"steps", r.Steps, func(v string) { t.Steps = v }},
		{"diagnostics", r.Diagnostics, func(v string) { t.Diagnostics = json.RawMessage(v) }},
	} {
		if f.sealed == "" {
			continue
		}
		plain, err := s.cfg.Sealer.Open(f.sealed, fieldAAD(r.Ref, f.name))
		if err != nil {
			s.cfg.Logger.Error("tickets: a stored value does not authenticate", "ref", r.Ref, "field", f.name)
			t.Description, t.Steps, t.Diagnostics, t.Unreadable = "", "", nil, true
			return t
		}
		f.out(string(plain))
	}
	return t
}

// fieldAAD binds a sealed value to its ticket and field, so it does not open
// when moved to another one.
func fieldAAD(ref, field string) []byte { return []byte("ticket/" + ref + "/" + field) }

// validate trims every field, strips control characters and checks limits. It
// answers the first offending field.
func validate(in Input) (Input, error) {
	out := Input{
		Category:    strings.TrimSpace(in.Category),
		Description: cleanText(in.Description, true),
		Steps:       cleanText(in.Steps, true),
		Version:     cleanText(in.Version, false),
		Device:      cleanText(in.Device, false),
	}
	if !slices.Contains(Categories, out.Category) {
		return out, &comments.ValidationError{Field: "category"}
	}
	if out.Description == "" {
		return out, &comments.ValidationError{Field: "description"}
	}
	for _, f := range []struct {
		name, value string
		max         int
	}{
		{"description", out.Description, MaxDescription},
		{"steps", out.Steps, MaxSteps},
		{"version", out.Version, MaxVersion},
		{"device", out.Device, MaxDevice},
	} {
		if utf8.RuneCountInString(f.value) > f.max {
			return out, &comments.ValidationError{Field: f.name}
		}
	}
	diag := bytes.TrimSpace(in.Diagnostics)
	if len(diag) > 0 && !bytes.Equal(diag, []byte("null")) {
		if len(diag) > MaxDiagnosticsBytes {
			return out, &comments.ValidationError{Field: "diagnostics"}
		}
		var obj map[string]any
		if json.Unmarshal(diag, &obj) != nil || obj == nil {
			return out, &comments.ValidationError{Field: "diagnostics"}
		}
		compact := &bytes.Buffer{}
		if json.Compact(compact, diag) != nil {
			return out, &comments.ValidationError{Field: "diagnostics"}
		}
		out.Diagnostics = compact.Bytes()
	}
	return out, nil
}

// cleanText trims s and drops control characters; multiline keeps newlines and tabs.
func cleanText(s string, multiline bool) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if r == '\r' {
			return -1
		}
		if multiline && (r == '\n' || r == '\t') {
			return r
		}
		if unicode.IsControl(r) {
			if !multiline && (r == '\n' || r == '\t') {
				return ' '
			}
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

func startOfDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// newRef draws GL- plus 6 characters from crypto/rand.
func newRef() (string, error) {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i, b := range buf {
		buf[i] = refAlphabet[int(b)%len(refAlphabet)]
	}
	return "GL-" + string(buf), nil
}

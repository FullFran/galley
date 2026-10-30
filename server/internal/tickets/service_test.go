package tickets_test

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
	"github.com/FullFran/galley/server/internal/tickets"
)

type fakeStore struct {
	mu       sync.Mutex
	records  []tickets.Record
	admins   map[string]bool
	adminErr error
	countErr error
	collide  int
}

func (f *fakeStore) CreateTicket(_ context.Context, r tickets.Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.collide > 0 {
		f.collide--
		return comments.ErrConflict
	}
	f.records = append(f.records, r)
	return nil
}

func (f *fakeStore) ListTickets(_ context.Context, status string, limit int) ([]tickets.Record, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []tickets.Record{}
	for _, r := range f.records {
		if status == "" || r.Status == status {
			out = append(out, r)
		}
	}
	total := len(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, total, nil
}

func (f *fakeStore) UpdateTicket(_ context.Context, ref, status string, issue int) (tickets.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.records {
		if f.records[i].Ref == ref {
			f.records[i].Status = status
			if issue > 0 {
				f.records[i].GitHubIssue = issue
			}
			return f.records[i], nil
		}
	}
	return tickets.Record{}, comments.ErrNotFound
}

func (f *fakeStore) TicketByRef(_ context.Context, ref string) (tickets.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.records {
		if r.Ref == ref {
			return r, nil
		}
	}
	return tickets.Record{}, comments.ErrNotFound
}

func (f *fakeStore) CountTicketsSince(context.Context, time.Time) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.records), f.countErr
}

func (f *fakeStore) IsTicketAdmin(_ context.Context, userID string) (bool, error) {
	return f.admins[userID], f.adminErr
}

// plainSealer keeps the field binding visible and refuses a moved value.
type plainSealer struct{}

func (plainSealer) Seal(p, aad []byte) (string, error) {
	return "sealed:" + string(aad) + ":" + string(p), nil
}
func (plainSealer) Open(s string, aad []byte) ([]byte, error) {
	prefix := "sealed:" + string(aad) + ":"
	if !strings.HasPrefix(s, prefix) {
		return nil, errors.New("wrong binding")
	}
	return []byte(strings.TrimPrefix(s, prefix)), nil
}

type fakeMailer struct {
	sent chan notify.Message
	err  error
}

func (f *fakeMailer) Send(_ context.Context, m notify.Message) error {
	f.sent <- m
	return f.err
}

var (
	reporter = comments.Actor{UserID: "u1", Login: "ana"}
	admin    = comments.Actor{UserID: "boss", Login: "fran"}
	validRef = regexp.MustCompile(`^GL-[A-Z0-9]{6}$`)
)

func newService(t *testing.T, store *fakeStore, mod ...func(*tickets.Config)) *tickets.Service {
	t.Helper()
	if store.admins == nil {
		store.admins = map[string]bool{"boss": true}
	}
	cfg := tickets.Config{Store: store, Sealer: plainSealer{}, Limiter: comments.NewRateLimiter(1000, time.Second, nil)}
	for _, m := range mod {
		m(&cfg)
	}
	s, err := tickets.NewService(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func validInput() tickets.Input {
	return tickets.Input{Category: "bug", Description: "the preview is blank", Steps: "open it", Version: "abc", Device: "Firefox, Linux"}
}

func fieldOf(err error) string {
	var ve *comments.ValidationError
	if errors.As(err, &ve) {
		return ve.Field
	}
	return ""
}

func TestCreateSealsTheTextAndAnswersAReference(t *testing.T) {
	store := &fakeStore{}
	s := newService(t, store)
	in := validInput()
	in.Diagnostics = json.RawMessage(`{ "locale": "es" }`)
	ref, err := s.Create(context.Background(), reporter, in)
	if err != nil {
		t.Fatal(err)
	}
	if !validRef.MatchString(ref) {
		t.Fatalf("ref = %q", ref)
	}
	if len(store.records) != 1 {
		t.Fatalf("stored %d", len(store.records))
	}
	r := store.records[0]
	if r.Ref != ref || r.UserID != "u1" || r.Login != "ana" || r.Category != "bug" || r.Status != tickets.StatusNew || r.Version != "abc" || r.Device != "Firefox, Linux" {
		t.Fatalf("record = %+v", r)
	}
	for name, sealed := range map[string]string{"description": r.Description, "steps": r.Steps, "diagnostics": r.Diagnostics} {
		if !strings.HasPrefix(sealed, "sealed:ticket/"+ref+"/"+name+":") {
			t.Errorf("%s = %q", name, sealed)
		}
	}
}

func TestCreateRetriesAReferenceCollision(t *testing.T) {
	store := &fakeStore{collide: 2}
	if _, err := newService(t, store).Create(context.Background(), reporter, validInput()); err != nil {
		t.Fatal(err)
	}
	if len(store.records) != 1 {
		t.Fatalf("stored %d", len(store.records))
	}
}

func TestCreateValidates(t *testing.T) {
	long := func(n int) string { return strings.Repeat("é", n) }
	for _, tc := range []struct {
		name  string
		mod   func(*tickets.Input)
		field string
	}{
		{"unknown category", func(i *tickets.Input) { i.Category = "lore" }, "category"},
		{"empty description", func(i *tickets.Input) { i.Description = " \n\t " }, "description"},
		{"only control characters", func(i *tickets.Input) { i.Description = "\x00\x01" }, "description"},
		{"long description", func(i *tickets.Input) { i.Description = long(tickets.MaxDescription + 1) }, "description"},
		{"long steps", func(i *tickets.Input) { i.Steps = long(tickets.MaxSteps + 1) }, "steps"},
		{"long version", func(i *tickets.Input) { i.Version = long(tickets.MaxVersion + 1) }, "version"},
		{"long device", func(i *tickets.Input) { i.Device = long(tickets.MaxDevice + 1) }, "device"},
		{"diagnostics not an object", func(i *tickets.Input) { i.Diagnostics = json.RawMessage(`[1]`) }, "diagnostics"},
		{"diagnostics too large", func(i *tickets.Input) {
			i.Diagnostics = json.RawMessage(`{"a":"` + strings.Repeat("x", tickets.MaxDiagnosticsBytes) + `"}`)
		}, "diagnostics"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			in := validInput()
			tc.mod(&in)
			_, err := newService(t, store).Create(context.Background(), reporter, in)
			if fieldOf(err) != tc.field {
				t.Fatalf("err = %v, want field %s", err, tc.field)
			}
			if len(store.records) != 0 {
				t.Fatal("a rejected ticket was stored")
			}
		})
	}
}

func TestCreateCleansTheText(t *testing.T) {
	store := &fakeStore{}
	in := validInput()
	in.Description = "  line one\r\n\x07line two\t "
	in.Version = "a\nb"
	if _, err := newService(t, store).Create(context.Background(), reporter, in); err != nil {
		t.Fatal(err)
	}
	r := store.records[0]
	if want := "line one\nline two"; !strings.HasSuffix(r.Description, ":"+want) {
		t.Fatalf("description = %q", r.Description)
	}
	if r.Version != "a b" {
		t.Fatalf("version = %q", r.Version)
	}
}

func TestCreateLimitsPerUserAndPerDay(t *testing.T) {
	store := &fakeStore{}
	s := newService(t, store, func(c *tickets.Config) { c.Limiter = comments.NewRateLimiter(1, time.Hour, nil) })
	if _, err := s.Create(context.Background(), reporter, validInput()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(context.Background(), reporter, validInput()); !errors.Is(err, comments.ErrRateLimited) {
		t.Fatalf("second = %v", err)
	}
	if _, err := s.Create(context.Background(), admin, validInput()); err != nil {
		t.Fatalf("another user = %v", err)
	}

	full := &fakeStore{}
	s = newService(t, full, func(c *tickets.Config) { c.DailyCap = 1 })
	if _, err := s.Create(context.Background(), reporter, validInput()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(context.Background(), reporter, validInput()); !errors.Is(err, comments.ErrUnavailable) {
		t.Fatalf("over the cap = %v", err)
	}
	if len(full.records) != 1 {
		t.Fatalf("stored %d", len(full.records))
	}
}

func TestMailCarriesNoTextAndNeverFailsTheTicket(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeMailer{sent: make(chan notify.Message, 4), err: errors.New("resend down")}
	s := newService(t, store, func(c *tickets.Config) { c.Mailer, c.MailTo = mailer, "owner@example.com" })
	ref, err := s.Create(context.Background(), reporter, validInput())
	if err != nil {
		t.Fatal(err)
	}
	m := <-mailer.sent
	if m.To != "owner@example.com" || !strings.Contains(m.Subject, ref) || !strings.Contains(m.Text, "ana") || m.IdempotencyKey == "" {
		t.Fatalf("message = %+v", m)
	}
	for _, secret := range []string{"preview is blank", "open it"} {
		if strings.Contains(m.Subject+m.Text, secret) {
			t.Fatalf("the mail quotes the ticket: %+v", m)
		}
	}
}

func TestMailStopsAtTheDailyLimit(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeMailer{sent: make(chan notify.Message, 4)}
	s := newService(t, store, func(c *tickets.Config) { c.Mailer, c.MailTo, c.MailDailyLimit = mailer, "owner@example.com", 1 })
	first, err := s.Create(context.Background(), reporter, validInput())
	if err != nil {
		t.Fatal(err)
	}
	if m := <-mailer.sent; !strings.Contains(m.Subject, first) {
		t.Fatalf("message = %+v", m)
	}
	if _, err := s.Create(context.Background(), reporter, validInput()); err != nil {
		t.Fatal(err)
	}
	s.WaitMail()
	if len(mailer.sent) != 0 {
		t.Fatal("a ticket past the limit sent mail")
	}
	if len(store.records) != 2 {
		t.Fatalf("stored %d", len(store.records))
	}
}

func TestOnlyListedAdminsReachTheInbox(t *testing.T) {
	store := &fakeStore{}
	s := newService(t, store)
	ctx := context.Background()
	ref, err := s.Create(ctx, reporter, validInput())
	if err != nil {
		t.Fatal(err)
	}
	if ok := s.Access(ctx, reporter); ok {
		t.Fatal("reporter has access")
	}
	if ok := s.Access(ctx, admin); !ok {
		t.Fatal("admin has no access")
	}
	if _, err := s.List(ctx, reporter, ""); !errors.Is(err, comments.ErrForbidden) {
		t.Fatalf("list = %v", err)
	}
	if _, err := s.Update(ctx, reporter, ref, tickets.Change{Status: "closed"}); !errors.Is(err, comments.ErrForbidden) {
		t.Fatalf("update = %v", err)
	}
	if store.records[0].Status != tickets.StatusNew {
		t.Fatal("a refused update changed the ticket")
	}

	broken := &fakeStore{adminErr: errors.New("db down"), admins: map[string]bool{"boss": true}}
	s = newService(t, broken)
	if s.Access(ctx, admin) {
		t.Fatal("a failed lookup granted access")
	}
	if _, err := s.List(ctx, admin, ""); !errors.Is(err, comments.ErrForbidden) {
		t.Fatalf("list with a failed lookup = %v", err)
	}
}

func TestInboxOpensTheText(t *testing.T) {
	store := &fakeStore{}
	s := newService(t, store)
	ctx := context.Background()
	in := validInput()
	in.Diagnostics = json.RawMessage(`{"locale":"es"}`)
	ref, err := s.Create(ctx, reporter, in)
	if err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, admin, "")
	if err != nil {
		t.Fatal(err)
	}
	if list.Total != 1 || len(list.Tickets) != 1 {
		t.Fatalf("list = %+v", list)
	}
	got := list.Tickets[0]
	if got.Ref != ref || got.Description != in.Description || got.Steps != in.Steps || string(got.Diagnostics) != `{"locale":"es"}` || got.Login != "ana" || got.Status != tickets.StatusNew {
		t.Fatalf("ticket = %+v", got)
	}
	if _, err := s.List(ctx, admin, "nope"); fieldOf(err) != "status" {
		t.Fatalf("unknown status = %v", err)
	}
	if list, err = s.List(ctx, admin, "closed"); err != nil || list.Total != 0 {
		t.Fatalf("closed = %+v %v", list, err)
	}
}

func TestUpdateRules(t *testing.T) {
	store := &fakeStore{}
	s := newService(t, store)
	ctx := context.Background()
	ref, err := s.Create(ctx, reporter, validInput())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(ctx, admin, "GL-NOPE", tickets.Change{Status: "closed"}); !errors.Is(err, comments.ErrNotFound) {
		t.Fatalf("bad ref = %v", err)
	}
	if _, err := s.Update(ctx, admin, "GL-ZZZZZZ", tickets.Change{Status: "closed"}); !errors.Is(err, comments.ErrNotFound) {
		t.Fatalf("missing ref = %v", err)
	}
	if _, err := s.Update(ctx, admin, ref, tickets.Change{Status: "lost"}); fieldOf(err) != "status" {
		t.Fatalf("bad status = %v", err)
	}
	if _, err := s.Update(ctx, admin, ref, tickets.Change{Status: tickets.StatusIssue}); fieldOf(err) != "github_issue" {
		t.Fatalf("issue status without a link = %v", err)
	}
	if _, err := s.Update(ctx, admin, ref, tickets.Change{Status: "triaged", GitHubIssue: -1}); fieldOf(err) != "github_issue" {
		t.Fatalf("negative issue = %v", err)
	}
	got, err := s.Update(ctx, admin, ref, tickets.Change{Status: tickets.StatusIssue, GitHubIssue: 12})
	if err != nil || got.Status != tickets.StatusIssue || got.GitHubIssue != 12 || got.Description == "" {
		t.Fatalf("linked = %+v %v", got, err)
	}
	// Leaving "issue" keeps the link; coming back needs no new number.
	got, err = s.Update(ctx, admin, ref, tickets.Change{Status: "closed"})
	if err != nil || got.Status != "closed" || got.GitHubIssue != 12 {
		t.Fatalf("closed = %+v %v", got, err)
	}
	got, err = s.Update(ctx, admin, ref, tickets.Change{Status: tickets.StatusIssue})
	if err != nil || got.Status != tickets.StatusIssue || got.GitHubIssue != 12 {
		t.Fatalf("back to issue = %+v %v", got, err)
	}
}

func TestAnUnreadableTicketDoesNotTakeTheInboxDown(t *testing.T) {
	store := &fakeStore{}
	s := newService(t, store)
	ctx := context.Background()
	bad, err := s.Create(ctx, reporter, validInput())
	if err != nil {
		t.Fatal(err)
	}
	good, err := s.Create(ctx, reporter, validInput())
	if err != nil {
		t.Fatal(err)
	}
	// A value moved from another ticket, as a rotated key would also look.
	store.records[0].Description = store.records[1].Description

	list, err := s.List(ctx, admin, "")
	if err != nil {
		t.Fatalf("list = %v", err)
	}
	if list.Total != 2 || len(list.Tickets) != 2 {
		t.Fatalf("list = %+v", list)
	}
	for _, got := range list.Tickets {
		switch got.Ref {
		case bad:
			if !got.Unreadable || got.Description != "" || got.Steps != "" || got.Diagnostics != nil || got.Login != "ana" {
				t.Fatalf("unreadable ticket = %+v", got)
			}
		case good:
			if got.Unreadable || got.Description != "the preview is blank" {
				t.Fatalf("readable ticket = %+v", got)
			}
		}
	}
	// It can still be triaged, and the answer matches what was stored.
	got, err := s.Update(ctx, admin, bad, tickets.Change{Status: tickets.StatusClosed})
	if err != nil || got.Status != tickets.StatusClosed || !got.Unreadable {
		t.Fatalf("update = %+v %v", got, err)
	}
}

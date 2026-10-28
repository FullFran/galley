package reanchor_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/reanchor"
)

var (
	ctx  = context.Background()
	base = strings.Repeat("a", 40)
	head = strings.Repeat("b", 40)
)

// fakeGitHub serves one comparison and file contents keyed by "ref:path".
type fakeGitHub struct {
	mu       sync.Mutex
	cmp      reanchor.Comparison
	cmpErr   error
	files    map[string]string
	compares int
	fetches  int
	tokens   []string
}

func (f *fakeGitHub) Compare(_ context.Context, token, fullName, b, h string) (reanchor.Comparison, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.compares++
	f.tokens = append(f.tokens, token)
	if fullName != "o/r" || b != base || h != head {
		return reanchor.Comparison{}, errors.New("unexpected compare")
	}
	return f.cmp, f.cmpErr
}

func (f *fakeGitHub) FileAt(_ context.Context, _ string, fullName, path, ref string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetches++
	c, ok := f.files[ref+":"+path]
	return c, ok, nil
}

func thread(start, end int, path string) comments.ThreadRecord {
	r := comments.Range{StartLine: start, EndLine: end}
	return comments.ThreadRecord{
		ID: "t1", RepoID: 7, RepoFullName: "o/r", Path: path, CommitSHA: base, Range: r,
		Position: comments.Position{CommitSHA: base, Range: r, State: comments.AnchorExact},
	}
}

func newService(t *testing.T, gh *fakeGitHub, mut ...func(*reanchor.Config)) *reanchor.Service {
	t.Helper()
	cfg := reanchor.Config{
		GitHub: gh,
		Token:  func(context.Context, string) (string, error) { return "tok", nil },
	}
	for _, m := range mut {
		m(&cfg)
	}
	s, err := reanchor.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func lines(n int, f func(i int) string) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		b.WriteString(f(i))
		b.WriteByte('\n')
	}
	return b.String()
}

func TestPositionCases(t *testing.T) {
	oldText := lines(40, func(i int) string { return "line " + itoa(i) })
	tests := []struct {
		name      string
		cmp       reanchor.Comparison
		files     map[string]string
		thread    comments.ThreadRecord
		quote     string
		wantState comments.AnchorState
		wantPath  string
		wantStart int
		wantEnd   int
	}{
		{
			name:      "file untouched",
			cmp:       reanchor.Comparison{Files: []reanchor.File{{Filename: "other.qmd", Status: "modified", Patch: "@@ -1 +1 @@\n-x\n+y"}}},
			thread:    thread(10, 11, "a.qmd"),
			quote:     "line 10\nline 11",
			wantState: comments.AnchorExact, wantPath: "a.qmd", wantStart: 10, wantEnd: 11,
		},
		{
			name:      "lines inserted above",
			cmp:       reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified", Patch: "@@ -2,0 +3,3 @@\n+n1\n+n2\n+n3"}}},
			thread:    thread(10, 11, "a.qmd"),
			quote:     "line 10\nline 11",
			wantState: comments.AnchorMoved, wantPath: "a.qmd", wantStart: 13, wantEnd: 14,
		},
		{
			name:      "renamed file",
			cmp:       reanchor.Comparison{Files: []reanchor.File{{Filename: "b.qmd", PreviousFilename: "a.qmd", Status: "renamed", Patch: "@@ -1,1 +0,0 @@\n-line 1"}}},
			thread:    thread(10, 10, "a.qmd"),
			quote:     "line 10",
			wantState: comments.AnchorMoved, wantPath: "b.qmd", wantStart: 9, wantEnd: 9,
		},
		{
			name: "edit inside, quote still there",
			cmp:  reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified", Patch: "@@ -10,2 +10,3 @@\n-line 10\n+inserted\n+line 10\n line 11"}}},
			files: map[string]string{
				head + ":a.qmd": strings.Replace(oldText, "line 10\n", "inserted\nline 10\n", 1),
			},
			thread:    thread(10, 10, "a.qmd"),
			quote:     "line 10",
			wantState: comments.AnchorMoved, wantPath: "a.qmd", wantStart: 11, wantEnd: 11,
		},
		{
			name: "quote reworded",
			cmp:  reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified", Patch: "@@ -10 +10 @@\n-line 10\n+The quick brown fox jumps over the lazy dog."}}},
			files: map[string]string{
				head + ":a.qmd": strings.Replace(oldText, "line 10\n", "The quick brown fox jumps over the lazy dog.\n", 1),
			},
			thread:    thread(10, 10, "a.qmd"),
			quote:     "The quick brown fox jumped over the lazy dog.",
			wantState: comments.AnchorFuzzy, wantPath: "a.qmd", wantStart: 10, wantEnd: 10,
		},
		{
			name: "quote gone",
			cmp:  reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified", Patch: "@@ -10 +10 @@\n-line 10\n+zzz"}}},
			files: map[string]string{
				head + ":a.qmd": strings.Replace(oldText, "line 10\n", "zzz\n", 1),
			},
			thread:    thread(10, 10, "a.qmd"),
			quote:     "A sentence that was deleted entirely from the paper.",
			wantState: comments.AnchorOrphaned, wantPath: "a.qmd", wantStart: 10, wantEnd: 10,
		},
		{
			name:      "file removed",
			cmp:       reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "removed"}}},
			thread:    thread(10, 10, "a.qmd"),
			quote:     "line 10",
			wantState: comments.AnchorOrphaned, wantPath: "a.qmd", wantStart: 10, wantEnd: 10,
		},
		{
			name: "truncated comparison falls back to both versions",
			cmp:  reanchor.Comparison{Truncated: true},
			files: map[string]string{
				base + ":a.qmd": oldText,
				head + ":a.qmd": "new top\n" + oldText,
			},
			thread:    thread(10, 11, "a.qmd"),
			quote:     "line 10\nline 11",
			wantState: comments.AnchorMoved, wantPath: "a.qmd", wantStart: 11, wantEnd: 12,
		},
		{
			name: "file without a patch falls back to both versions",
			cmp:  reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified"}}},
			files: map[string]string{
				base + ":a.qmd": oldText,
				head + ":a.qmd": strings.Replace(oldText, "line 2\n", "", 1),
			},
			thread:    thread(10, 10, "a.qmd"),
			quote:     "line 10",
			wantState: comments.AnchorMoved, wantPath: "a.qmd", wantStart: 9, wantEnd: 9,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gh := &fakeGitHub{cmp: tt.cmp, files: tt.files}
			s := newService(t, gh)
			th := tt.thread
			p, err := s.Position(ctx, "u1", th, comments.Quote{Exact: tt.quote}, head)
			if err != nil {
				t.Fatal(err)
			}
			if p.State != tt.wantState || p.Path != tt.wantPath || p.Range.StartLine != tt.wantStart || p.Range.EndLine != tt.wantEnd || p.CommitSHA != head {
				t.Errorf("position = %+v", p)
			}
			if th.Range.StartLine != tt.thread.Range.StartLine || th.Position.CommitSHA != base {
				t.Error("the stored anchor must not change")
			}
		})
	}
}

func TestPositionAtBaseOrEmptyIsStored(t *testing.T) {
	gh := &fakeGitHub{}
	s := newService(t, gh)
	th := thread(3, 4, "a.qmd")
	for _, at := range []string{"", base} {
		p, err := s.Position(ctx, "u1", th, comments.Quote{Exact: "x"}, at)
		if err != nil || p.CommitSHA != base || p.State != comments.AnchorExact || p.Path != "a.qmd" {
			t.Errorf("at %q = %+v, %v", at, p, err)
		}
	}
	if gh.compares != 0 {
		t.Errorf("compares = %d", gh.compares)
	}
}

func TestCachesPositionsAndComparisons(t *testing.T) {
	gh := &fakeGitHub{cmp: reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified", Patch: "@@ -1,0 +1,1 @@\n+top"}}}}
	s := newService(t, gh, func(c *reanchor.Config) { c.MaxPositions = 2 })
	q := comments.Quote{Exact: "q"}
	for i := 0; i < 3; i++ {
		th := thread(5, 5, "a.qmd")
		th.ID = "t" + itoa(i)
		if _, err := s.Position(ctx, "u1", th, q, head); err != nil {
			t.Fatal(err)
		}
	}
	// One comparison shared by every thread of the (repo, base, head).
	if gh.compares != 1 {
		t.Errorf("compares = %d", gh.compares)
	}
	if n := s.CachedPositions(); n != 2 {
		t.Errorf("cached positions = %d, want the bound 2", n)
	}
}

func TestGitHubFailureDegradesToStoredAndIsThrottled(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	clock := comments.ClockFunc(func() time.Time { return now })
	gh := &fakeGitHub{cmpErr: errors.New("boom")}
	s := newService(t, gh, func(c *reanchor.Config) { c.Clock = clock })
	th := thread(5, 5, "a.qmd")
	for i := 0; i < 5; i++ {
		th.ID = "t" + itoa(i)
		p, err := s.Position(ctx, "u1", th, comments.Quote{Exact: "q"}, head)
		if err != nil || p.CommitSHA != base || p.State != comments.AnchorExact {
			t.Fatalf("degraded = %+v, %v", p, err)
		}
	}
	// A failing comparison is not retried for every thread.
	if gh.compares != 1 {
		t.Errorf("compares = %d", gh.compares)
	}
	now = now.Add(time.Minute)
	gh.cmpErr = nil
	if p, _ := s.Position(ctx, "u1", th, comments.Quote{Exact: "q"}, head); p.CommitSHA != head {
		t.Errorf("after the negative TTL = %+v", p)
	}
}

func TestPerUserLimit(t *testing.T) {
	gh := &fakeGitHub{cmpErr: errors.New("boom")}
	var mu sync.Mutex
	now := time.Unix(1_800_000_000, 0)
	clock := comments.ClockFunc(func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(time.Millisecond)
		return now
	})
	s := newService(t, gh, func(c *reanchor.Config) {
		c.Clock = clock
		c.NegativeTTL = time.Nanosecond
		c.Limiter = comments.NewRateLimiter(2, time.Hour, clock)
	})
	th := thread(5, 5, "a.qmd")
	for i := 0; i < 5; i++ {
		th.ID = "t" + itoa(i)
		_, _ = s.Position(ctx, "u1", th, comments.Quote{Exact: "q"}, head)
	}
	if gh.compares != 2 {
		t.Errorf("compares = %d, want the burst", gh.compares)
	}
}

func TestTokenFailureDegrades(t *testing.T) {
	gh := &fakeGitHub{}
	s := newService(t, gh, func(c *reanchor.Config) {
		c.Token = func(context.Context, string) (string, error) { return "", comments.ErrUnauthenticated }
	})
	p, err := s.Position(ctx, "u1", thread(5, 5, "a.qmd"), comments.Quote{Exact: "q"}, head)
	if err != nil || p.CommitSHA != base {
		t.Errorf("token failure = %+v, %v", p, err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for ; i > 0; i /= 10 {
		b = append([]byte{byte('0' + i%10)}, b...)
	}
	return string(b)
}

func TestFuzzyWorkIsBudgeted(t *testing.T) {
	oldText := lines(40, func(i int) string { return "line " + itoa(i) })
	gh := &fakeGitHub{
		cmp:   reanchor.Comparison{Files: []reanchor.File{{Filename: "a.qmd", Status: "modified", Patch: "@@ -10 +10 @@\n-line 10\n+The quick brown fox jumps over the lazy dog."}}},
		files: map[string]string{head + ":a.qmd": strings.Replace(oldText, "line 10\n", "The quick brown fox jumps over the lazy dog.\n", 1)},
	}
	s := newService(t, gh)
	q := comments.Quote{Exact: "The quick brown fox jumped over the lazy dog."}
	// A listing whose budget is spent gets the stored, unmapped position.
	p, err := s.Position(comments.WithWorkBudget(ctx, 10), "u1", thread(10, 10, "a.qmd"), q, head)
	if err != nil || p.CommitSHA != base {
		t.Fatalf("over budget = %+v %v", p, err)
	}
	// It was not cached: a single-thread read still maps it.
	p, err = s.Position(ctx, "u1", thread(10, 10, "a.qmd"), q, head)
	if err != nil || p.State != comments.AnchorFuzzy || p.CommitSHA != head {
		t.Errorf("without budget = %+v %v", p, err)
	}
}

func TestExactPathWinsOverRenameSource(t *testing.T) {
	gh := &fakeGitHub{cmp: reanchor.Comparison{Files: []reanchor.File{
		{Filename: "b.qmd", PreviousFilename: "a.qmd", Status: "renamed", Patch: "@@ -1,1 +0,0 @@\n-line 1"},
		{Filename: "a.qmd", Status: "added", Patch: "@@ -1,0 +2,2 @@\n+x\n+y"},
	}}}
	p, err := newService(t, gh).Position(ctx, "u1", thread(10, 10, "a.qmd"), comments.Quote{Exact: "q"}, head)
	if err != nil || p.Path != "a.qmd" || p.Range.StartLine != 12 {
		t.Errorf("position = %+v %v", p, err)
	}
}

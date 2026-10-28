package comments_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/comments"
)

const sha = "0123456789abcdef0123456789abcdef01234567"

func validThread() comments.NewThread {
	return comments.NewThread{
		Path:      "sections/01-intro.qmd",
		CommitSHA: sha,
		Range:     comments.Range{StartLine: 3, EndLine: 5},
		Quote:     comments.Quote{Exact: "the quoted text", Prefix: "before ", Suffix: " after"},
		Origin:    comments.OriginSource,
		Body:      "Is this claim sourced?",
	}
}

func ptr(s string) *string { return &s }

func TestNewThreadValidate(t *testing.T) {
	tests := []struct {
		name      string
		mutate    func(*comments.NewThread)
		wantField string // "" means valid
	}{
		{name: "valid", mutate: func(*comments.NewThread) {}},
		{name: "valid with columns on one line", mutate: func(n *comments.NewThread) {
			n.Range = comments.Range{StartLine: 4, EndLine: 4, StartColumn: 2, EndColumn: 9}
		}},
		{name: "valid sha-256 commit", mutate: func(n *comments.NewThread) { n.CommitSHA = strings.Repeat("a", 64) }},
		{name: "valid preview origin, empty quote", mutate: func(n *comments.NewThread) {
			n.Origin = comments.OriginPreview
			n.Quote = comments.Quote{}
		}},
		{name: "valid empty suggestion (delete lines)", mutate: func(n *comments.NewThread) { n.Suggestion = ptr("") }},
		{name: "empty path", mutate: func(n *comments.NewThread) { n.Path = "" }, wantField: "path"},
		{name: "absolute path", mutate: func(n *comments.NewThread) { n.Path = "/etc/passwd" }, wantField: "path"},
		{name: "dot-dot segment", mutate: func(n *comments.NewThread) { n.Path = "sections/../../x" }, wantField: "path"},
		{name: "bare dot-dot", mutate: func(n *comments.NewThread) { n.Path = ".." }, wantField: "path"},
		{name: "dot segment", mutate: func(n *comments.NewThread) { n.Path = "./a.qmd" }, wantField: "path"},
		{name: "empty segment", mutate: func(n *comments.NewThread) { n.Path = "a//b.qmd" }, wantField: "path"},
		{name: "trailing slash", mutate: func(n *comments.NewThread) { n.Path = "sections/" }, wantField: "path"},
		{name: "backslash", mutate: func(n *comments.NewThread) { n.Path = `sections\a.qmd` }, wantField: "path"},
		{name: "control char", mutate: func(n *comments.NewThread) { n.Path = "a\x00.qmd" }, wantField: "path"},
		{name: "invalid utf-8", mutate: func(n *comments.NewThread) { n.Path = "a\xff.qmd" }, wantField: "path"},
		{name: "path of 512 bytes is fine", mutate: func(n *comments.NewThread) { n.Path = strings.Repeat("a", 512) }},
		{name: "path over 512 bytes", mutate: func(n *comments.NewThread) { n.Path = strings.Repeat("a", 513) }, wantField: "path"},
		{name: "short sha", mutate: func(n *comments.NewThread) { n.CommitSHA = "abc123" }, wantField: "commit_sha"},
		{name: "uppercase sha", mutate: func(n *comments.NewThread) { n.CommitSHA = strings.ToUpper(sha) }, wantField: "commit_sha"},
		{name: "branch name instead of sha", mutate: func(n *comments.NewThread) { n.CommitSHA = "main" }, wantField: "commit_sha"},
		{name: "start line zero", mutate: func(n *comments.NewThread) { n.Range.StartLine = 0 }, wantField: "start_line"},
		{name: "end before start", mutate: func(n *comments.NewThread) { n.Range.EndLine = 2 }, wantField: "end_line"},
		{name: "huge line", mutate: func(n *comments.NewThread) { n.Range.EndLine = 10_000_000 }, wantField: "end_line"},
		{name: "negative column", mutate: func(n *comments.NewThread) { n.Range.StartColumn = -1 }, wantField: "start_column"},
		{name: "end column without start column", mutate: func(n *comments.NewThread) { n.Range.EndColumn = 3 }, wantField: "start_column"},
		{name: "end column before start on one line", mutate: func(n *comments.NewThread) {
			n.Range = comments.Range{StartLine: 4, EndLine: 4, StartColumn: 9, EndColumn: 2}
		}, wantField: "end_column"},
		{name: "unknown origin", mutate: func(n *comments.NewThread) { n.Origin = "email" }, wantField: "origin"},
		{name: "context without quote", mutate: func(n *comments.NewThread) { n.Quote = comments.Quote{Prefix: "x"} }, wantField: "quote"},
		{name: "quote too long", mutate: func(n *comments.NewThread) { n.Quote.Exact = strings.Repeat("q", 20<<10+1) }, wantField: "quote"},
		{name: "prefix too long", mutate: func(n *comments.NewThread) { n.Quote.Prefix = strings.Repeat("p", 1<<10+1) }, wantField: "quote"},
		{name: "quote with NUL", mutate: func(n *comments.NewThread) { n.Quote.Exact = "a\x00b" }, wantField: "quote"},
		{name: "prefix with NUL", mutate: func(n *comments.NewThread) { n.Quote.Prefix = "a\x00" }, wantField: "quote"},
		{name: "path with bidi override", mutate: func(n *comments.NewThread) { n.Path = "a\u202egpj.qmd" }, wantField: "path"},
		{name: "path with format char", mutate: func(n *comments.NewThread) { n.Path = "a\u200bb.qmd" }, wantField: "path"},
		{name: "path with isolate", mutate: func(n *comments.NewThread) { n.Path = "a\u2066b.qmd" }, wantField: "path"},
		{name: "body with bidi override", mutate: func(n *comments.NewThread) { n.Body = "ok \u202d evil" }, wantField: "body"},
		{name: "body with isolate", mutate: func(n *comments.NewThread) { n.Body = "ok \u2069" }, wantField: "body"},
		{name: "quote with bidi override", mutate: func(n *comments.NewThread) { n.Quote.Exact = "x\u202ay" }, wantField: "quote"},
		{name: "suggestion with bidi override", mutate: func(n *comments.NewThread) { n.Suggestion = ptr("\u202b") }, wantField: "suggestion"},
		{name: "body may keep other format chars (ZWJ emoji)", mutate: func(n *comments.NewThread) { n.Body = "team \U0001F469\u200d\U0001F4BB" }},
		{name: "blank body", mutate: func(n *comments.NewThread) { n.Body = " \n\t" }, wantField: "body"},
		{name: "body of 20 KB is fine", mutate: func(n *comments.NewThread) { n.Body = strings.Repeat("b", 20<<10) }},
		{name: "body over 20 KB", mutate: func(n *comments.NewThread) { n.Body = strings.Repeat("b", 20<<10+1) }, wantField: "body"},
		{name: "body with NUL", mutate: func(n *comments.NewThread) { n.Body = "a\x00b" }, wantField: "body"},
		{name: "suggestion over 20 KB", mutate: func(n *comments.NewThread) { n.Suggestion = ptr(strings.Repeat("s", 20<<10+1)) }, wantField: "suggestion"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := validThread()
			tt.mutate(&n)
			err := n.Validate()
			if tt.wantField == "" {
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				return
			}
			var ve *comments.ValidationError
			if !errors.As(err, &ve) || ve.Field != tt.wantField {
				t.Fatalf("err = %v, want invalid %s", err, tt.wantField)
			}
		})
	}
}

func TestNewCommentValidate(t *testing.T) {
	if err := (comments.NewComment{Body: "ok"}).Validate(); err != nil {
		t.Errorf("valid reply: %v", err)
	}
	if err := (comments.NewComment{Body: ""}).Validate(); err == nil {
		t.Error("empty reply accepted")
	}
	if err := (comments.NewComment{Body: "ok", Suggestion: ptr(strings.Repeat("s", 20<<10+1))}).Validate(); err == nil {
		t.Error("oversized suggestion accepted")
	}
}

func TestValidThreadID(t *testing.T) {
	for id, want := range map[string]bool{
		"abcdefghijklmn0": true,
		"short":           false,
		"ABCDEFGHIJKLMN0": false,
		"abcdefghijklm/0": false,
		"":                false,
	} {
		if got := comments.ValidID(id); got != want {
			t.Errorf("ValidID(%q) = %v, want %v", id, got, want)
		}
	}
}

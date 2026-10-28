package reanchor

import (
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/comments"
)

func TestFindExactPrefersContextThenDistance(t *testing.T) {
	text := "intro\nthe cat sat\nfiller\nfiller\nthe cat sat\nend\n"
	// Without context the occurrence nearest the predicted line wins.
	s, e, ok := FindExact(text, comments.Quote{Exact: "cat sat"}, 5)
	if !ok || text[s:e] != "cat sat" || lineOf(text, s) != 5 {
		t.Fatalf("nearest = %d (line %d) ok=%v", s, lineOf(text, s), ok)
	}
	// Context breaks the tie even against distance.
	s, _, ok = FindExact(text, comments.Quote{Exact: "cat sat", Prefix: "intro\nthe ", Suffix: "\nfiller"}, 5)
	if !ok || lineOf(text, s) != 2 {
		t.Fatalf("with context line = %d", lineOf(text, s))
	}
	if _, _, ok := FindExact(text, comments.Quote{Exact: "dog"}, 1); ok {
		t.Error("missing quote found")
	}
	if _, _, ok := FindExact(text, comments.Quote{}, 1); ok {
		t.Error("empty quote found")
	}
}

func TestFindFuzzy(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 200; i++ {
		b.WriteString("line of unrelated filler text number\n")
	}
	b.WriteString("The quick brown fox jumps over the lazy dog near the river.\n")
	for i := 1; i <= 200; i++ {
		b.WriteString("more filler that does not matter\n")
	}
	text := b.String()
	q := comments.Quote{Exact: "The quick brown fox jumped over the lazy dog near a river."}

	s, e, ok, _ := FindFuzzy(text, q, 195, 50, nil)
	if !ok || lineOf(text, s) != 201 || !strings.Contains(text[s:e], "quick brown fox") {
		t.Fatalf("fuzzy = %q line %d ok=%v", text[s:e], lineOf(text, s), ok)
	}
	// Outside the window it is not searched.
	if _, _, ok, _ := FindFuzzy(text, q, 20, 50, nil); ok {
		t.Error("found outside the window")
	}
	// Too different: orphaned.
	if _, _, ok, _ := FindFuzzy(text, comments.Quote{Exact: "A completely different sentence about galaxies."}, 201, 50, nil); ok {
		t.Error("unrelated quote matched")
	}
	// A refused budget skips the search.
	if _, _, ok, skipped := FindFuzzy(text, q, 195, 50, func(int64) bool { return false }); ok || !skipped {
		t.Error("budget not honoured")
	}
	// Very short and very long quotes never match fuzzily.
	if _, _, ok, _ := FindFuzzy(text, comments.Quote{Exact: strings.Repeat("x", 1001)}, 201, 50, nil); ok {
		t.Error("long quote searched")
	}
	if _, _, ok, _ := FindFuzzy(text, comments.Quote{Exact: "Thq"}, 201, 50, nil); ok {
		t.Error("short quote matched")
	}
}

func TestRangeOf(t *testing.T) {
	text := "héllo\nworld wide\nend"
	s := strings.Index(text, "llo")
	e := strings.Index(text, "wide") + len("wide")
	r := rangeOf(text, s, e, true)
	// Columns count UTF-16 units, 1-based, end inclusive (as the editor).
	if r != (comments.Range{StartLine: 1, EndLine: 2, StartColumn: 3, EndColumn: 10}) {
		t.Errorf("range = %+v", r)
	}
	if r := rangeOf(text, s, e, false); r != (comments.Range{StartLine: 1, EndLine: 2}) {
		t.Errorf("whole lines = %+v", r)
	}
	// A match ending with a newline ends on the line of its last character.
	if r := rangeOf(text, 0, strings.Index(text, "world"), false); r.EndLine != 1 {
		t.Errorf("trailing newline range = %+v", r)
	}
}

func lineOf(text string, off int) int { return strings.Count(text[:off], "\n") + 1 }

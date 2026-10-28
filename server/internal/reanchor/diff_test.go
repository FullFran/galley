package reanchor

import (
	"strings"
	"testing"
	"time"
)

func TestParsePatch(t *testing.T) {
	patch := "@@ -1,3 +1,4 @@\n a\n+new\n b\n c\n@@ -10,0 +11,2 @@\n+x\n+y\n@@ -20 +22 @@\n-old\n+repl\n\\ No newline at end of file\n"
	hunks, err := ParsePatch(patch)
	if err != nil {
		t.Fatal(err)
	}
	if len(hunks) != 3 {
		t.Fatalf("hunks = %d", len(hunks))
	}
	// An empty side names the line before the change: normalized to the
	// line the change sits before.
	if h := hunks[1]; h.OldStart != 11 || h.OldLines != 0 || h.NewStart != 11 || h.NewLines != 2 {
		t.Errorf("insertion hunk = %+v", h)
	}
	if h := hunks[2]; h.OldStart != 20 || h.OldLines != 1 || string(h.Ops) != "-+" {
		t.Errorf("default counts hunk = %+v", h)
	}
	for _, bad := range []string{
		"@@ -1,2 +1,2 @@\n a\n",                 // short hunk
		"@@ -1 +1 @@\n a\n b\n",                 // extra line
		"@@ nonsense @@\n",                      // bad header
		"garbage\n@@ -1 +1 @@\n a\n",            // text before the first hunk
		"@@ -1,1 +1,1 @@\n?a\n",                 // unknown op
		"@@ -9999999999999999999,1 +1,1 @@\n a", // overflow
	} {
		if _, err := ParsePatch(bad); err == nil {
			t.Errorf("ParsePatch(%q) accepted", bad)
		}
	}
	if h, err := ParsePatch(""); err != nil || len(h) != 0 {
		t.Errorf("empty patch = %v, %v", h, err)
	}
}

func TestShift(t *testing.T) {
	// Old file lines 1..30. Insert two lines after line 2, delete line 15,
	// replace line 25.
	patch := "@@ -1,3 +1,5 @@\n l1\n l2\n+i1\n+i2\n l3\n@@ -14,3 +16,2 @@\n l14\n-l15\n l16\n@@ -25 +26 @@\n-l25\n+L25\n"
	hunks, err := ParsePatch(patch)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name         string
		start, end   int
		wantS, wantE int
		wantClean    bool
	}{
		{"above every hunk", 1, 2, 1, 2, true},
		{"below an insertion", 5, 7, 7, 9, true},
		{"insertion inside the range", 2, 3, 2, 5, false},
		{"context line of a hunk", 3, 3, 5, 5, true},
		{"between a deletion and a replacement", 17, 20, 18, 21, true},
		{"deleted line inside", 14, 16, 16, 17, false},
		{"replaced line", 25, 25, 26, 26, false},
		{"after every hunk", 28, 30, 29, 31, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, e, clean := Shift(hunks, tt.start, tt.end)
			if clean != tt.wantClean {
				t.Fatalf("clean = %v", clean)
			}
			if clean && (s != tt.wantS || e != tt.wantE) {
				t.Errorf("Shift = %d-%d, want %d-%d", s, e, tt.wantS, tt.wantE)
			}
			if !clean && s < 1 {
				t.Errorf("predicted start = %d", s)
			}
		})
	}
	if s, e, clean := Shift(nil, 4, 6); !clean || s != 4 || e != 6 {
		t.Errorf("no hunks = %d-%d %v", s, e, clean)
	}
}

func TestDiffLinesMatchesShift(t *testing.T) {
	old := SplitLines("a\nb\nc\nd\ne\nf\n")
	tests := []struct {
		name         string
		new          string
		start, end   int
		wantS, wantE int
		wantClean    bool
	}{
		{"insert above", "x\ny\na\nb\nc\nd\ne\nf\n", 3, 4, 5, 6, true},
		{"delete above", "b\nc\nd\ne\nf\n", 3, 4, 2, 3, true},
		{"edit inside", "a\nb\nC\nd\ne\nf\n", 3, 4, 3, 4, false},
		{"unchanged", "a\nb\nc\nd\ne\nf\n", 3, 4, 3, 4, true},
		{"edit below", "a\nb\nc\nd\nE\nf\n", 1, 2, 1, 2, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, e, clean := Shift(DiffLines(old, SplitLines(tt.new)), tt.start, tt.end)
			if clean != tt.wantClean || (clean && (s != tt.wantS || e != tt.wantE)) {
				t.Errorf("got %d-%d clean=%v", s, e, clean)
			}
		})
	}
}

func TestDiffLinesLargeMiddleIsOneHunk(t *testing.T) {
	var a, b []string
	for i := 0; i < 3000; i++ {
		a = append(a, "a"+strings.Repeat("x", i%7))
		b = append(b, "b"+strings.Repeat("y", i%5))
	}
	hunks := DiffLines(a, b)
	if len(hunks) != 1 || hunks[0].OldLines != 3000 || hunks[0].NewLines != 3000 {
		t.Fatalf("hunks = %d", len(hunks))
	}
}

func TestLRUBoundsBytes(t *testing.T) {
	c := newLRU[string](100, 10, func(v string) int64 { return int64(len(v)) })
	c.put("a", "12345", nil, time.Time{})
	c.put("b", "12345", nil, time.Time{})
	c.put("c", "123", nil, time.Time{})
	if _, ok, _ := c.get("a", time.Now()); ok {
		t.Error("oldest entry kept over the byte bound")
	}
	if _, ok, _ := c.get("c", time.Now()); !ok || c.bytes() > 10 {
		t.Errorf("bytes = %d", c.bytes())
	}
	c.put("huge", strings.Repeat("x", 11), nil, time.Time{})
	if _, ok, _ := c.get("huge", time.Now()); ok {
		t.Error("an entry larger than the bound is cached")
	}
}

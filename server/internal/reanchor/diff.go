// Package reanchor maps comment threads from the commit they were anchored
// at to the commit being viewed: it shifts the line range through the file's
// diff hunks, looks for the quote where a hunk touches the range, falls back
// to a bounded fuzzy match, and otherwise orphans the thread. It implements
// comments.Reanchorer and never changes the stored anchor.
package reanchor

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// Hunk is one change of a line diff. OldStart and NewStart are the first
// line the hunk covers on each side; when a side is empty (a pure insertion
// or deletion) it is the line the change sits before. Ops holds one byte per
// diff line: ' ' context, '-' deleted, '+' added.
type Hunk struct {
	OldStart, OldLines int
	NewStart, NewLines int
	Ops                []byte
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// maxLine bounds parsed line numbers (comments allow up to 1,000,000).
const maxLine = 10_000_000

var errPatch = errors.New("reanchor: malformed patch")

// ParsePatch parses the unified diff hunks of one file (the "patch" of a
// GitHub comparison). Every hunk must have exactly the lines its header
// announces.
func ParsePatch(patch string) ([]Hunk, error) {
	patch = strings.TrimSuffix(patch, "\n")
	if patch == "" {
		return nil, nil
	}
	var hunks []Hunk
	var cur *Hunk
	oldLeft, newLeft := 0, 0
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "@@") {
			if cur != nil && (oldLeft != 0 || newLeft != 0) {
				return nil, errPatch
			}
			h, err := parseHeader(line)
			if err != nil {
				return nil, err
			}
			hunks = append(hunks, h)
			cur = &hunks[len(hunks)-1]
			oldLeft, newLeft = h.OldLines, h.NewLines
			continue
		}
		if strings.HasPrefix(line, `\`) { // "\ No newline at end of file"
			continue
		}
		if cur == nil || (oldLeft == 0 && newLeft == 0) {
			return nil, errPatch
		}
		op := byte(' ')
		if line != "" { // some tools strip the space of an empty context line
			op = line[0]
		}
		switch op {
		case ' ':
			oldLeft--
			newLeft--
		case '-':
			oldLeft--
		case '+':
			newLeft--
		default:
			return nil, errPatch
		}
		if oldLeft < 0 || newLeft < 0 {
			return nil, errPatch
		}
		cur.Ops = append(cur.Ops, op)
	}
	if cur != nil && (oldLeft != 0 || newLeft != 0) {
		return nil, errPatch
	}
	return hunks, nil
}

func parseHeader(line string) (Hunk, error) {
	m := hunkHeader.FindStringSubmatch(line)
	if m == nil {
		return Hunk{}, errPatch
	}
	n := func(s string) (int, error) {
		if s == "" {
			return 1, nil
		}
		v, err := strconv.Atoi(s)
		if err != nil || v < 0 || v > maxLine {
			return 0, errPatch
		}
		return v, nil
	}
	var h Hunk
	var err error
	for _, f := range []struct {
		dst *int
		s   string
		def bool
	}{{&h.OldStart, m[1], false}, {&h.OldLines, m[2], true}, {&h.NewStart, m[3], false}, {&h.NewLines, m[4], true}} {
		if !f.def && f.s == "" {
			return Hunk{}, errPatch
		}
		if *f.dst, err = n(f.s); err != nil {
			return Hunk{}, err
		}
	}
	// An empty side names the line before the change.
	if h.OldLines == 0 {
		h.OldStart++
	}
	if h.NewLines == 0 {
		h.NewStart++
	}
	return h, nil
}

// Shift maps the inclusive old line range start..end through hunks (sorted,
// as in a diff). clean reports that no line of the range was deleted and
// nothing was inserted between its lines; then newStart..newEnd is the exact
// new range. Otherwise newStart is the predicted new line of start, where a
// search should look, and newEnd is undefined.
func Shift(hunks []Hunk, start, end int) (newStart, newEnd int, clean bool) {
	clean = true
	ns, okS := mapLine(hunks, start)
	ne, okE := mapLine(hunks, end)
	for _, h := range hunks {
		oldLn := h.OldStart
		for _, op := range h.Ops {
			switch op {
			case ' ':
				oldLn++
			case '-':
				if oldLn >= start && oldLn <= end {
					clean = false
				}
				oldLn++
			case '+':
				// Inserted before oldLn: inside the range when between
				// two of its lines.
				if oldLn > start && oldLn <= end {
					clean = false
				}
			}
		}
	}
	if clean && okS && okE {
		return ns, ne, true
	}
	if ns < 1 {
		ns = 1
	}
	return ns, 0, false
}

// mapLine maps one old line. ok is false when the line was deleted; the
// returned line is then the predicted position.
func mapLine(hunks []Hunk, line int) (int, bool) {
	delta := 0
	for _, h := range hunks {
		if line < h.OldStart {
			return line + delta, true
		}
		if line < h.OldStart+h.OldLines {
			oldLn, newLn := h.OldStart, h.NewStart
			for _, op := range h.Ops {
				switch op {
				case ' ':
					if oldLn == line {
						return newLn, true
					}
					oldLn++
					newLn++
				case '-':
					if oldLn == line {
						return newLn, false
					}
					oldLn++
				case '+':
					newLn++
				}
			}
			return newLn, false
		}
		delta = (h.NewStart + h.NewLines) - (h.OldStart + h.OldLines)
	}
	return line + delta, true
}

// SplitLines splits text into lines without their terminators. A final
// newline does not start another line.
func SplitLines(s string) []string {
	s = strings.TrimSuffix(s, "\n")
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}

// maxDiffCells bounds the LCS table of DiffLines (4 bytes per cell).
const maxDiffCells = 1 << 22

// DiffLines computes the hunks turning a into b, for comparisons whose
// patch GitHub truncated. It trims the common prefix and suffix and runs an
// LCS on the rest when it is small enough; otherwise the rest is one hunk,
// so ranges in it are searched for instead of shifted.
func DiffLines(a, b []string) []Hunk {
	p := 0
	for p < len(a) && p < len(b) && a[p] == b[p] {
		p++
	}
	q := 0
	for q < len(a)-p && q < len(b)-p && a[len(a)-1-q] == b[len(b)-1-q] {
		q++
	}
	am, bm := a[p:len(a)-q], b[p:len(b)-q]
	if len(am) == 0 && len(bm) == 0 {
		return nil
	}
	n, m := len(am), len(bm)
	if (n+1)*(m+1) > maxDiffCells {
		return []Hunk{{OldStart: p + 1, OldLines: n, NewStart: p + 1, NewLines: m, Ops: opsOf(n, m)}}
	}
	// lcs[i][j] = LCS length of am[i:] and bm[j:].
	w := m + 1
	lcs := make([]int32, (n+1)*w)
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if am[i] == bm[j] {
				lcs[i*w+j] = lcs[(i+1)*w+j+1] + 1
			} else {
				lcs[i*w+j] = max(lcs[(i+1)*w+j], lcs[i*w+j+1])
			}
		}
	}
	var hunks []Hunk
	var cur *Hunk
	i, j := 0, 0
	emit := func(op byte) {
		if cur == nil {
			hunks = append(hunks, Hunk{OldStart: p + i + 1, NewStart: p + j + 1})
			cur = &hunks[len(hunks)-1]
		}
		cur.Ops = append(cur.Ops, op)
		if op == '-' {
			cur.OldLines++
		} else {
			cur.NewLines++
		}
	}
	for i < n || j < m {
		switch {
		case i < n && j < m && am[i] == bm[j]:
			cur = nil
			i++
			j++
		case j < m && (i == n || lcs[i*w+j+1] >= lcs[(i+1)*w+j]):
			emit('+')
			j++
		default:
			emit('-')
			i++
		}
	}
	return hunks
}

func opsOf(dels, adds int) []byte {
	ops := make([]byte, 0, dels+adds)
	for range dels {
		ops = append(ops, '-')
	}
	for range adds {
		ops = append(ops, '+')
	}
	return ops
}

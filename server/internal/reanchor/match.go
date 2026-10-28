package reanchor

import (
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/FullFran/galley/server/internal/comments"
)

// Search bounds. Exact search scans the whole file but scores at most
// maxOccurrences hits; fuzzy search only runs on quotes of minFuzzy to
// maxFuzzyPattern runes and on at most maxFuzzyText runes around the
// predicted line, so one thread costs at most 16 million cell updates; allow
// can refuse that cost (a listing's shared budget).
const (
	maxOccurrences  = 2000
	minFuzzy        = 8
	maxFuzzyPattern = 1000
	maxFuzzyText    = 16000
)

// FindExact returns the byte offsets [start, end) of the occurrence of
// q.Exact in text whose prefix and suffix agree best with q.Prefix and
// q.Suffix; ties go to the occurrence nearest predictedLine.
func FindExact(text string, q comments.Quote, predictedLine int) (start, end int, ok bool) {
	if q.Exact == "" {
		return 0, 0, false
	}
	starts := lineStarts(text)
	bestScore, bestDist := -1.0, 0
	for from, n := 0, 0; n < maxOccurrences; n++ {
		i := strings.Index(text[from:], q.Exact)
		if i < 0 {
			break
		}
		i += from
		score := contextScore(text[:i], text[i+len(q.Exact):], q)
		dist := abs(lineIn(starts, i) - predictedLine)
		if score > bestScore+1e-9 || (score > bestScore-1e-9 && dist < bestDist) {
			bestScore, bestDist, start = score, dist, i
		}
		from = i + 1
		if from >= len(text) {
			break
		}
	}
	if bestScore < 0 {
		return 0, 0, false
	}
	return start, start + len(q.Exact), true
}

// contextScore is in [0, 2]: how much of the prefix ends the text before
// the hit plus how much of the suffix starts the text after it.
func contextScore(before, after string, q comments.Quote) float64 {
	score := 0.0
	if q.Prefix != "" {
		n := 0
		for n < len(q.Prefix) && n < len(before) && q.Prefix[len(q.Prefix)-1-n] == before[len(before)-1-n] {
			n++
		}
		score += float64(n) / float64(len(q.Prefix))
	}
	if q.Suffix != "" {
		n := 0
		for n < len(q.Suffix) && n < len(after) && q.Suffix[n] == after[n] {
			n++
		}
		score += float64(n) / float64(len(q.Suffix))
	}
	return score
}

// FindFuzzy looks for the substring of text, within window lines of
// predictedLine, with the smallest edit distance to q.Exact (Sellers'
// approximate matching). A match needs a distance of at most a quarter of
// the quote; ties go to the match nearest predictedLine. It returns byte
// offsets [start, end). allow (nil allows everything) is asked for the
// number of cells first; skipped reports that it refused.
func FindFuzzy(text string, q comments.Quote, predictedLine, window int, allow func(cells int64) bool) (start, end int, ok, skipped bool) {
	pat := []rune(q.Exact)
	if len(pat) < minFuzzy || len(pat) > maxFuzzyPattern {
		return 0, 0, false, false
	}
	starts := lineStarts(text)
	quoteLines := strings.Count(q.Exact, "\n")
	first := clamp(predictedLine-window, 1, len(starts))
	last := clamp(predictedLine+window+quoteLines, 1, len(starts))
	from := starts[first-1]
	to := len(text)
	if last < len(starts) {
		to = starts[last]
	}
	region := text[from:to]
	runes := make([]rune, 0, min(len(region), maxFuzzyText))
	offs := make([]int, 0, cap(runes)+1)
	stop := to
	for i, r := range region {
		if len(runes) == maxFuzzyText {
			stop = from + i
			break
		}
		runes = append(runes, r)
		offs = append(offs, from+i)
	}
	if len(runes) == 0 {
		return 0, 0, false, false
	}
	offs = append(offs, stop)
	if allow != nil && !allow(int64(len(pat))*int64(len(runes))) {
		return 0, 0, false, true
	}

	m := len(pat)
	limit := m / 4
	// dist[i] is the edit distance of pat[:i] to the best substring ending
	// at the current text position; begin[i] is where that substring starts.
	dist := make([]int, m+1)
	begin := make([]int, m+1)
	prevDist := make([]int, m+1)
	prevBegin := make([]int, m+1)
	for i := range prevDist {
		prevDist[i] = i
	}
	best, bestDist := limit+1, 0
	for j := 1; j <= len(runes); j++ {
		dist[0], begin[0] = 0, j
		for i := 1; i <= m; i++ {
			d, b := prevDist[i-1], prevBegin[i-1] // substitute or match
			if pat[i-1] != runes[j-1] {
				d++
			}
			if prevDist[i]+1 < d { // text rune not in the pattern
				d, b = prevDist[i]+1, prevBegin[i]
			}
			if dist[i-1]+1 < d { // pattern rune missing from the text
				d, b = dist[i-1]+1, begin[i-1]
			}
			dist[i], begin[i] = d, b
		}
		if dist[m] <= limit {
			pd := abs(lineIn(starts, offs[begin[m]]) - predictedLine)
			if dist[m] < best || (dist[m] == best && pd < bestDist) {
				best, bestDist, start, end = dist[m], pd, offs[begin[m]], offs[j]
			}
		}
		dist, prevDist = prevDist, dist
		begin, prevBegin = prevBegin, begin
	}
	if best > limit {
		return 0, 0, false, false
	}
	return start, end, true, false
}

// rangeOf turns byte offsets [start, end) into a line range. With columns,
// columns are 1-based UTF-16 units and the end column is the last unit
// included, as the editor stores them; otherwise columns are 0.
func rangeOf(text string, start, end int, columns bool) comments.Range {
	last := end
	if end > start {
		_, size := utf8.DecodeLastRuneInString(text[:end])
		last = end - size
	}
	r := comments.Range{StartLine: lineAt(text, start), EndLine: lineAt(text, last)}
	if columns {
		r.StartColumn = utf16Col(text, start) + 1
		r.EndColumn = utf16Col(text, end)
		if r.EndLine != lineAt(text, end) || r.EndColumn == 0 {
			// The match ends with a newline: end at the last character.
			r.EndColumn = utf16Col(text, last) + 1
		}
		if r.StartLine == r.EndLine && r.EndColumn < r.StartColumn {
			r.EndColumn = r.StartColumn
		}
	}
	return r
}

func lineAt(text string, off int) int { return strings.Count(text[:off], "\n") + 1 }

// lineIn is the 1-based line of byte offset off, given lineStarts.
func lineIn(starts []int, off int) int {
	return sort.Search(len(starts), func(i int) bool { return starts[i] > off })
}

// utf16Col is the number of UTF-16 units between the start of off's line and
// off.
func utf16Col(text string, off int) int {
	ls := strings.LastIndexByte(text[:off], '\n') + 1
	n := 0
	for _, r := range text[ls:off] {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// lineStarts returns the byte offset of every line start (index = line-1).
func lineStarts(text string) []int {
	starts := []int{0}
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' && i+1 < len(text) {
			starts = append(starts, i+1)
		}
	}
	return starts
}

func clamp(v, lo, hi int) int { return max(lo, min(v, hi)) }

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

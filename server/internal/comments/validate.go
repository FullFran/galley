package comments

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Input limits, in bytes for text.
const (
	MaxPathBytes       = 512
	MaxBodyBytes       = 20 << 10
	MaxSuggestionBytes = 20 << 10
	MaxQuoteBytes      = 20 << 10
	MaxContextBytes    = 1 << 10
	MaxLine            = 1_000_000
	MaxColumn          = 100_000
)

// NewThread is the input to start a thread.
type NewThread struct {
	Path      string
	CommitSHA string
	Range     Range
	Quote     Quote
	Origin    Origin
	Body      string
	// Suggestion is nil for none; an empty string suggests deleting the range.
	Suggestion *string
}

// NewComment is the input of a reply or an edit.
type NewComment struct {
	Body       string
	Suggestion *string
}

func invalid(field string) error { return &ValidationError{Field: field} }

// Validate checks every field of a new thread.
func (n NewThread) Validate() error {
	if !ValidPath(n.Path) {
		return invalid("path")
	}
	if !ValidSHA(n.CommitSHA) {
		return invalid("commit_sha")
	}
	if err := validRange(n.Range); err != nil {
		return err
	}
	q := n.Quote
	if len(q.Exact) > MaxQuoteBytes || len(q.Prefix) > MaxContextBytes || len(q.Suffix) > MaxContextBytes ||
		!validText(q.Exact) || !validText(q.Prefix) || !validText(q.Suffix) ||
		(q.Exact == "" && (q.Prefix != "" || q.Suffix != "")) {
		return invalid("quote")
	}
	if n.Origin != OriginSource && n.Origin != OriginPreview {
		return invalid("origin")
	}
	return NewComment{Body: n.Body, Suggestion: n.Suggestion}.Validate()
}

// Validate checks the body and the optional suggestion.
func (n NewComment) Validate() error {
	if len(n.Body) > MaxBodyBytes || !validText(n.Body) || strings.TrimSpace(n.Body) == "" {
		return invalid("body")
	}
	if n.Suggestion != nil && (len(*n.Suggestion) > MaxSuggestionBytes || !validText(*n.Suggestion)) {
		return invalid("suggestion")
	}
	return nil
}

func validRange(r Range) error {
	switch {
	case r.StartLine < 1 || r.StartLine > MaxLine:
		return invalid("start_line")
	case r.EndLine < r.StartLine || r.EndLine > MaxLine:
		return invalid("end_line")
	case r.StartColumn < 0 || r.StartColumn > MaxColumn || (r.StartColumn == 0 && r.EndColumn != 0):
		return invalid("start_column")
	case r.EndColumn < 0 || r.EndColumn > MaxColumn || (r.StartColumn != 0 && r.EndColumn == 0):
		return invalid("end_column")
	case r.StartLine == r.EndLine && r.EndColumn < r.StartColumn:
		return invalid("end_column")
	}
	return nil
}

// validText accepts UTF-8 text without NUL or bidi controls; newlines,
// tabs and other format characters (such as the emoji joiner) are fine.
func validText(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && !strings.ContainsFunc(s, isBidiControl)
}

// isBidiControl reports the embedding, override and isolate controls
// (U+202A-U+202E, U+2066-U+2069) used in "Trojan Source" spoofing.
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// ValidPath accepts a repository-relative file path: at most MaxPathBytes,
// "/"-separated, no empty, "." or ".." segments, no leading or trailing
// slash, no backslash and no control or format (Unicode Cf, which includes
// the bidi controls and zero-width characters) characters.
func ValidPath(p string) bool {
	if p == "" || len(p) > MaxPathBytes || !utf8.ValidString(p) || strings.ContainsRune(p, '\\') {
		return false
	}
	for _, r := range p {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	for seg := range strings.SplitSeq(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// ValidSHA accepts a full lowercase hex commit id (SHA-1 or SHA-256).
func ValidSHA(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// IDLength is the length of record ids ([a-z0-9], PocketBase's format).
const IDLength = 15

// ValidID reports whether id has the record id format.
func ValidID(id string) bool {
	if len(id) != IDLength {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

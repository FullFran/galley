package notify

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// Link purposes. A token signed for one never opens as the other.
const (
	purposeVerify      = "verify"
	purposeUnsubscribe = "unsubscribe"
)

// maxLinkToken bounds a token before any decoding.
const maxLinkToken = 512

var errLink = errors.New("notify: invalid link")

// linkClaims are the signed fields of a link token. Email is a hash of the
// address, so a link stops working when the address changes and the token
// does not reveal it.
type linkClaims struct {
	Purpose string `json:"p"`
	User    string `json:"u"`
	Email   string `json:"e"`
	Expires int64  `json:"x"`
}

// signLink returns base64url(json claims) "." base64url(HMAC-SHA256). The
// key is derived from GALLEY_TOKEN_KEY for this purpose only.
func signLink(key []byte, purpose, userID, email string, expires time.Time) string {
	raw, _ := json.Marshal(linkClaims{Purpose: purpose, User: userID, Email: emailHash(email), Expires: expires.Unix()})
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(linkMAC(key, payload))
}

// openLink verifies a token's MAC (in constant time), purpose and expiry.
func openLink(key []byte, token, purpose string, now time.Time) (linkClaims, error) {
	if len(token) > maxLinkToken {
		return linkClaims{}, errLink
	}
	payload, mac, ok := strings.Cut(token, ".")
	if !ok || payload == "" {
		return linkClaims{}, errLink
	}
	got, err := base64.RawURLEncoding.DecodeString(mac)
	if err != nil || !hmac.Equal(got, linkMAC(key, payload)) {
		return linkClaims{}, errLink
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return linkClaims{}, errLink
	}
	var c linkClaims
	if err := json.Unmarshal(raw, &c); err != nil || c.Purpose != purpose || c.User == "" || !now.Before(time.Unix(c.Expires, 0)) {
		return linkClaims{}, errLink
	}
	return c, nil
}

func linkMAC(key []byte, payload string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("galley-link-v1."))
	m.Write([]byte(payload))
	return m.Sum(nil)
}

// emailHash is a short, case-insensitive fingerprint of an address.
func emailHash(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

// MaskEmail hides an address for logs: "alice@example.com" becomes
// "a***@e***.com". Anything that is not an address becomes "***".
func MaskEmail(email string) string {
	local, domain, ok := strings.Cut(email, "@")
	if !ok || local == "" || domain == "" {
		return "***"
	}
	first := func(s string) string { _, n := utf8.DecodeRuneInString(s); return s[:n] }
	out := first(local) + "***@" + first(domain) + "***"
	if i := strings.LastIndexByte(domain, '.'); i > 0 && i < len(domain)-1 {
		out += domain[i:]
	}
	return out
}

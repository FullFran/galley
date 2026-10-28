package notify

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestLinkTokens(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	now := time.Unix(1_800_000_000, 0)
	tok := signLink(key, purposeVerify, "user1", "a@example.com", now.Add(time.Hour))

	c, err := openLink(key, tok, purposeVerify, now)
	if err != nil || c.User != "user1" || c.Email != emailHash("A@Example.com") {
		t.Fatalf("open = %+v, %v", c, err)
	}
	if _, err := openLink(key, tok, purposeUnsubscribe, now); err == nil {
		t.Error("verification token accepted for unsubscribe")
	}
	if _, err := openLink(key, tok, purposeVerify, now.Add(2*time.Hour)); err == nil {
		t.Error("expired token accepted")
	}
	if _, err := openLink(bytes.Repeat([]byte{8}, 32), tok, purposeVerify, now); err == nil {
		t.Error("token signed with another key accepted")
	}
	payload, mac, _ := strings.Cut(tok, ".")
	forged := signLink(key, purposeVerify, "user2", "a@example.com", now.Add(time.Hour))
	fp, _, _ := strings.Cut(forged, ".")
	for _, bad := range []string{"", "x", payload, payload + ".", "." + mac, fp + "." + mac, tok + "x", strings.Repeat("a", 2000)} {
		if _, err := openLink(key, bad, purposeVerify, now); err == nil {
			t.Errorf("token %q accepted", bad)
		}
	}
}

func TestMaskEmail(t *testing.T) {
	for in, want := range map[string]string{
		"alice@example.com":    "a***@e***.com",
		"b@mail.example.co.uk": "b***@m***.uk",
		"x@localhost":          "x***@l***",
		"not-an-email":         "***",
		"":                     "***",
	} {
		if got := MaskEmail(in); got != want {
			t.Errorf("MaskEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

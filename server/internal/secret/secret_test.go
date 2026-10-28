package secret_test

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/secret"
)

func testKey() []byte { return bytes.Repeat([]byte{7}, secret.KeySize) }

func TestDecodeKey(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{name: "32 bytes standard base64", in: base64.StdEncoding.EncodeToString(testKey())},
		{name: "empty", in: "", wantErr: true},
		{name: "not base64", in: "%%%", wantErr: true},
		{name: "16 bytes is too short", in: base64.StdEncoding.EncodeToString(make([]byte, 16)), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := secret.DecodeKey(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSealerRoundTrip(t *testing.T) {
	s, err := secret.NewSealer(testKey())
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := s.Seal([]byte("ghr_refresh"), []byte("user-1"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, "ghr_refresh") {
		t.Fatal("ciphertext contains the plaintext")
	}
	again, _ := s.Seal([]byte("ghr_refresh"), []byte("user-1"))
	if again == sealed {
		t.Error("two seals of the same plaintext are identical; nonce is not random")
	}
	got, err := s.Open(sealed, []byte("user-1"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(got) != "ghr_refresh" {
		t.Errorf("open = %q", got)
	}
}

func TestSealerRejectsTampering(t *testing.T) {
	s, _ := secret.NewSealer(testKey())
	sealed, _ := s.Seal([]byte("ghr_refresh"), []byte("user-1"))
	raw, _ := base64.RawURLEncoding.DecodeString(sealed)
	flipped := append([]byte(nil), raw...)
	flipped[len(flipped)-1] ^= 0x01

	other, _ := secret.NewSealer(bytes.Repeat([]byte{8}, secret.KeySize))

	tests := []struct {
		name   string
		sealer *secret.Sealer
		value  string
		aad    string
	}{
		{name: "flipped ciphertext bit", sealer: s, value: base64.RawURLEncoding.EncodeToString(flipped), aad: "user-1"},
		{name: "different associated data", sealer: s, value: sealed, aad: "user-2"},
		{name: "different key", sealer: other, value: sealed, aad: "user-1"},
		{name: "truncated", sealer: s, value: sealed[:10], aad: "user-1"},
		{name: "not base64", sealer: s, value: "***", aad: "user-1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := tt.sealer.Open(tt.value, []byte(tt.aad)); err == nil {
				t.Fatal("open succeeded, want error")
			}
		})
	}
}

func TestRandomTokenAndHash(t *testing.T) {
	a, err := secret.RandomToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := secret.RandomToken()
	if a == b {
		t.Fatal("random tokens repeat")
	}
	if len(a) < 43 {
		t.Errorf("token %q shorter than 256 bits of base64url", a)
	}
	if secret.HashToken(a) != secret.HashToken(a) {
		t.Error("hash is not deterministic")
	}
	if secret.HashToken(a) == secret.HashToken(b) || secret.HashToken(a) == a {
		t.Error("hash does not distinguish tokens or returns the token")
	}
	if len(secret.HashToken(a)) != 64 {
		t.Errorf("hash length = %d, want 64 hex chars", len(secret.HashToken(a)))
	}
}

func TestDeriveKey(t *testing.T) {
	master := testKey()
	a, err := secret.DeriveKey(master, "galley-data-v1")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := secret.DeriveKey(master, "galley-data-v1")
	other, _ := secret.DeriveKey(master, "galley-other-v1")
	if len(a) != secret.KeySize {
		t.Fatalf("len = %d", len(a))
	}
	if !bytes.Equal(a, again) {
		t.Error("derivation is not deterministic")
	}
	if bytes.Equal(a, master) || bytes.Equal(a, other) {
		t.Error("derived key is not separated from the master or other purposes")
	}
	if _, err := secret.DeriveKey(make([]byte, 16), "galley-data-v1"); err == nil {
		t.Error("short master key accepted")
	}

	// A value sealed with the master key never opens with the derived key.
	ms, _ := secret.NewSealer(master)
	ds, _ := secret.NewSealer(a)
	sealed, _ := ms.Seal([]byte("x"), []byte("aad"))
	if _, err := ds.Open(sealed, []byte("aad")); err == nil {
		t.Error("derived key opened a value sealed with the master key")
	}
}

// Package secret holds galley's small cryptographic helpers: AES-256-GCM
// sealing for values stored at rest or in cookies, random opaque tokens, and
// token hashing so that only hashes of session tokens are persisted.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
)

// KeySize is the AES-256 key length in bytes.
const KeySize = 32

// ErrOpen is returned when a sealed value cannot be authenticated.
var ErrOpen = errors.New("secret: cannot open sealed value")

// DecodeKey decodes a standard base64 key and checks that it is KeySize bytes.
func DecodeKey(encoded string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("secret: key is not valid base64")
	}
	if len(key) != KeySize {
		return nil, fmt.Errorf("secret: key is %d bytes, want %d", len(key), KeySize)
	}
	return key, nil
}

// Sealer encrypts and authenticates values with AES-256-GCM.
type Sealer struct {
	aead cipher.AEAD
}

// NewSealer returns a Sealer for a KeySize-byte key.
func NewSealer(key []byte) (*Sealer, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("secret: key is %d bytes, want %d", len(key), KeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Sealer{aead: aead}, nil
}

// Seal encrypts plaintext with a random nonce. The associated data is
// authenticated but not stored, so the value only opens with the same aad.
// The result is base64url without padding: nonce || ciphertext || tag.
func (s *Sealer) Seal(plaintext, aad []byte) (string, error) {
	nonce := make([]byte, s.aead.NonceSize(), s.aead.NonceSize()+len(plaintext)+s.aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := s.aead.Seal(nonce, nonce, plaintext, aad)
	return base64.RawURLEncoding.EncodeToString(out), nil
}

// Open authenticates and decrypts a value produced by Seal.
func (s *Sealer) Open(sealed string, aad []byte) ([]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil || len(raw) < s.aead.NonceSize()+s.aead.Overhead() {
		return nil, ErrOpen
	}
	nonce, ciphertext := raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():]
	plaintext, err := s.aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, ErrOpen
	}
	return plaintext, nil
}

// RandomToken returns 32 random bytes encoded as base64url without padding.
func RandomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// HashToken returns the hex SHA-256 of a token. Tokens carry 256 bits of
// entropy, so a plain hash (no salt, no slow KDF) is sufficient for lookup.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

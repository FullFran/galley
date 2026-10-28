package config_test

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/config"
)

func validEnv() map[string]string {
	return map[string]string{
		"GALLEY_GITHUB_CLIENT_ID":     "Iv1.abc",
		"GALLEY_GITHUB_CLIENT_SECRET": "secret",
		"GALLEY_TOKEN_KEY":            base64.StdEncoding.EncodeToString(make([]byte, 32)),
		"GALLEY_WEBHOOK_SECRET":       "hook",
		"GALLEY_FRONTEND_ORIGIN":      "https://galley.fullfran.com",
		"GALLEY_PUBLIC_URL":           "https://galley-api.fullfran.com/",
	}
}

func TestLoad(t *testing.T) {
	env := validEnv()
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RedirectURI() != "https://galley-api.fullfran.com/api/galley/auth/callback" {
		t.Errorf("redirect uri = %q", cfg.RedirectURI())
	}
	if len(cfg.TokenKey) != 32 || cfg.FrontendOrigin != "https://galley.fullfran.com" {
		t.Errorf("cfg = %+v", cfg)
	}
	if len(cfg.DataKey) != 32 || bytes.Equal(cfg.DataKey, cfg.TokenKey) {
		t.Error("data key must be a separate 32-byte key derived from GALLEY_TOKEN_KEY")
	}
}

func TestLoadMail(t *testing.T) {
	env := validEnv()
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MailEnabled() {
		t.Error("mail must be disabled without GALLEY_RESEND_API_KEY")
	}
	if len(cfg.LinkKey) != 32 || bytes.Equal(cfg.LinkKey, cfg.TokenKey) || bytes.Equal(cfg.LinkKey, cfg.DataKey) {
		t.Error("link key must be a separate key derived from GALLEY_TOKEN_KEY")
	}
	env["GALLEY_RESEND_API_KEY"] = "re_123"
	env["GALLEY_MAIL_FROM"] = "galley <notify@notify.fullfran.com>"
	if cfg, err = config.Load(func(k string) string { return env[k] }); err != nil || !cfg.MailEnabled() || cfg.ResendAPIKey != "re_123" {
		t.Errorf("mail config = %v, %v", cfg.MailEnabled(), err)
	}
	env["GALLEY_MAIL_FROM"] = "not an address\r\nBcc: x@y.z"
	if _, err := config.Load(func(k string) string { return env[k] }); err == nil || strings.Contains(err.Error(), "Bcc") {
		t.Errorf("bad from err = %v", err)
	}
	delete(env, "GALLEY_MAIL_FROM")
	if cfg, err = config.Load(func(k string) string { return env[k] }); err != nil || cfg.MailEnabled() {
		t.Errorf("key without from = %v, %v", cfg.MailEnabled(), err)
	}
}

func TestLoadRejects(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
	}{
		{name: "missing client id", key: "GALLEY_GITHUB_CLIENT_ID", value: ""},
		{name: "missing client secret", key: "GALLEY_GITHUB_CLIENT_SECRET", value: ""},
		{name: "missing webhook secret", key: "GALLEY_WEBHOOK_SECRET", value: ""},
		{name: "short token key", key: "GALLEY_TOKEN_KEY", value: base64.StdEncoding.EncodeToString(make([]byte, 16))},
		{name: "origin with path", key: "GALLEY_FRONTEND_ORIGIN", value: "https://galley.fullfran.com/app"},
		{name: "origin with wildcard", key: "GALLEY_FRONTEND_ORIGIN", value: "https://*.fullfran.com"},
		{name: "plain http origin", key: "GALLEY_FRONTEND_ORIGIN", value: "http://galley.fullfran.com"},
		{name: "plain http public url", key: "GALLEY_PUBLIC_URL", value: "http://galley-api.fullfran.com"},
		{name: "missing public url", key: "GALLEY_PUBLIC_URL", value: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := validEnv()
			env[tt.key] = tt.value
			_, err := config.Load(func(k string) string { return env[k] })
			if err == nil {
				t.Fatal("err = nil")
			}
			if !strings.Contains(err.Error(), tt.key) {
				t.Errorf("error %q does not name %s", err, tt.key)
			}
			if strings.Contains(err.Error(), "secret") && tt.value != "" && strings.Contains(err.Error(), tt.value) {
				t.Errorf("error leaks the value")
			}
		})
	}
}

func TestLoadAllowsLocalhostOverHTTP(t *testing.T) {
	env := validEnv()
	env["GALLEY_FRONTEND_ORIGIN"] = "http://localhost:5173"
	env["GALLEY_PUBLIC_URL"] = "http://127.0.0.1:8090"
	if _, err := config.Load(func(k string) string { return env[k] }); err != nil {
		t.Fatalf("local dev config rejected: %v", err)
	}
}

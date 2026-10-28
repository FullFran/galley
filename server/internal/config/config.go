// Package config reads galley's settings from the environment.
package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/FullFran/galley/server/internal/secret"
)

// CallbackPath is the OAuth callback route, relative to PublicURL.
const CallbackPath = "/api/galley/auth/callback"

// Config holds the server settings. Secrets are never printed.
type Config struct {
	GitHubClientID     string
	GitHubClientSecret string
	TokenKey           []byte
	WebhookSecret      string
	// FrontendOrigin is the exact browser origin allowed to call the API.
	FrontendOrigin string
	// PublicURL is the API base URL as seen by browsers and GitHub.
	PublicURL string
}

// RedirectURI is the OAuth callback URL registered in the GitHub App.
func (c Config) RedirectURI() string {
	return c.PublicURL + CallbackPath
}

// Load reads the configuration with getenv (usually os.Getenv) and fails on
// the first missing or invalid value. Errors name the variable, not its value.
func Load(getenv func(string) string) (Config, error) {
	var c Config
	var err error
	required := func(name string) string {
		v := strings.TrimSpace(getenv(name))
		if v == "" && err == nil {
			err = fmt.Errorf("config: %s is required", name)
		}
		return v
	}

	c.GitHubClientID = required("GALLEY_GITHUB_CLIENT_ID")
	c.GitHubClientSecret = required("GALLEY_GITHUB_CLIENT_SECRET")
	c.WebhookSecret = required("GALLEY_WEBHOOK_SECRET")
	key := required("GALLEY_TOKEN_KEY")
	origin := required("GALLEY_FRONTEND_ORIGIN")
	public := required("GALLEY_PUBLIC_URL")
	if err != nil {
		return Config{}, err
	}

	if c.TokenKey, err = secret.DecodeKey(key); err != nil {
		return Config{}, fmt.Errorf("config: GALLEY_TOKEN_KEY must be base64 of %d bytes", secret.KeySize)
	}
	if c.FrontendOrigin, err = parseOrigin(origin, false); err != nil {
		return Config{}, fmt.Errorf("config: GALLEY_FRONTEND_ORIGIN %w", err)
	}
	if c.PublicURL, err = parseOrigin(public, true); err != nil {
		return Config{}, fmt.Errorf("config: GALLEY_PUBLIC_URL %w", err)
	}
	return c, nil
}

// parseOrigin accepts scheme://host[:port] with no path, query or wildcard.
// https is required except for loopback hosts during local development.
// A trailing slash is tolerated only when allowSlash is set.
func parseOrigin(raw string, allowSlash bool) (string, error) {
	if allowSlash {
		raw = strings.TrimRight(raw, "/")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(u.Host, "*?") {
		return "", fmt.Errorf("must be scheme://host[:port]")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopback(u.Hostname()) {
			return "", fmt.Errorf("must use https")
		}
	default:
		return "", fmt.Errorf("must use https")
	}
	return u.Scheme + "://" + u.Host, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

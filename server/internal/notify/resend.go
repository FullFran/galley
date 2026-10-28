package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultResendBaseURL is Resend's API.
const DefaultResendBaseURL = "https://api.resend.com"

const resendTimeout = 10 * time.Second

// ResendMailer implements Mailer with Resend's POST /emails.
type ResendMailer struct {
	APIKey string
	// From is the sender, for example "galley <notify@notify.fullfran.com>".
	From       string
	BaseURL    string
	HTTPClient *http.Client
}

var _ Mailer = (*ResendMailer)(nil)

// Send implements Mailer. The idempotency key is passed to Resend too, so a
// retried request is not delivered twice. Errors carry only the status:
// Resend may echo addresses in its error bodies.
func (m *ResendMailer) Send(ctx context.Context, msg Message) error {
	body, err := json.Marshal(struct {
		From    string            `json:"from"`
		To      []string          `json:"to"`
		Subject string            `json:"subject"`
		Text    string            `json:"text"`
		HTML    string            `json:"html,omitempty"`
		Headers map[string]string `json:"headers,omitempty"`
	}{m.From, []string{msg.To}, msg.Subject, msg.Text, msg.HTML, msg.Headers})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, resendTimeout)
	defer cancel()
	base := m.BaseURL
	if base == "" {
		base = DefaultResendBaseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/emails", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "galley")
	if msg.IdempotencyKey != "" {
		req.Header.Set("Idempotency-Key", msg.IdempotencyKey)
	}
	client := m.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: resendTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("resend: request failed: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("resend: status %d", resp.StatusCode)
	}
	return nil
}

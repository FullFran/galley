package notify_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/notify"
)

func TestResendRequestShape(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/emails" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer re_test" || r.Header.Get("Content-Type") != "application/json" ||
			r.Header.Get("Idempotency-Key") != "key-1" {
			t.Errorf("headers = %v", r.Header)
		}
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"id":"e1"}`)
	}))
	defer srv.Close()
	m := &notify.ResendMailer{APIKey: "re_test", From: "galley <notify@notify.example.com>", BaseURL: srv.URL, HTTPClient: srv.Client()}
	err := m.Send(context.Background(), notify.Message{
		To: "bob@example.com", Subject: "S", Text: "T", HTML: "<p>T</p>", IdempotencyKey: "key-1",
		Headers: map[string]string{"List-Unsubscribe": "<https://api.example.com/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"},
	})
	if err != nil {
		t.Fatal(err)
	}
	to, _ := got["to"].([]any)
	headers, _ := got["headers"].(map[string]any)
	if got["from"] != "galley <notify@notify.example.com>" || len(to) != 1 || to[0] != "bob@example.com" ||
		got["subject"] != "S" || got["text"] != "T" || got["html"] != "<p>T</p>" ||
		headers["List-Unsubscribe-Post"] != "List-Unsubscribe=One-Click" {
		t.Errorf("body = %v", got)
	}
}

func TestResendErrorsCarryNoBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = io.WriteString(w, `{"message":"invalid to: bob@example.com"}`)
	}))
	defer srv.Close()
	m := &notify.ResendMailer{APIKey: "re_test", From: "f@example.com", BaseURL: srv.URL, HTTPClient: srv.Client()}
	err := m.Send(context.Background(), notify.Message{To: "bob@example.com", Subject: "S", Text: "T"})
	if err == nil || strings.Contains(err.Error(), "bob") || strings.Contains(err.Error(), "re_test") {
		t.Errorf("err = %v", err)
	}
}

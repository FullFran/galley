package httpapi_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/FullFran/galley/server/internal/httpapi"
)

func newTestHandler(t *testing.T, deps httpapi.Deps) http.Handler {
	t.Helper()
	r := router.NewRouter(func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		return &core.RequestEvent{Event: router.Event{Response: w, Request: req}}, nil
	})
	httpapi.Register(r, deps)
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatalf("build mux: %v", err)
	}
	return mux
}

func TestHealth(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		wantStatus int
		wantBody   map[string]string
	}{
		{name: "GET reports ok", method: http.MethodGet, wantStatus: http.StatusOK, wantBody: map[string]string{"status": "ok"}},
		{name: "POST is not routed", method: http.MethodPost, wantStatus: http.StatusNotFound},
	}

	handler := newTestHandler(t, testDeps(&fakeAuth{}))
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(tt.method, "/api/galley/health", nil))

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if tt.wantBody == nil {
				return
			}
			if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q, want application/json", ct)
			}
			var got map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
				t.Fatalf("decode body %q: %v", rec.Body.String(), err)
			}
			if len(got) != len(tt.wantBody) || got["status"] != tt.wantBody["status"] {
				t.Errorf("body = %v, want %v", got, tt.wantBody)
			}
		})
	}
}

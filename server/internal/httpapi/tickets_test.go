package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/httpapi"
	"github.com/FullFran/galley/server/internal/pbstore"
	"github.com/FullFran/galley/server/internal/secret"
	"github.com/FullFran/galley/server/internal/tickets"
)

func TestTicketsThroughTheRoutes(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	store := pbstore.New(app)
	ctx := context.Background()
	alice, err := store.UpsertUser(ctx, auth.GitHubUser{ID: 42, Login: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	boss, err := store.UpsertUser(ctx, auth.GitHubUser{ID: 43, Login: "boss"})
	if err != nil {
		t.Fatal(err)
	}
	ticketStore := pbstore.NewTicketStore(app)
	col, err := app.FindCollectionByNameOrId(pbstore.TicketAdminsCollection)
	if err != nil {
		t.Fatal(err)
	}
	row := core.NewRecord(col)
	row.Set("user", boss.ID)
	if err := app.Save(row); err != nil {
		t.Fatal(err)
	}
	sealer, err := secret.NewSealer(make([]byte, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	svc, err := tickets.NewService(tickets.Config{Store: ticketStore, Sealer: sealer})
	if err != nil {
		t.Fatal(err)
	}
	fa := &tourAuth{user: alice}
	d := testDeps(&fa.fakeAuth)
	d.Auth = fa
	d.Tickets = svc
	h := newTestHandler(t, d)

	call := func(req *http.Request, code int) map[string]any {
		t.Helper()
		resp := do(t, h, req)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != code {
			t.Fatalf("%s %s: %d %s; want %d", req.Method, req.URL, resp.StatusCode, raw, code)
		}
		if got := resp.Header.Get("Cache-Control"); code != 403 && !strings.Contains(got, "no-store") {
			t.Fatalf("%s %s: Cache-Control = %q", req.Method, req.URL, got)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		return out
	}

	post := `{"category":"bug","description":"blank preview in chapter two","steps":"open it","version":"abc","device":"Firefox","diagnostics":{"locale":"es"}}`
	created := call(browserReq("POST", httpapi.MePrefix+"/tickets", post), 201)
	ref, _ := created["ref"].(string)
	if !strings.HasPrefix(ref, "GL-") || len(ref) != 9 {
		t.Fatalf("ref = %q", ref)
	}

	// At rest the text is sealed; the reference and the category are not.
	rec, err := app.FindFirstRecordByData(pbstore.TicketsCollection, "ref", ref)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"description", "steps", "diagnostics"} {
		if v := rec.GetString(f); v == "" || strings.Contains(v, "blank preview") || strings.Contains(v, "open it") || strings.Contains(v, "locale") {
			t.Fatalf("%s at rest = %q", f, v)
		}
	}
	if rec.GetString("user") != alice.ID || rec.GetString("login") != "alice" || rec.GetString("status") != "new" {
		t.Fatalf("record = %v", rec.PublicExport())
	}

	// A plain user: no access, and the inbox refuses.
	if got := call(browserReq("GET", httpapi.MePrefix+"/tickets/access", ""), 200); !reflect.DeepEqual(got, map[string]any{"admin": false}) {
		t.Fatalf("access = %v", got)
	}
	call(browserReq("GET", httpapi.TicketsPrefix+"/inbox", ""), 403)
	call(browserReq("PATCH", httpapi.TicketsPrefix+"/inbox/"+ref, `{"status":"closed"}`), 403)

	// The admin.
	fa.user = boss
	if got := call(browserReq("GET", httpapi.MePrefix+"/tickets/access", ""), 200); !reflect.DeepEqual(got, map[string]any{"admin": true}) {
		t.Fatalf("access = %v", got)
	}
	list := call(browserReq("GET", httpapi.TicketsPrefix+"/inbox", ""), 200)
	items, _ := list["tickets"].([]any)
	if list["total"] != float64(1) || len(items) != 1 {
		t.Fatalf("list = %v", list)
	}
	item := items[0].(map[string]any)
	if item["ref"] != ref || item["description"] != "blank preview in chapter two" || item["steps"] != "open it" || item["login"] != "alice" ||
		item["status"] != "new" || item["github_issue"] != float64(0) || item["version"] != "abc" || item["device"] != "Firefox" || item["category"] != "bug" {
		t.Fatalf("item = %v", item)
	}
	if !reflect.DeepEqual(item["diagnostics"], map[string]any{"locale": "es"}) {
		t.Fatalf("diagnostics = %v", item["diagnostics"])
	}
	if _, err := time.Parse(time.RFC3339, item["created"].(string)); err != nil {
		t.Fatalf("created = %v", item["created"])
	}
	if got := call(browserReq("GET", httpapi.TicketsPrefix+"/inbox?status=closed", ""), 200); got["total"] != float64(0) {
		t.Fatalf("closed = %v", got)
	}
	call(browserReq("GET", httpapi.TicketsPrefix+"/inbox?status=lost", ""), 422)

	linked := call(browserReq("PATCH", httpapi.TicketsPrefix+"/inbox/"+ref, `{"status":"issue","github_issue":12}`), 200)
	if linked["status"] != "issue" || linked["github_issue"] != float64(12) || linked["description"] == "" {
		t.Fatalf("linked = %v", linked)
	}
	closed := call(browserReq("PATCH", httpapi.TicketsPrefix+"/inbox/"+ref, `{"status":"closed"}`), 200)
	if closed["status"] != "closed" || closed["github_issue"] != float64(12) {
		t.Fatalf("closed = %v", closed)
	}
	if got := call(browserReq("GET", httpapi.TicketsPrefix+"/inbox?status=closed", ""), 200); got["total"] != float64(1) {
		t.Fatalf("closed = %v", got)
	}
	call(browserReq("PATCH", httpapi.TicketsPrefix+"/inbox/GL-ZZZZZZ", `{"status":"closed"}`), 404)
	call(browserReq("PATCH", httpapi.TicketsPrefix+"/inbox/"+ref, `{"status":"closed","owner":"x"}`), 400)

	// Input errors and the shared credentialed middleware.
	fa.user = alice
	call(browserReq("POST", httpapi.MePrefix+"/tickets", `{"category":"bug"}`), 422)
	call(browserReq("POST", httpapi.MePrefix+"/tickets", `{"category":"bug","description":"x","user":"other"}`), 400)
	call(browserReq("POST", httpapi.MePrefix+"/tickets", `{"category":"bug","description":"`+strings.Repeat("x", 33<<10)+`"}`), 413)
	noCSRF := browserReq("POST", httpapi.MePrefix+"/tickets", post)
	noCSRF.Header.Del("X-Galley-CSRF")
	call(noCSRF, 403)
	badOrigin := browserReq("POST", httpapi.MePrefix+"/tickets", post)
	badOrigin.Header.Set("Origin", "https://evil.example")
	call(badOrigin, 403)
}

func TestTicketRoutesStayOffWithoutTheService(t *testing.T) {
	h := newTestHandler(t, testDeps(&fakeAuth{}))
	resp := do(t, h, browserReq("POST", httpapi.MePrefix+"/tickets", `{}`))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

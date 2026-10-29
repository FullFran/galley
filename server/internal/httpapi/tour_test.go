package httpapi_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"github.com/FullFran/galley/server/internal/auth"
	"github.com/FullFran/galley/server/internal/httpapi"
	"github.com/FullFran/galley/server/internal/pbstore"
)

type tourAuth struct {
	fakeAuth
	user auth.User
}

func (f *tourAuth) Authenticate(ctx context.Context, token string) (auth.User, error) {
	if _, err := f.fakeAuth.Authenticate(ctx, token); err != nil {
		return auth.User{}, err
	}
	return f.user, nil
}

func TestTourState(t *testing.T) {
	app, err := tests.NewTestAppWithConfig(core.BaseAppConfig{DataDir: t.TempDir(), EncryptionEnv: "pb_test_env"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	store := pbstore.New(app)
	a, err := store.UpsertUser(context.Background(), auth.GitHubUser{ID: 42, Login: "alice"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.UpsertUser(context.Background(), auth.GitHubUser{ID: 43, Login: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	fa := &tourAuth{user: a}
	d := testDeps(&fa.fakeAuth)
	d.Auth = fa
	d.Tour = store
	d.Notify = &fakeNotify{}
	h := newTestHandler(t, d)
	check := func(req *http.Request, code int, body string) {
		t.Helper()
		resp := do(t, h, req)
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var got, want any
		gotErr, wantErr := json.Unmarshal(raw, &got), json.Unmarshal([]byte(body), &want)
		if resp.StatusCode != code || gotErr != nil || wantErr != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("%s %s: %d %s; want %d %s", req.Method, req.URL, resp.StatusCode, raw, code, body)
		}
	}
	get := func(status string) {
		t.Helper()
		check(browserReq("GET", httpapi.MePrefix+"/tour", ""), 200, `{"version":1,"status":`+status+`}`)
	}
	get("null")
	for _, status := range []string{"done", "skipped", "skipped"} {
		body := `{"version":1,"status":"` + status + `"}`
		check(browserReq("PUT", httpapi.MePrefix+"/tour", body), 200, body)
		get(`"` + status + `"`)
	}
	for _, tc := range []struct {
		body     string
		code     int
		response string
	}{
		{`{"version":2,"status":"done"}`, 422, `{"error":"Unprocessable Entity","field":"version"}`},
		{`{"version":0,"status":"done"}`, 422, `{"error":"Unprocessable Entity","field":"version"}`},
		{`{"status":"done"}`, 422, `{"error":"Unprocessable Entity","field":"version"}`},
		{`{"version":1,"status":"started"}`, 422, `{"error":"Unprocessable Entity","field":"status"}`},
		{`{"version":1,"status":null}`, 422, `{"error":"Unprocessable Entity","field":"status"}`},
		{`{"version":1}`, 422, `{"error":"Unprocessable Entity","field":"status"}`},
		{`{"version":1,"status":"done","user_id":"other"}`, 400, `{"error":"Bad Request"}`},
		{`{"version":1.5,"status":"done"}`, 400, `{"error":"Bad Request"}`},
		{`{`, 400, `{"error":"Bad Request"}`},
		{strings.Repeat(" ", 1025), 413, `{"error":"Request Entity Too Large"}`},
	} {
		check(browserReq("PUT", httpapi.MePrefix+"/tour", tc.body), tc.code, tc.response)
		get(`"skipped"`)
	}
	for _, method := range []string{"GET", "PUT"} {
		for _, mode := range []string{"origin", "missing origin", "session", "invalid session", "csrf"} {
			if method == "GET" && mode == "csrf" {
				continue
			}
			req := browserReq(method, httpapi.MePrefix+"/tour", `{"version":1,"status":"done"}`)
			code, msg := 403, "Forbidden"
			switch mode {
			case "origin":
				req.Header.Set("Origin", frontend+".evil")
			case "missing origin":
				req.Header.Del("Origin")
			case "session":
				req.Header.Del("Cookie")
				code, msg = 401, "Unauthorized"
			case "invalid session":
				fa.authErr = auth.ErrUnauthenticated
				code, msg = 401, "Unauthorized"
			case "csrf":
				req.Header.Del(httpapi.CSRFHeader)
			}
			check(req, code, `{"error":"`+msg+`"}`)
			fa.authErr = nil
			get(`"skipped"`)
		}
	}
	fa.user = b
	get("null")
	check(browserReq("PUT", httpapi.MePrefix+"/tour", `{"version":1,"status":"done"}`), 200, `{"version":1,"status":"done"}`)
	fa.user = a
	get(`"skipped"`)
	renamed, err := store.UpsertUser(context.Background(), auth.GitHubUser{ID: 42, Login: "renamed"})
	if err != nil || renamed.ID != a.ID {
		t.Fatalf("upsert: %+v %v", renamed, err)
	}
	get(`"skipped"`)
	resp := do(t, h, browserReq("GET", httpapi.MePrefix+"/tour", ""))
	resp.Body.Close()
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("missing no-store")
	}
	for _, path := range []string{"/tour", "/notifications"} {
		req := browserReq("OPTIONS", httpapi.MePrefix+path, "")
		req.Header.Set("Access-Control-Request-Method", "PUT")
		req.Header.Set("Access-Control-Request-Headers", httpapi.CSRFHeader)
		resp := do(t, h, req)
		resp.Body.Close()
		if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != frontend || resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
			t.Fatalf("preflight %s: %d %v", path, resp.StatusCode, resp.Header)
		}
	}
}

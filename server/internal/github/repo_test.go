package github_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/comments"
)

// installations serves GET /user/installations and
// GET /user/installations/{id}/repositories with real pagination.
func installations(t *testing.T, repos map[string][]string, status int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghu_user" {
			t.Errorf("auth %q", r.Header.Get("Authorization"))
		}
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if page == 0 {
			page = 1
		}
		per, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
		if per != 100 {
			t.Errorf("per_page = %d", per)
		}
		slice := func(items []string) []string {
			// The fake pages by 2 to exercise pagination regardless of per_page.
			lo, hi := (page-1)*2, page*2
			if lo > len(items) {
				return nil
			}
			return items[lo:min(hi, len(items))]
		}
		if r.URL.Path == "/user/installations" {
			var ids []string
			for id := range repos {
				ids = append(ids, id)
			}
			if len(ids) > 1 && ids[0] > ids[1] {
				ids[0], ids[1] = ids[1], ids[0]
			}
			var out []string
			for _, id := range slice(ids) {
				out = append(out, `{"id":`+id+`}`)
			}
			fmt.Fprintf(w, `{"total_count":%d,"installations":[%s]}`, len(ids), strings.Join(out, ","))
			return
		}
		id, ok := strings.CutPrefix(r.URL.Path, "/user/installations/")
		id, ok2 := strings.CutSuffix(id, "/repositories")
		if !ok || !ok2 {
			t.Errorf("path %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		items := repos[id]
		fmt.Fprintf(w, `{"total_count":%d,"repositories":[%s]}`, len(items), strings.Join(slice(items), ","))
	}
}

func repo(id int64, name string, push, pull bool) string {
	return fmt.Sprintf(`{"id":%d,"full_name":%q,"permissions":{"admin":false,"maintain":false,"push":%v,"triage":false,"pull":%v}}`, id, name, push, pull)
}

func TestInstalledRepos(t *testing.T) {
	c := newClient(t, installations(t, map[string][]string{
		"11": {repo(1, "o/a", true, true), repo(2, "o/b", false, true), repo(3, "o/c", false, true)},
		"12": {repo(4, "p/d", false, false), `{"id":5,"full_name":"p/e","permissions":{"maintain":true}}`,
			`{"id":6,"full_name":"p/f","permissions":{"admin":true}}`},
	}, 0))
	got, err := c.InstalledRepos(context.Background(), "ghu_user")
	if err != nil {
		t.Fatal(err)
	}
	want := map[int64]comments.RepoPermission{
		1: {FullName: "o/a", Pull: true, Push: true},
		2: {FullName: "o/b", Pull: true},
		3: {FullName: "o/c", Pull: true},
		4: {FullName: "p/d"},
		5: {FullName: "p/e", Pull: true, Push: true},
		6: {FullName: "p/f", Pull: true, Push: true, Admin: true},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d repos: %+v", len(got), got)
	}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("repo %d = %+v, want %+v", id, got[id], w)
		}
	}
}

func TestInstalledReposErrors(t *testing.T) {
	c := newClient(t, installations(t, nil, http.StatusUnauthorized))
	if _, err := c.InstalledRepos(context.Background(), "ghu_user"); !errors.Is(err, comments.ErrUnauthenticated) {
		t.Errorf("401 err = %v", err)
	}
	c = newClient(t, installations(t, nil, http.StatusForbidden))
	if _, err := c.InstalledRepos(context.Background(), "ghu_user"); err == nil || errors.Is(err, comments.ErrNotFound) {
		t.Errorf("403 err = %v, want a transient error", err)
	}
	c = newClient(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("not json")) })
	if _, err := c.InstalledRepos(context.Background(), "ghu_user"); err == nil {
		t.Error("garbage accepted")
	}
}

package github_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/github"
	"github.com/FullFran/galley/server/internal/notify"
)

func apiClient(t *testing.T, h http.HandlerFunc) *github.Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &github.Client{APIBaseURL: srv.URL, HTTPClient: srv.Client()}
}

var (
	ctx     = context.Background()
	baseSHA = strings.Repeat("a", 40)
	headSHA = strings.Repeat("b", 40)
)

func TestCompare(t *testing.T) {
	c := apiClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghu_user" || r.Header.Get("X-GitHub-Api-Version") == "" {
			t.Errorf("headers = %v", r.Header)
		}
		if r.URL.Path != "/repos/o/r/compare/"+baseSHA+"..."+headSHA || r.URL.Query().Get("per_page") != "1" {
			t.Errorf("url = %s", r.URL)
		}
		fmt.Fprint(w, `{"files":[{"filename":"b.qmd","previous_filename":"a.qmd","status":"renamed","patch":"@@ -1 +1 @@\n-x\n+y"},{"filename":"big.pdf","status":"modified"}]}`)
	})
	cmp, err := c.Compare(ctx, "ghu_user", "o/r", baseSHA, headSHA)
	if err != nil {
		t.Fatal(err)
	}
	if cmp.Truncated || len(cmp.Files) != 2 || cmp.Files[0].PreviousFilename != "a.qmd" || cmp.Files[0].Patch == "" || cmp.Files[1].Patch != "" {
		t.Errorf("comparison = %+v", cmp)
	}
}

func TestCompareTruncation(t *testing.T) {
	c := apiClient(t, func(w http.ResponseWriter, r *http.Request) {
		var files []string
		for i := 0; i < 300; i++ {
			files = append(files, fmt.Sprintf(`{"filename":"f%d","status":"modified","patch":"@@ -1 +1 @@\n-a\n+b"}`, i))
		}
		fmt.Fprintf(w, `{"files":[%s]}`, strings.Join(files, ","))
	})
	cmp, err := c.Compare(ctx, "ghu_user", "o/r", baseSHA, headSHA)
	if err != nil || !cmp.Truncated {
		t.Errorf("300 files = truncated %v, %v", cmp.Truncated, err)
	}
}

func TestCompareErrors(t *testing.T) {
	for _, tt := range []struct {
		status int
		want   error
	}{{401, comments.ErrUnauthenticated}, {404, comments.ErrNotFound}} {
		c := apiClient(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tt.status) })
		if _, err := c.Compare(ctx, "ghu_user", "o/r", baseSHA, headSHA); !errors.Is(err, tt.want) {
			t.Errorf("status %d err = %v", tt.status, err)
		}
	}
	c := apiClient(t, func(w http.ResponseWriter, r *http.Request) { t.Error("must not be called") })
	for _, bad := range []string{"o", "o/r/x", "../r", "o/r?x"} {
		if _, err := c.Compare(ctx, "ghu_user", bad, baseSHA, headSHA); err == nil {
			t.Errorf("repo %q accepted", bad)
		}
	}
	if _, err := c.Compare(ctx, "ghu_user", "o/r", "main", headSHA); err == nil {
		t.Error("non-sha base accepted")
	}
}

func TestFileAt(t *testing.T) {
	c := apiClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.github.raw+json" || r.URL.Query().Get("ref") != headSHA {
			t.Errorf("request = %v %s", r.Header, r.URL)
		}
		switch r.URL.EscapedPath() {
		case "/repos/o/r/contents/dir/a%20b.qmd":
			fmt.Fprint(w, "content\n")
		case "/repos/o/r/contents/big.qmd":
			fmt.Fprint(w, strings.Repeat("x", 1<<20+1))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	got, found, err := c.FileAt(ctx, "ghu_user", "o/r", "dir/a b.qmd", headSHA)
	if err != nil || !found || got != "content\n" {
		t.Errorf("file = %q %v %v", got, found, err)
	}
	if _, found, err := c.FileAt(ctx, "ghu_user", "o/r", "missing.qmd", headSHA); err != nil || found {
		t.Errorf("missing = %v %v", found, err)
	}
	if _, _, err := c.FileAt(ctx, "ghu_user", "o/r", "big.qmd", headSHA); err == nil {
		t.Error("oversized file accepted")
	}
}

func TestIssueAndReviewers(t *testing.T) {
	c := apiClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/o/r/pulls/5":
			fmt.Fprint(w, `{"requested_reviewers":[{"id":2,"login":"Bob"},{"id":3,"login":"carol"}],"requested_teams":[{"slug":"t"}]}`)
		case "/repos/o/r/issues/5":
			fmt.Fprint(w, `{"assignees":[{"id":4,"login":"dave"}],"pull_request":{"url":"x"}}`)
		case "/repos/o/r/issues/6":
			fmt.Fprint(w, `{"assignees":[]}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	revs, err := c.RequestedReviewers(ctx, "ghu_user", "o/r", 5)
	if err != nil || len(revs) != 2 || revs[0] != (notify.Account{ID: 2, Login: "Bob"}) {
		t.Errorf("reviewers = %v %v", revs, err)
	}
	is, err := c.Issue(ctx, "ghu_user", "o/r", 5)
	if err != nil || !is.PullRequest || len(is.Assignees) != 1 || is.Assignees[0] != (notify.Account{ID: 4, Login: "dave"}) {
		t.Errorf("issue = %+v %v", is, err)
	}
	if is, _ := c.Issue(ctx, "ghu_user", "o/r", 6); is.PullRequest {
		t.Error("plain issue reported as a pull request")
	}
	if _, err := c.RequestedReviewers(ctx, "ghu_user", "o/r", 9); !errors.Is(err, comments.ErrNotFound) {
		t.Errorf("missing pull err = %v", err)
	}
}

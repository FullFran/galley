package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/FullFran/galley/server/internal/comments"
	"github.com/FullFran/galley/server/internal/notify"
	"github.com/FullFran/galley/server/internal/reanchor"
)

const (
	// maxCompareBytes bounds a comparison body; a larger one is treated as
	// truncated, so the re-anchorer diffs the file versions itself.
	maxCompareBytes = 16 << 20
	// maxFileBytes bounds a file fetched for re-anchoring.
	maxFileBytes = 1 << 20
	// maxCompareFiles is GitHub's cap on the files of a comparison.
	maxCompareFiles = 300
	maxSmallBytes   = 1 << 20
)

var (
	_ reanchor.GitHub = (*Client)(nil)
	_ notify.GitHub   = (*Client)(nil)

	repoName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
)

// errTooLarge marks a body over its limit.
var errTooLarge = errors.New("github: response too large")

// repoPath returns /repos/{owner}/{repo} for a full name, refusing anything
// that could change the request path.
func repoPath(fullName string) (string, error) {
	if !repoName.MatchString(fullName) {
		return "", errors.New("github: invalid repository name")
	}
	owner, repo, _ := strings.Cut(fullName, "/")
	if owner == "." || owner == ".." || repo == "." || repo == ".." {
		return "", errors.New("github: invalid repository name")
	}
	return "/repos/" + owner + "/" + repo, nil
}

// Compare implements reanchor.GitHub (GET .../compare/{base}...{head}).
// per_page=1 keeps the commit list short; files are on the first page.
func (c *Client) Compare(ctx context.Context, token, fullName, base, head string) (reanchor.Comparison, error) {
	rp, err := repoPath(fullName)
	if err != nil {
		return reanchor.Comparison{}, err
	}
	if !comments.ValidSHA(base) || !comments.ValidSHA(head) {
		return reanchor.Comparison{}, errors.New("github: invalid commit sha")
	}
	raw, err := c.get(ctx, token, rp+"/compare/"+base+"..."+head+"?per_page=1", "application/vnd.github+json", maxCompareBytes)
	if errors.Is(err, errTooLarge) {
		return reanchor.Comparison{Truncated: true}, nil
	}
	if err != nil {
		return reanchor.Comparison{}, err
	}
	var body struct {
		Files []struct {
			Filename         string `json:"filename"`
			PreviousFilename string `json:"previous_filename"`
			Status           string `json:"status"`
			Patch            string `json:"patch"`
		} `json:"files"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return reanchor.Comparison{}, errors.New("github: compare endpoint returned an invalid body")
	}
	out := reanchor.Comparison{Truncated: len(body.Files) >= maxCompareFiles}
	for _, f := range body.Files {
		out.Files = append(out.Files, reanchor.File{Filename: f.Filename, PreviousFilename: f.PreviousFilename, Status: f.Status, Patch: f.Patch})
	}
	return out, nil
}

// FileAt implements reanchor.GitHub with the raw contents media type. Files
// over 1 MB are an error, so re-anchoring degrades instead of loading them.
func (c *Client) FileAt(ctx context.Context, token, fullName, path, ref string) (string, bool, error) {
	rp, err := repoPath(fullName)
	if err != nil {
		return "", false, err
	}
	if !comments.ValidPath(path) || !comments.ValidSHA(ref) {
		return "", false, errors.New("github: invalid path or ref")
	}
	segs := strings.Split(path, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	raw, err := c.get(ctx, token, rp+"/contents/"+strings.Join(segs, "/")+"?ref="+ref, "application/vnd.github.raw+json", maxFileBytes)
	if errors.Is(err, comments.ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return string(raw), true, nil
}

// RequestedReviewers implements notify.GitHub: the logins of the users
// whose review is requested on the pull request (teams are not included).
func (c *Client) RequestedReviewers(ctx context.Context, token, fullName string, number int) ([]notify.Account, error) {
	var body struct {
		Requested []account `json:"requested_reviewers"`
	}
	if err := c.getObject(ctx, token, fullName, "/pulls/", number, &body); err != nil {
		return nil, err
	}
	out := make([]notify.Account, 0, len(body.Requested))
	for _, u := range body.Requested {
		out = append(out, notify.Account(u))
	}
	return out, nil
}

type account struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
}

// Issue implements notify.GitHub (GET .../issues/{n}, which also answers
// for pull requests).
func (c *Client) Issue(ctx context.Context, token, fullName string, number int) (notify.Issue, error) {
	var body struct {
		Assignees   []account        `json:"assignees"`
		PullRequest *json.RawMessage `json:"pull_request"`
	}
	if err := c.getObject(ctx, token, fullName, "/issues/", number, &body); err != nil {
		return notify.Issue{}, err
	}
	out := notify.Issue{PullRequest: body.PullRequest != nil}
	for _, u := range body.Assignees {
		out.Assignees = append(out.Assignees, notify.Account(u))
	}
	return out, nil
}

func (c *Client) getObject(ctx context.Context, token, fullName, kind string, number int, dst any) error {
	rp, err := repoPath(fullName)
	if err != nil {
		return err
	}
	if number <= 0 {
		return errors.New("github: invalid number")
	}
	raw, err := c.get(ctx, token, rp+kind+strconv.Itoa(number), "application/vnd.github+json", maxSmallBytes)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return errors.New("github: invalid body")
	}
	return nil
}

// get GETs an API path with the user's token. 401 is
// comments.ErrUnauthenticated and 404 comments.ErrNotFound; error messages
// carry only the status, never the token or the body.
func (c *Client) get(ctx context.Context, token, pathAndQuery, accept string, limit int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.apiBase(), "/")+pathAndQuery, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", accept)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: request: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return nil, comments.ErrUnauthenticated
	case http.StatusNotFound:
		return nil, comments.ErrNotFound
	default:
		return nil, fmt.Errorf("github: status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("github: read: %w", err)
	}
	if int64(len(raw)) > limit {
		return nil, errTooLarge
	}
	return raw, nil
}

package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/FullFran/galley/server/internal/comments"
)

// Bounds on one listing, so a user in a huge organization cannot make a
// single permission check page through GitHub forever. Repositories beyond
// them are treated as not installed.
const (
	perPage          = 100
	maxInstallations = 100
	maxRepositories  = 5000
	maxPages         = 60
	// maxListBytes bounds one page: 100 full repository objects.
	maxListBytes = 4 << 20
)

var _ comments.RepoLister = (*Client)(nil)

// InstalledRepos implements comments.RepoLister. It lists the galley app
// installations the token's user can access (GET /user/installations) and,
// for each, the repositories the user can access in it
// (GET /user/installations/{id}/repositories), with the user's permission on
// each. A repository the user can read on GitHub but where galley is not
// installed (a public repository, for example) is not in the result.
func (c *Client) InstalledRepos(ctx context.Context, token string) (map[int64]comments.RepoPermission, error) {
	type installation struct {
		ID int64 `json:"id"`
	}
	var ids []int64
	err := c.paginate(ctx, token, "/user/installations", func(raw []byte) (int, int, error) {
		var page struct {
			TotalCount    int            `json:"total_count"`
			Installations []installation `json:"installations"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return 0, 0, err
		}
		for _, in := range page.Installations {
			if len(ids) < maxInstallations {
				ids = append(ids, in.ID)
			}
		}
		return len(page.Installations), page.TotalCount, nil
	})
	if err != nil {
		return nil, err
	}

	out := map[int64]comments.RepoPermission{}
	for _, id := range ids {
		path := "/user/installations/" + strconv.FormatInt(id, 10) + "/repositories"
		err := c.paginate(ctx, token, path, func(raw []byte) (int, int, error) {
			var page struct {
				TotalCount   int `json:"total_count"`
				Repositories []struct {
					ID          int64  `json:"id"`
					FullName    string `json:"full_name"`
					Permissions struct {
						Admin    bool `json:"admin"`
						Maintain bool `json:"maintain"`
						Push     bool `json:"push"`
						Triage   bool `json:"triage"`
						Pull     bool `json:"pull"`
					} `json:"permissions"`
				} `json:"repositories"`
			}
			if err := json.Unmarshal(raw, &page); err != nil {
				return 0, 0, err
			}
			for _, r := range page.Repositories {
				if len(out) >= maxRepositories {
					break
				}
				p := r.Permissions
				push := p.Push || p.Maintain || p.Admin
				out[r.ID] = comments.RepoPermission{FullName: r.FullName, Pull: push || p.Pull || p.Triage, Push: push}
			}
			if len(out) >= maxRepositories {
				return 0, 0, nil // stop paging
			}
			return len(page.Repositories), page.TotalCount, nil
		})
		if err != nil {
			return nil, err
		}
		if len(out) >= maxRepositories {
			break
		}
	}
	return out, nil
}

// paginate GETs path page by page. handle returns the items on the page and
// the total count; paging stops at a short or empty page, at the total, or
// at maxPages.
func (c *Client) paginate(ctx context.Context, token, path string, handle func([]byte) (n, total int, err error)) error {
	seen := 0
	for page := 1; page <= maxPages; page++ {
		raw, err := c.getJSON(ctx, token, path+"?"+url.Values{
			"per_page": {strconv.Itoa(perPage)},
			"page":     {strconv.Itoa(page)},
		}.Encode())
		if err != nil {
			return err
		}
		n, total, err := handle(raw)
		if err != nil {
			return errors.New("github: installations endpoint returned an invalid body")
		}
		seen += n
		if n == 0 || seen >= total {
			return nil
		}
	}
	return nil
}

func (c *Client) getJSON(ctx context.Context, token, pathAndQuery string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.apiBase(), "/")+pathAndQuery, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, fmt.Errorf("github: installations request: %w", err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized:
		return nil, comments.ErrUnauthenticated
	default:
		return nil, fmt.Errorf("github: installations endpoint status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxListBytes))
	if err != nil {
		return nil, fmt.Errorf("github: installations read: %w", err)
	}
	return raw, nil
}

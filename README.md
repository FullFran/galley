# galley

galley is a browser editor for files in GitHub repositories. You sign in with
GitHub, open a repository where the galley GitHub App is installed, edit a file,
and save it. Each save becomes a commit on a branch and an open pull request, so
GitHub stays the source of truth and nobody needs to use git directly.

## Layout

- `web/`: the frontend (Vite, TypeScript, Preact). Served from GitHub Pages at
  `galley.fullfran.com`.
- `server/`: the API (Go, PocketBase used as a framework). Served at
  `galley-api.fullfran.com`.

## Run locally

Web (Node 24):

```sh
cd web
npm ci
npm run dev        # dev server
npm test           # unit tests
npm run lint
npm run typecheck
npm run build      # production build in web/dist
```

The production build adds a strict Content-Security-Policy `<meta>` tag. The dev
server does not, because Vite's hot reload needs inline scripts.

The editor (CodeMirror 6) is mounted in a shadow root. CodeMirror injects its
styles at runtime; in a shadow root it uses a constructed stylesheet
(`adoptedStyleSheets`), which `style-src 'self'` allows, while a `<style>`
element in the document would be blocked.

### Run the whole app locally

1. Create a GitHub App (see [Server configuration](#server-configuration)) with
   callback URL `http://127.0.0.1:8090/api/galley/auth/callback`, and install it
   on a test repository.
2. Start the API with the variables below, `GALLEY_FRONTEND_ORIGIN=http://127.0.0.1:5173`
   and `GALLEY_PUBLIC_URL=http://127.0.0.1:8090`:
   `cd server && go run . serve --origins=http://127.0.0.1:5173`
3. Start the frontend: `cd web && npm run dev -- --host 127.0.0.1`, then open
   `http://127.0.0.1:5173` in Chrome or Firefox and choose **Sign in with GitHub**.
   Use `127.0.0.1` for both, not `localhost`: the session cookie is
   `SameSite=Strict`, and `localhost` and `127.0.0.1` are different sites.

The development frontend talks to `http://127.0.0.1:8090` by default. The
production build only connects to the origins in its CSP (`api.github.com` and
`galley-api.fullfran.com`), so build it with
`VITE_API_BASE=https://galley-api.fullfran.com`.

Server (Go 1.27):

```sh
cd server
go test ./...
go run . serve     # http://127.0.0.1:8090/api/galley/health (needs the variables below)
```

PocketBase stores its data in `server/pb_data/`, which is not committed.

### Server configuration

`serve` refuses to start unless every variable below is set. See
[`server/.env.example`](server/.env.example) for placeholders.

| Variable | Meaning |
| --- | --- |
| `GALLEY_GITHUB_CLIENT_ID` | GitHub App client ID. |
| `GALLEY_GITHUB_CLIENT_SECRET` | GitHub App client secret. |
| `GALLEY_TOKEN_KEY` | 32 random bytes, standard base64 (`openssl rand -base64 32`). Encrypts stored refresh tokens (AES-256-GCM). Keep it outside `pb_data`. |
| `GALLEY_WEBHOOK_SECRET` | Webhook secret of the GitHub App. |
| `GALLEY_FRONTEND_ORIGIN` | Exact frontend origin, for example `https://galley.fullfran.com`. |
| `GALLEY_PUBLIC_URL` | Public API base URL, for example `https://galley-api.fullfran.com`. |

Both URLs must use `https`, except loopback hosts (`localhost`, `127.0.0.1`)
for local development. The GitHub App's callback URL is
`$GALLEY_PUBLIC_URL/api/galley/auth/callback`, and its webhook URL is
`$GALLEY_PUBLIC_URL/api/galley/auth/webhook` (subscribe to nothing extra:
`github_app_authorization` is always delivered). User access tokens must
expire (the GitHub App default).

Always start the server with `--origins` set to the frontend origin; without
it PocketBase's own API answers CORS requests from every origin (`*`):

```sh
go run . serve --origins=https://galley.fullfran.com
```

PocketBase's `--origins` CORS middleware never sends
`Access-Control-Allow-Credentials`. The galley auth routes therefore replace it
with their own CORS handling, which allows only `GALLEY_FRONTEND_ORIGIN`, with
credentials and the headers `Content-Type` and `X-Galley-CSRF`.

### Auth endpoints

All under `/api/galley/auth/`:

| Route | Purpose |
| --- | --- |
| `GET login` | Creates a state and PKCE (S256) verifier, keeps them sealed in the `__Host-galley_oauth` cookie (10 minutes, `SameSite=Lax`) and redirects to GitHub. |
| `GET callback` | Checks the state, exchanges the code, stores the encrypted refresh token, sets the `__Host-galley_session` cookie (30 days, `SameSite=Strict`) and redirects to the frontend. On failure it redirects to `/?login=failed`. |
| `POST token` | Refreshes the GitHub token pair and returns `{"access_token", "expires_at"}`. Optional body `{"repository_id": <int>}`. |
| `POST logout` | Deletes the session and expires its cookie. Returns 204. |
| `POST webhook` | GitHub webhook. Verifies `X-Hub-Signature-256`; on `github_app_authorization` / `revoked` deletes the user's token and sessions. Returns 204. |

`token` and `logout` require `Origin` equal to `GALLEY_FRONTEND_ORIGIN`, the
header `X-Galley-CSRF: 1` and the session cookie; otherwise they answer 403
(or 401 without a valid session). The browser calls them with
`credentials: "include"`. Refreshes for one user are serialized because
GitHub rotates the refresh token on each use. If GitHub rejects the refresh
token, it is deleted and the user must sign in again.

Cookies use the `__Host-` prefix, so browsers only accept them from secure
contexts. Chrome and Firefox treat `http://localhost` as secure; Safari does
not.

PocketBase collections `galley_users`, `galley_github_tokens` and
`galley_sessions` are created by a Go migration. Their API rules are empty, so
only superusers can read them through the PocketBase API. A second migration
sets every API rule of PocketBase's built-in `users` collection to superuser
only, because its default create rule allows anyone to sign up.

The PocketBase admin UI (`/_/`) is served by the same process. In production,
Traefik refuses `/_/` and `/api/collections/_superusers` to public clients;
the admin UI is reached over an SSH tunnel (see [docs/deploy.md](docs/deploy.md)).

`POST token` answers 401 only when the session or the stored GitHub token is
no longer usable (sign in again). Transient failures (database, GitHub outage,
timeout) answer 503; the client should retry. A refresh that GitHub has
already rotated is saved even if the browser aborts the request.

## Deployment

See [docs/deploy.md](docs/deploy.md) for the GitHub App, DNS, Pages and VPS
steps. Artifacts: `.github/workflows/pages.yml`, `server/Dockerfile` and
`deploy/compose.yml`.

## Frontend

The UI avoids git terms: a save is "Save" and the pull request is "a proposal
for review", with a link to it on GitHub. Containers in `web/src/containers/`
own state and call the gateway; components in `web/src/ui/` only render props.
Edited files are kept in memory until saved, and the page warns before closing
with unsaved changes. If someone else changed the branch since it was opened,
the save is refused and the user's text stays visible so it can be copied after
reloading. If the session ends, unsaved text is shown on the sign-in screen.
Opened over plain `http:` on a public host, the sign-in screen links to the
https address instead of trying to sign in (the session cookie is `Secure`);
http on `localhost` and `127.0.0.1` keeps working for local development.

## Frontend data layer

`web/src/domain/` defines the `RepoGateway` and `ReviewGateway` ports and their
typed errors (`ConflictError`, `AuthRequiredError`, `TransientError`,
`NotFoundError`, `PermissionError`, `RejectedError` for 422,
`NotMergeableError`, `SuggestionMismatchError`). The app depends only on that port. `web/src/github/`
implements it against `api.github.com` with `fetch`, and `web/src/auth/` is the
session client for the auth endpoints above.

`VITE_API_BASE` sets the galley API base URL at build time (see
[`web/.env.example`](web/.env.example)). It defaults to `http://127.0.0.1:8090`
for local development. The GitHub access token is kept in memory only and
refreshed shortly before it expires; it is never written to browser storage.

Working branch model: each user edits on the branch `galley/<github-login>` in
each repository. Opening a repository uses that branch if it exists, otherwise
the default branch head; the branch is created on the first save. If the
branch exists but has no commits of its own and is behind the default branch
(its pull request was merged), it is fast-forwarded to the default head first. If it diverged, has no
open pull request, and its latest closed pull request was merged at exactly its
current head (a squash or rebase merge), the branch is deleted and recreated
from the default head on the next save.
Saved files keep their existing mode; new files are `100644`. A save is one
commit whose parent is the head the user opened, and the branch is moved
fast-forward only (never forced). If the branch moved in the meantime, the save
fails with a conflict. After a save, the open pull request from the working
branch to the default branch is reused, or a new one is opened. If that step
fails, the save still reports its commit, without a pull request link. Files
that are not valid UTF-8 cannot be opened; a byte order mark is preserved.

## Preview

While editing, the workspace shows a preview of the paper next to the editor
(on narrower screens, "Show preview" and "Show editor" switch between them). It
re-renders about 300 ms after the last keystroke, from the unsaved text of open
files and the repository content of the rest, and keeps its scroll position.
It approximates the elsarticle preprint PDF (A4 sheet, 384 pt text width, CMU
Serif, elsarticle headings, captions and booktabs-like tables); line breaks,
page breaks and float positions do not match the PDF. Notes about what could
not be shown are listed under the preview.

The pipeline lives in `web/src/render/` behind one function,
`render(project) -> { html, assets, diagnostics }`, so it can later be replaced
by Quarto's own renderer. It runs in a module Web Worker (its own chunk, not
loaded with the editor), which asks the main thread for each file. A render
gets 5 s of compute (time waiting for files does not count); past that the
worker is replaced, the last preview stays and a note says the document is too
complex. Includes are capped at 500 and 8 MB of expanded text, figures at 500,
and the HTML at the 8 MB the frame accepts. It supports:

- the entry file from `_quarto.yml` (`project.render`), else `index.qmd`;
  `format.html` options and front matter override the project settings;
- front matter: `title`, `subtitle`, `author` (strings or Quarto's
  name/affiliations schema), `affiliations`, `abstract`, `keywords`;
- `{{< include path >}}`, recursive, relative to the including file, with
  cycle and depth checks; HTML comments are dropped;
- headings with `{#sec-x}`, `{.unnumbered}`/`{-}`, numbered like elsarticle;
  after a raw LaTeX block containing `\appendix`, "Appendix A", "Appendix A.1",
  and figures, tables and equations numbered "A.1";
- figures `![caption](path){#fig-x width=50%}` (the extension may be omitted;
  `default-image-extension`, then png, svg, jpg are tried) and `::: {#fig-x}`
  divs; pipe tables with `: Caption {#tbl-x}`; display math `$$...$$ {#eq-x}`
  with equation numbers; inline math; all through KaTeX;
- cross-references `@fig-x`, `@tbl-x`, `@eq-x` ("Eq. (1)"), `@sec-x`, and the
  number-only form `[-@eq-x]`, with `crossref` prefixes from `_quarto.yml`;
- citations `@key`, `[@a; @b]`, `[see @a, p. 3]`, `[-@key]`, formatted with the
  Elsevier Harvard CSL style, and the reference list in `::: {#refs}` or at the
  end; bibliographies in BibTeX or CSL-JSON;
- callouts (`::: {.callout-note}`), footnotes (`^[...]`, `[^1]`), lists, quotes,
  code blocks.

Not supported, reported as a note and otherwise skipped: other shortcodes,
raw HTML and other raw blocks (raw LaTeX is ignored), running code cells (their
source is shown), PDF/EPS figures (a PNG or SVG next to them is used when
present), remote images, CSL styles other than Elsevier Harvard, cross-reference
types other than sec/fig/tbl/eq, and page layout.

Security: repository content is untrusted. Markdown is parsed with raw HTML
disabled, links are limited to `#`, `http(s):` and `mailto:`, and KaTeX runs
with `trust: false`, `maxSize` and `maxExpand`. The result is shown in
`web/preview.html` inside `<iframe sandbox="allow-scripts">` without
`allow-same-origin`, so the frame has an opaque origin and cannot reach
galley's DOM, storage or token. The page has its own CSP (`default-src 'none'`
plus its own script, styles and fonts, and `img-src blob:`), so it cannot make
network requests. galley and the frame exchange only two validated messages
(`web/src/preview/protocol.ts`): render (HTML and image bytes) and ready. The
frame sanitizes the HTML again with DOMPurify, shows figures (SVG included)
from `blob:` URLs in `<img>`, never as inline markup, and blocks link
navigation other than in-page anchors.

Notes from checking this in Chromium: in the sandboxed frame `'self'` matches
the page URL's origin, so the frame's own script, styles and fonts load. Module
scripts and fonts are CORS requests with `Origin: null`; GitHub Pages answers
with `Access-Control-Allow-Origin: *`. The CSP refuses `style` attributes
parsed from markup, and reports each one, so the renderer emits
`data-galley-css` instead and the frame applies it through the CSSOM. A
`srcdoc` frame would inherit galley's CSP, which is why the preview is a
separate page. Paged.js is not used: it is large and injects `<style>`
elements, which this CSP blocks; the preview is one continuous sheet instead.

Local development: Vite's dev and preview servers keep their localhost-only
CORS, and `vite.config.ts` answers `Origin: null` only for the files the frame
loads (`/preview.html`, `/src/preview/`, Vite's client, pre-bundled
dependencies and KaTeX's files; in `vite preview`, the preview's built assets).
Remaining risk: while the dev server runs, any website can read those files
through a sandboxed frame. They hold no secrets (galley's own public frame code
and published npm packages), but do not keep private code under
`web/src/preview/`.

## Review

**Proposals** (in the top bar of a repository) lists every open pull request of
the repository, not only galley's own, with its review state and whether it can
be merged. Opening one shows:

- the changed files as a line-by-line diff from GitHub's `patch` field; files
  without one (binary or very large changes) say so and link to GitHub;
- "Preview this version", which renders the proposal's head commit in the same
  sandboxed preview (read-only);
- line comments grouped into conversations, with replies. A new comment can
  cover one line or a range ("From line"), can be sent at once ("Comment now")
  or kept for the review ("Add to review"), and "Suggest a change" inserts a
  ```` ```suggestion ```` block with the current lines;
- the review form: comment, approve or ask for changes, with an optional
  overall comment; kept line comments go out in the same review request;
- reviewers with their latest state (waiting, approved, changes requested,
  commented), and assignees. Candidates come from the repository's assignable
  users; GitHub answers 422 for people without access, shown as a plain
  message;
- Merge, only when GitHub reports the proposal mergeable (`clean`, `unstable`
  or `has_hooks`; never `blocked`) and the user has push access, with the merge
  methods the repository allows. galley asks for confirmation and always sends
  the head SHA the user saw, so a proposal that moved fails (409) instead of
  merging unseen commits. Rules and checks are never bypassed.

Applying a suggestion: GitHub has no REST endpoint for it, so galley makes an
ordinary commit on the proposal's head branch (only for branches in the same
repository and users with push access), on top of the head the user saw, and
moves the branch fast-forward only. Exactly the suggested lines are replaced,
after checking that they still read as in the comment's diff; otherwise it
refuses and asks to edit the file instead. The commit carries
`Co-authored-by: <login> <<id>+<login>@users.noreply.github.com>` for the
suggester.

All proposal text (titles, descriptions, comments, file names, diffs) is shown
as plain text, never as HTML, and links point only to `https://github.com/`
URLs from GitHub's API, with `rel="noopener noreferrer"`.

The review screens use the app's existing permissions: Pull requests
(read/write) for proposals, comments, reviews, reviewers and assignees;
Contents (write) for merging and applying suggestions; Metadata for the
repository's permissions and merge settings. CI status needs Checks or Actions
access and is planned separately (C8).

The port is `ReviewGateway` in `web/src/domain/review.ts`, implemented in
`web/src/github/review.ts`; diff parsing, threads, suggestions and reviewer
states are plain functions in `web/src/review/`.

## Licence

MIT. See [LICENSE](LICENSE).

Vendored assets and bundled libraries with other licences:

- `web/src/render/csl/elsevier-harvard.csl` and `locales-en-US.xml`, from the
  [citation-style-language styles](https://github.com/citation-style-language/styles)
  and [locales](https://github.com/citation-style-language/locales)
  repositories (downloaded 2026-10-28), CC BY-SA 3.0, as stated in each file.
- `web/src/preview/fonts/cmu-serif-*.woff2`, Computer Modern Unicode (CMU
  Serif) by Andrey V. Panov and the authors of the original Metafont fonts,
  SIL Open Font License 1.1, see `web/src/preview/fonts/OFL.txt`; WOFF2 files
  taken from the `computer-modern` npm package 0.1.3.
- [citeproc-js](https://github.com/Juris-M/citeproc-js) (npm `citeproc`),
  Copyright (c) 2009-2019 Frank Bennett, used unmodified under the Common
  Public Attribution License 1.0 (dual-licensed CPAL/AGPL), in the preview
  chunk.
- KaTeX and its fonts (MIT, per its package licence), markdown-it and
  markdown-it-footnote (MIT), js-yaml (MIT), DOMPurify (MPL-2.0 or
  Apache-2.0).

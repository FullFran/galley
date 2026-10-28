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
| `GALLEY_TOKEN_KEY` | 32 random bytes, standard base64 (`openssl rand -base64 32`). Encrypts stored refresh tokens (AES-256-GCM); a separate key derived from it with HKDF-SHA256 (purpose `galley-data-at-rest-v1`) encrypts comments. Keep it outside `pb_data` and back it up: changing it signs everyone out and makes every stored comment unreadable. |
| `GALLEY_WEBHOOK_SECRET` | Webhook secret of the GitHub App. |
| `GALLEY_FRONTEND_ORIGIN` | Exact frontend origin, for example `https://galley.fullfran.com`. |
| `GALLEY_PUBLIC_URL` | Public API base URL, for example `https://galley-api.fullfran.com`. |

Both URLs must use `https`, except loopback hosts (`localhost`, `127.0.0.1`)
for local development. The GitHub App's callback URL is
`$GALLEY_PUBLIC_URL/api/galley/auth/callback`, and its webhook URL is
`$GALLEY_PUBLIC_URL/api/galley/auth/webhook` (`github_app_authorization` is
always delivered; membership and repository events are optional and only make
comment permission changes visible before the 5-minute cache expires). User access tokens must
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

### Comments API

Line-anchored comment threads stored in galley (design:
[docs/comments-design.md](docs/comments-design.md)). `repo_id` is GitHub's
numeric repository id; thread and comment ids are 15 characters `[a-z0-9]`.

| Route | Purpose |
| --- | --- |
| `GET /api/galley/repos/{repo_id}/threads?path=&status=&at=` | Threads (with comments) ordered by path and line, at most 200; `truncated` says when there were more. `status` is `open` or `resolved`; `at` is the head commit being viewed (re-anchoring seam, phase 2). |
| `POST /api/galley/repos/{repo_id}/threads` | Starts a thread. Body: `path`, `commit_sha`, `start_line`, `end_line`, optional `start_column`/`end_column`, `quote` (`exact`, `prefix`, `suffix`), `origin` (`source` or `preview`), `body`, optional `suggestion`. Returns 201 and the thread. |
| `GET /api/galley/repos/{repo_id}/unread` | `{"repo_id", "threads", "comments", "by_thread": {id: n}}`: comments by others added after the user's read marker (markers store the thread's comment sequence number, not a timestamp). |
| `GET /api/galley/threads/{id}` | One thread with its comments. |
| `POST /api/galley/threads/{id}/comments` | Reply: `{"body", "suggestion"?}`. Returns 201 and the comment. |
| `POST /api/galley/threads/{id}/resolve`, `.../reopen` | Changes the status; 409 when it already has it. |
| `POST /api/galley/threads/{id}/read` | Marks the thread read now. Returns 204. |
| `PATCH /api/galley/comments/{id}` | Edits your own comment: `{"body", "suggestion"?}` (omit `suggestion` to remove it). |
| `DELETE /api/galley/comments/{id}` | Deletes your own comment, and the thread when it was the last one. Returns 204. |

Every route requires `Origin` equal to `GALLEY_FRONTEND_ORIGIN` and the
session cookie; `POST`, `PATCH` and `DELETE` also require `X-Galley-CSRF: 1`.
CORS allows only the frontend origin, with credentials, for `GET`, `POST`,
`PATCH` and `DELETE`. Responses are `Cache-Control: no-store`.

Only repositories where the galley app is installed can be commented on. The
server lists the repositories of the user's installations, with the user's
permission on each (`GET /user/installations` and
`GET /user/installations/{id}/repositories`, paginated, capped at 5,000
repositories), using the user's own token. That token is minted on the server
from the stored refresh token, never reaches the browser, and is reused until
5 minutes before it expires; tokens the browser obtains from `POST token`
(without `repository_id`) replace it, so the two sides do not keep rotating
the refresh token. The list is cached for 5 minutes per user; cache misses are
limited to 20 at once and one more every 3 seconds per user (429). Reading and
commenting need `pull`; resolving and reopening need `push` (write), whoever
started the thread; comments can only be edited or deleted by their author.
Repositories outside the installations (public ones included) and threads in
them answer 404. A user's entry (list and token) is dropped when their
authorization is revoked; every list is dropped on the webhook events
`installation`, `installation_repositories`, `member`, `membership`,
`organization`, `team` and `repository` (subscribe the GitHub App to the ones
available to it).

Limits: `path` is repository-relative, at most 512 bytes, with no `.`/`..` or
empty segments, no leading slash, backslash or control characters;
no Unicode format characters (category Cf, which includes bidi controls);
`commit_sha` is a full 40- or 64-character lowercase hex id; no text field may
contain NUL or the bidi controls U+202A–U+202E and U+2066–U+2069; lines are 1 to
1,000,000 with `end_line >= start_line`; `body` (non-blank) and `suggestion`
at most 20 KB each; `quote.exact` at most 20 KB and `prefix`/`suffix` 1 KB.
Request bodies are at most 128 KB and must not contain unknown fields. Each
user may make 30 writes at once and one more every 2 seconds (in memory, on
top of PocketBase's per-IP limiter); reads and read markers are not limited.

Errors are generic `{"error": "<status text>"}` bodies: 400 malformed JSON,
401 no valid session (sign in again), 403 wrong origin, missing CSRF header,
not the author or no `push`, 404 unknown or invisible, 409 status conflict,
413 body too large, 422 invalid input (the body also names the `field`), 429
too many writes, 503 GitHub or database unavailable (retry).

Comment bodies, suggestions and the quote fields are sealed with AES-256-GCM
under the derived data key. The associated data binds thread quotes to the
thread id, field, `repo_id` and `path`, and comment bodies and suggestions to
the comment id, field and thread id, so a value copied to another record or
a record moved to another repository, file or thread does not open (the API
then answers a generic 500). They are
stored in the hidden fields of `galley_threads` and `galley_comments`
(`galley_thread_reads` holds read markers); all three collections have
superuser-only API rules, and comment text, quotes and tokens are never
logged.

## Project configuration

A paper repository can hold a `.galley.yml` that chooses which files
co-authors edit in galley, the upload folders, friendly file names, who may
add sections and the preview default. Repository admins set it up from galley. See
[docs/galley-yml.md](docs/galley-yml.md).

## Deployment

See [docs/deploy.md](docs/deploy.md) for the GitHub App, DNS, Pages and VPS
steps. Artifacts: `.github/workflows/pages.yml`, `server/Dockerfile` and
`deploy/compose.yml`.

## Frontend

The UI avoids git terms: a save is "Save for review" and the pull request is
"a proposal for review", with a link to it on GitHub. Containers in `web/src/containers/`
own state and call the gateway; components in `web/src/ui/` only render props.
Edited files are kept in memory until saved, and the page warns before closing
with unsaved changes. If someone else changed the branch since it was opened,
the save is refused and the user's text stays visible so it can be copied after
reloading. If the session ends, unsaved text is shown on the sign-in screen.
Opened over plain `http:` on a public host, the sign-in screen links to the
https address instead of trying to sign in (the session cookie is `Secure`);
http on `localhost` and `127.0.0.1` keeps working for local development.

### UI overview

- **Landing**: what galley does, one "Sign in with GitHub" button, what access
  it needs, a static editor + preview drawing (HTML/CSS) and the author credit.
- **Addresses** (`web/src/shell/route.ts`): every screen has a hash route, so a
  reload, a shared link or the back button lands where you were: `#/`
  (repositories), `#/r/{owner}/{repo}` (main document), `…/f/{path}` (a file),
  `…/proposals[/{n}]` and `…/admin/{tab}`. The fragment never reaches a server
  or a Referer, and GitHub Pages needs no SPA fallback. Parsing is strict
  (decoded segments, no `..`, slashes or control characters, GitHub name
  rules); anything else is the repository list. Leaving the workspace with
  unsaved edits asks first, also on back and forward. Sign in keeps the route
  in `sessionStorage` and returns to it once, validated again.
- **App shell** (`web/src/ui/shell/AppShell.tsx`): skip link, sidebar, sticky
  3.5rem header and a main region that scrolls on its own; the shell is
  `100dvh`, so the header and "Save for review" never scroll away. Notices are
  non-modal toasts; one-line banners sit above the screen.
- **Sidebar**: declared once as data (`web/src/shell/nav.ts`), grouped by task
  like the sidebars of Álvaro's apps. A repository switcher row on top; Write
  (Contents: an Outline | Files switch over one tree, remembered per
  repository; the main file has a muted "main" suffix); Review (collapsible,
  closed by default, opens by itself on a proposals screen; one row
  "Proposals 2 · 1 yours"); and for admins only one Admin entry, last behind a
  separator. Nothing admin-related appears anywhere else. The footer has the
  account button, Help (tour, shortcuts, About) and a muted "galley · by FullFran"
  credit line that opens About. Group state is one JSON map in
  `localStorage` (`galley:nav-groups`, guarded; `web/src/shell/navGroups.ts`);
  in the icon rail and the phone drawer groups never fold. The current entry
  has a 3px accent bar and bold text. 16rem from 1024px, a 3.5rem icon rail
  with tooltips from 768px, an off-canvas drawer below; Ctrl/Cmd+B toggles it
  outside text fields (`sidebar.ts`, `useSidebar.ts`).
- **Account menu** (`AccountMenu.tsx`, `Menu.tsx`): WAI-ARIA menu (arrows,
  Home/End, Escape returns focus): signed in as, Theme System · Light · Dark,
  Language English · Español (each with its own `lang`), Preferences…,
  Keyboard shortcuts, Take the tour, About galley, and Sign out last after a
  separator. The same for every role.
- **Theme** (`web/src/shell/theme.ts`): Light and Dark set `data-theme` on
  `<html>` and are stored as `galley:theme`; System removes both.
  `web/public/theme-init.js`, an external script in `<head>` (CSP
  `script-src 'self'`), applies the stored theme before first paint.
- **Preferences** (native `<dialog>`): auto-compile default for papers where
  you have not chosen yet, editor mode (Paper default | Writing | Code), Vim
  key bindings, theme and language. Sections for unbuilt features stay hidden.
- **Editor** (`web/src/ui/Editor.tsx`, `editorModes.ts`, `editorAssist.ts`,
  logic in `web/src/editor/`): two modes. Writing: soft wrap, the paper font at
  16px with 1.7 line height, lines of about 72 characters centred, no gutter,
  only quiet hints for headings, emphasis, `$math$` and `@citations`. Code: the
  monospace look with line numbers and full highlighting. The header has a
  Writing | Code control (inside ⋯ on phones); the choice is per person in
  `localStorage` (`galley:prefs`), else `.galley.yml` `editor.default_mode`,
  else Writing for co-authors and Code for admins. Vim key bindings
  (`@replit/codemirror-vim` 6.4.0, the maintained CodeMirror 6 Vim; its own
  ~130 kB chunk) load only when turned on. Autocomplete on `@` lists bib keys
  (author, year, title) from every `.bib` and crossref labels (`fig-`, `tbl-`,
  `eq-`, `sec-`, with number and caption) from every `.qmd`; inside
  `{{< include … >}}` and `![](…)` it completes paths from the repository tree.
  Unknown citation keys and dangling crossrefs get inline warnings. Go to
  definition: double-click, Ctrl/Cmd+click or F12 on an include opens the
  file, on a figure path shows the figure in a lightbox, on `@fig-…`/`@sec-…`/
  `@eq-…`/`@tbl-…` opens the file that defines the label at that line, and on
  a citation key opens the `.bib` file at the entry; each move is announced to
  screen readers. The index (BibTeX parser and label scan) is built in a small
  worker (`indexWorker.ts`), refreshed 500 ms after edits stop; autocomplete,
  warnings and go to definition load in their own chunk after the editor.
- **Figures and sections** (`web/src/uploads/`, `web/src/structure/`,
  `web/src/containers/useAuthoring.tsx`, dialogs in `web/src/ui/authoring/`):
  upload folders from `.galley.yml` show "Upload to figures/" in Files and take
  dropped files; dropping an image onto the editor uploads it to the first
  upload folder and inserts `![](figures/name.png){#fig-name}` at the drop
  point. The name, type and `max_size_mb` are checked before the file is read,
  the bytes are checked against the extension after reading, and the file name
  is cleaned (base name only, transliterated, `[A-Za-z0-9_-]`). The dialog
  previews images with an `<img>` from a `blob:` URL (SVG never inline), asks
  Replace or Keep both (`-2`, `-3`) when the name exists, and then offers
  Insert figure with a caption. The Outline offers New section after… and New
  subsection in… on each row (⋯), a + between sections, and New section… at
  the bottom, unless `.galley.yml` says `structure: admin`. A section is a new
  file `# Title {#sec-slug}`, an include at the chosen place in the main file
  and, for admins, a `labels` entry (and an `editable` item when no pattern
  covers it) written into `.galley.yml` keeping its comments. File names follow
  the paper's includes (folder, `_` prefix, numbers; `sections/_slug.qmd` when
  there are none). Numbered files are never renumbered: a new file between
  `02-` and `03-` gets `02a-`, at the end the next number, at the start the one
  before the first. Uploads and new sections are pending changes: they count
  as unsaved, are listed in the save note popover ("In this save"; uploads can
  be removed there) and become part of the next save's single commit, whose
  default message is the plain-language summary ("New section “Methods” after
  “Introduction”"). Friendly names from `labels` show in Files and Outline,
  with the path as tooltip.
- **Header**: breadcrumb whose repository segment opens the switcher and whose
  folder segments show the Files tab; save state with a dot (role=status, full
  wording in the tooltip); a ⋯ menu (Recompile now, Keyboard shortcuts) and a
  split "Save for review" button whose caret opens the optional note. Phones:
  file name, Edit | Preview, ⋯ (with "Add a note…") and "Save".
- **Keyboard shortcuts** (`web/src/shell/shortcuts.ts`, dialog on `?`):
  Ctrl/Cmd+B sidebar, Ctrl/Cmd+Enter recompile, Ctrl/Cmd+S opens Save for
  review (never the browser's save), `?` this list.
- **Workspace**: the main document opens on its own (`.galley.yml` `entry`,
  else `index.qmd`, else the first top-level document). Editor and preview sit
  side by side from 1024px; below that an Edit | Preview switch in the header
  shows one at a time. Above the preview: Recompile, an auto-compile switch,
  and an "Out of date · Ctrl+Enter" badge only while the preview is behind.
  When the paper is not set up (or its settings are broken) a one-line banner
  says galley shows text files only: admins get "Set up…", co-authors "Why?";
  it can be dismissed per repository.
- **Admin area** (`AdminArea.tsx`, tabs in `web/src/shell/adminTabs.ts`):
  Project settings (the setup wizard and settings form) and View as co-author;
  tabs for the future admin panel (people, sessions, allowlist) are declared
  but not shown. Co-authors who open an admin address see one line, never the
  content. While viewing as co-author a slim "Viewing as co-author · Exit"
  banner stays on screen.
- **Proposals**: rows that are one click target with status chips (View on
  GitHub lives on the detail page) and an empty state that explains proposals.
  In a proposal, your review comes first; on your own proposal it says "You
  can't approve your own proposal."; hunk headers read "Lines 5–9", merge
  methods sit under "Merge options"; phones get a sticky "Write your review"
  bar that hides while the review card is on screen.
- **Design rules**: semantic CSS tokens only (`web/src/styles.css`), light and
  dark themes (`prefers-color-scheme`, or `data-theme` on `<html>`), one
  accent spent on state, borders rather than shadows, 6px/10px radii, visible
  2px focus rings, 44px targets, skeletons instead of "Loading…", colour
  transitions only and none with reduced motion. Icons are inline SVG
  components; no inline `style` attributes (CSP `style-src 'self'`). Short
  labels; details go in tooltips.
- **Copy**: every interface string is in a typed catalog (see Languages
  below), read with `useT()` from a Preact context whose default is the
  English catalog (no provider needed in tests).
- **Guided tour anchors**: `data-tour` on sidebar, outline, editor, preview,
  save, proposals, help and compile, for the planned driver.js tour.

### Languages

The interface is in Spanish and English, with no i18n library:

- **Catalogs**: `web/src/i18n/en.ts` (`as const`, grouped by screen) defines
  the `Messages` type; `web/src/i18n/es.ts` implements it, so a missing key
  is a type error. Texts with numbers or names are small functions; plurals
  use `Intl.PluralRules` (`i18n/plural.ts`). A parity test checks that both
  catalogs have the same keys and that function messages take the same
  arguments.
- **Spanish register**: informal "tú", neutral Spanish that reads naturally
  in Spain (no voseo, no regional slang), no exclamation marks, sentence case
  and plain words for academics who do not use git ("Propuestas", "Guardar
  para revisión", "Pedir cambios", "Incorporar" for merge). Product names
  (galley, GitHub, Quarto, BibTeX) stay as they are.
- **Choosing the language**: English · Español in the account menu and in
  Preferences once signed in, and the ES | EN switch in the landing footer.
  The choice is kept in `localStorage`
  (`galley-locale`; if storage is blocked the switch still works for the
  session). Without a stored choice, a browser language starting with `es`
  picks Spanish, anything else English. Switching re-renders without a
  reload and keeps unsaved edits; `<html lang>` follows the choice.
- **Dates**: `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` in the active
  language ("hace 3 horas", "2 days ago"; older than a week shows the date).
- **Still English**: renderer diagnostics in the preview notes, the
  validation messages for `.galley.yml` (admins only), and text galley writes
  to GitHub (the pull request body). Commit messages follow the language of
  the person saving.

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

Staying up to date with the default branch (`web/src/workspace/upstream.ts`):
while the workspace is open galley polls the default branch head every 60 s
while the tab is visible, and again on window focus (one cheap ref lookup; the
compare runs only when a head moved). When the default branch has commits the
working head lacks, a one-line prompt says "main has N new changes · Bring them
in" with a dismiss (it comes back when main moves again); nothing is merged
while you edit. "Bring them in" fast-forwards a branch that is only behind, or
merges the default branch into `galley/<login>` with `POST /repos/{o}/{r}/merges`
(commit message "Merge main into galley/<login>"; needs the Contents: write
permission the app already has): 201 moves the workspace onto the merge
commit, 204 means nothing to do, 409 shows a non-blocking banner ("Your
proposal conflicts with the latest version; ask an admin or resolve on GitHub")
with a link to the compare page. A merge commit whose first parent is not the
head you opened counts as a moved branch. Nothing is ever forced. Open files
without edits take the new text. Edited files get a line-level three-way merge
in the browser (`web/src/workspace/merge3.ts`, `node-diff3` 3.2.1, MIT, about
12 kB, no dependencies) of the text you started from, your text and the new
text: a clean merge becomes your (still unsaved) text with a "Merged main's
latest changes into your text" notice; where both changed the same lines, the
editor is replaced by a plain resolution view (both texts side by side, "Their
version" / "Your version" / "Keep both", never conflict markers) and the file
cannot be saved until every place has a choice. A file typed into while the
new version was loading counts as edited. Every save first brings the default
branch in the same way and commits on top of the result; a merge that landed
stays the new head even if the commit then fails. Before the first save there
is no branch yet: it is created from the current default head. The project
index caches file text by blob SHA, so a new commit re-reads only changed
files, at most six at a time.

Saved files keep their existing mode; new files are `100644`. Uploaded files
are sent as blobs first (`POST /git/blobs` with `encoding: base64`) and join
the text changes in the same tree and commit. A save is one
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

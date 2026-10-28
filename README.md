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

`web/src/domain/` defines the `RepoGateway` port and its typed errors
(`ConflictError`, `AuthRequiredError`, `TransientError`, `NotFoundError`,
`PermissionError`). The app depends only on that port. `web/src/github/`
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

## Licence

MIT. See [LICENSE](LICENSE).

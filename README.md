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

The PocketBase admin UI (`/_/`) is served by the same process. Access to it is
restricted at the reverse proxy (Traefik), which is set up with the deployment
(task T5); until then, do not expose the server publicly.

`POST token` answers 401 only when the session or the stored GitHub token is
no longer usable (sign in again). Transient failures (database, GitHub outage,
timeout) answer 503; the client should retry. A refresh that GitHub has
already rotated is saved even if the browser aborts the request.

## Licence

MIT. See [LICENSE](LICENSE).

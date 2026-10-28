# galley MVP

## Objective

A user logs in with GitHub, opens a repository where the galley GitHub App is
installed, edits one file in the browser, and saves it as a commit on a branch
plus an open/updated pull request.

## Problem and why

Editing the Quarto paper through git and VS Code is heavy for non-developer
co-authors. galley hides git behind "save = PR" while GitHub stays the source of
truth. First real user: the paper repo `Tesis-Francisco-Olmedo/paper-tld100-glow-curve`.

## Scope

In: GitHub App login, repo picker, file tree, CodeMirror 6 editor, save as
commit + PR with SHA-based optimistic concurrency, deploy (Pages + VPS).

Out (later): preview, autocomplete, autosave drafts on the server, scroll sync,
CI status in-app.

## Constraints and decisions

- Frontend: Vite + TypeScript + Preact on GitHub Pages at `galley.fullfran.com`.
- Backend: Go using PocketBase as a framework, on the VPS behind Traefik at
  `galley-api.fullfran.com`.
- Auth: GitHub App user-to-server tokens. OAuth `state` + PKCE (S256). Code
  exchange and refresh run server-side. Refresh tokens are AES-GCM encrypted in Go
  (key outside `pb_data`). Session cookie `__Host-` (Secure, HttpOnly, Path=/,
  SameSite, no Domain). State-changing API calls check the exact `Origin` and
  require a custom header. PocketBase `--origins` explicit, admin UI restricted.
- The GitHub access token lives only in browser memory; the browser calls
  `api.github.com` directly. All GitHub calls sit behind a `RepoGateway` port so
  a backend-proxy adapter can replace it later.
- Tokens are scoped with `repository_id` when possible; minimal app permissions
  (contents + pull requests, selected repositories).
- Save never force-updates a ref: commit with parent = last-seen head SHA, update
  the ref fast-forward only; on rejection, report the conflict.
- Code, comments and docs in English. Conventional commits, no AI attribution.
- Licence: MIT.

## Delivery

- Forecast: ~2000 authored changed lines across 5 tasks (above the ~400 budget).
- Strategy: `ask-on-risk` (default); chain strategy: `stacked-to-main` (Fran,
  2026-10-28).
- Slices: one branch and PR per task, each based on the previous one and merged
  to `main` in order. `main` root commit holds only LICENSE (bootstrap, empty
  repo). T1 → `feat/mvp-skeleton`.

## Tasks

- [ ] T1 Skeleton: monorepo `web/` (Vite + TS + Preact, Vitest, ESLint) and
  `server/` (Go module, PocketBase app boot, health route, `go test`), root
  README, `.gitignore`, CI workflow (lint + test both), Dependabot, LICENSE.
  Route: delegated direct (writer trigger: 2+ non-trivial files).
  Checks: `npm ci --ignore-scripts && npm run lint && npm test && npm run build`
  in `web/`; `go vet ./... && go test ./...` in `server/`.
- [ ] T2 Server auth: `/auth/login` (state + PKCE), `/auth/callback` (exchange,
  encrypt refresh token, `__Host-` cookie), `/auth/token` (refresh with per-user
  mutex, Origin + header check, optional `repository_id`), `/auth/logout`,
  `github_app_authorization` revocation webhook. Tests first against a fake
  GitHub token endpoint. Open question: does `repository_id` survive refresh.
- [ ] T3 `RepoGateway` port + GitHub adapter: list accessible repos, read tree and
  file, save (blobs, tree, commit, fast-forward ref update on a `galley/*` branch,
  open or update PR). Tests against a fake gateway/HTTP.
- [ ] T4 UI: login, repo picker, file tree, CodeMirror 6 editor, save button with
  PR link and conflict message.
- [ ] T5 Deploy: Pages workflow with CNAME, Traefik/compose for the API, docs for
  the manual steps (create GitHub App, Cloudflare DNS records, verify
  `fullfran.com` in Pages, branch protection on the paper repo).

## Progress and evidence

- 2026-10-28: decisions agreed; feature document created. RDD is off (global).
- 2026-10-28 T1 implemented (delegated writer), not yet committed. Checks
  observed: web `npm ci --ignore-scripts`, lint, typecheck, test (1 passed),
  build: pass; server `go vet`, `go test` (RED observed first: 404 want 200),
  `go build`: pass; parent spot check `go test ./...`: ok.
  Deviations: Go 1.27 (PocketBase v0.40.x requires it); CSP meta injected only
  in production build (Vite dev client is inline); TypeScript 6.0.3
  (typescript-eslint peer range < 6.1.0); no `@preact/preset-vite`.

## Next step

Choose chain strategy, then commit T1 and start T2.

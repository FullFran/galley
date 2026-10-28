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

- [x] T1 Skeleton: monorepo `web/` (Vite + TS + Preact, Vitest, ESLint) and
  `server/` (Go module, PocketBase app boot, health route, `go test`), root
  README, `.gitignore`, CI workflow (lint + test both), Dependabot, LICENSE.
  Route: delegated direct (writer trigger: 2+ non-trivial files).
  Checks: `npm ci --ignore-scripts && npm run lint && npm test && npm run build`
  in `web/`; `go vet ./... && go test ./...` in `server/`.
- [x] T2 Server auth: `/auth/login` (state + PKCE), `/auth/callback` (exchange,
  encrypt refresh token, `__Host-` cookie), `/auth/token` (refresh with per-user
  mutex, Origin + header check, optional `repository_id`), `/auth/logout`,
  `github_app_authorization` revocation webhook. Tests first against a fake
  GitHub token endpoint. Open question: does `repository_id` survive refresh.
- [x] T3 `RepoGateway` port + GitHub adapter: list accessible repos, read tree and
  file, save (blobs, tree, commit, fast-forward ref update on a `galley/*` branch,
  open or update PR). Tests against a fake gateway/HTTP.
- [x] T4 UI: login, repo picker, file tree, CodeMirror 6 editor, save button with
  PR link and conflict message.
- [x] T5 Deploy: Pages workflow with CNAME, Traefik/compose for the API, docs for
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

- T1 committed: `e0ffe4f` on `feat/mvp-skeleton` (main root `2feab84`).
- 2026-10-28 T2 implemented on `feat/mvp-auth` (delegated writer). Assessed
  risk: high (RDD off), so an independent read-only verifier reviewed it: no
  blockers; two should-fix items corrected in one scoped pass (refresh+save
  detached from the request context with retry; built-in PocketBase `users`
  collection API rules locked to nil, anonymous sign-up was open), plus 503 for
  transient errors. Checks: `gofmt -l` clean; `go vet`, `go test -race
  -count=1 ./...` (6 packages ok), `go build`: pass; RED observed for each fix;
  parent spot check fresh `go test -race -count=1`: ok.
  Open: whether `repository_id` survives refresh (not in GitHub refresh docs;
  sent as a hint; needs a live app). `/_/` restriction deferred to T5 (Traefik).

- T2 committed: `f55e543` on `feat/mvp-auth`.
- 2026-10-28 T3 implemented on `feat/mvp-gateway` (delegated writer). Handled
  as high risk (token handling, writes to user repos; RDD off). One pre-review
  correction (fast-forward stale working branch, keep file modes, track
  `.env.example`), then an independent read-only verifier: no blockers, four
  should-fix items corrected in one scoped pass: a landed save no longer fails
  when the PR step fails; strict UTF-8 decode (`NotTextError`) with BOM kept;
  token cache generation counter so logout/invalidate cannot be undone by an
  in-flight fetch; squash-merged working branch (paper repo allows squash and
  `delete_branch_on_merge` is false) is deleted and recreated from the default
  head. Checks: `npm run lint`, `typecheck`, `test` (33 passed), `build`: pass;
  RED observed; parent spot check lint + test: pass.
  Known nits left: token cache holds one token (switching repo-scoped and
  unscoped tokens triggers a server refresh each time); file modes read from a
  possibly truncated recursive tree; PATCH-422 fallback in catch-up untested.

- T3 committed: `2570a1f` on `feat/mvp-gateway`.
- 2026-10-28 T4 implemented on `feat/mvp-ui` (delegated writer). Assessed as
  medium (UI over the reviewed gateway); writer self-verification plus a
  headless Chromium run of the production build. CSP finding: style-mod injects
  a `<style>` element in documents (blocked by `style-src 'self'`), so the
  editor mounts in a shadow root where it uses adoptedStyleSheets; zero CSP
  violations after the fix. `markdownLanguage` instead of `markdown()` (bundle
  557 kB → 398 kB, 133 kB gzip). Checks: `npm ci --ignore-scripts` (0 vulns),
  lint, typecheck, test (57 passed), build: pass; RED observed; parent spot
  check typecheck + test: pass; phone-width screenshot reviewed.
  Cosmetic follow-up: markdown headings render underlined in the editor.

- T4 committed: `c016f1b` on `feat/mvp-ui`.
- 2026-10-28 T5 implemented on `feat/mvp-deploy` (delegated writer, files only,
  no remote access): Pages workflow, distroless non-root Dockerfile, Traefik
  compose (admin paths behind an IP allowlist, loopback port for SSH tunnel,
  hardened container), `docs/deploy.md` runbook. Checks: `docker build` ok;
  container starts, health returns ok under read-only/cap-drop; `docker compose
  config` ok with scratch env; both workflows parse. Not run: actionlint (not
  installed; Docker run blocked). `PB_ENCRYPTION_KEY` must be exactly 32
  characters (`openssl rand -base64 24`).
  Unverified, marked in the runbook: Traefik network/certresolver names,
  whether sd-api is Cloudflare-proxied, PocketBase trusted proxy header,
  `repository_id` scoping after refresh.

## Next step

Push the stacked branches and open the PRs (Fran's decision), then follow
`docs/deploy.md` for the manual steps and the live first-run checklist.

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

`serve` refuses to start unless every variable below is set (the two mail
variables are optional). See
[`server/.env.example`](server/.env.example) for placeholders.

| Variable | Meaning |
| --- | --- |
| `GALLEY_GITHUB_CLIENT_ID` | GitHub App client ID. |
| `GALLEY_GITHUB_CLIENT_SECRET` | GitHub App client secret. |
| `GALLEY_TOKEN_KEY` | 32 random bytes, standard base64 (`openssl rand -base64 32`). Encrypts stored refresh tokens (AES-256-GCM); a separate key derived from it with HKDF-SHA256 (purpose `galley-data-at-rest-v1`) encrypts comments. Keep it outside `pb_data` and back it up: changing it signs everyone out and makes every stored comment unreadable. |
| `GALLEY_WEBHOOK_SECRET` | Webhook secret of the GitHub App. |
| `GALLEY_FRONTEND_ORIGIN` | Exact frontend origin, for example `https://galley.fullfran.com`. |
| `GALLEY_PUBLIC_URL` | Public API base URL, for example `https://galley-api.fullfran.com`. |
| `GALLEY_RESEND_API_KEY` | Optional. Resend API key for email notifications. Without it (or without `GALLEY_MAIL_FROM`) notifications are disabled and `GET /api/galley/me/notifications` reports `"available": false`. |
| `GALLEY_MAIL_FROM` | Optional. Sender address, for example `galley <notify@notify.fullfran.com>` (a verified Resend sending domain). |

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
| `GET /api/galley/repos/{repo_id}/threads?path=&status=&at=` | Threads (with comments) ordered by path and line, at most 200; `truncated` says when there were more. `status` is `open` or `resolved`; `at` is the full SHA of the commit being viewed: each thread's `position` is then re-anchored to it (see below). |
| `POST /api/galley/repos/{repo_id}/threads` | Starts a thread. Body: `path`, `commit_sha`, `start_line`, `end_line`, optional `start_column`/`end_column`, `quote` (`exact`, `prefix`, `suffix`), `origin` (`source` or `preview`), `body`, optional `suggestion`. Returns 201 and the thread. |
| `GET /api/galley/repos/{repo_id}/unread` | `{"repo_id", "threads", "comments", "by_thread": {id: n}}`: comments by others added after the user's read marker (markers store the thread's comment sequence number, not a timestamp). |
| `GET /api/galley/threads/{id}?at=` | One thread with its comments, re-anchored to `at` when given. |
| `POST /api/galley/threads/{id}/comments` | Reply: `{"body", "suggestion"?}`. Returns 201 and the comment. |
| `POST /api/galley/threads/{id}/resolve`, `.../reopen` | Changes the status; 409 when it already has it. |
| `POST /api/galley/threads/{id}/read` | Marks the thread read now. Returns 204. |
| `PATCH /api/galley/comments/{id}` | Edits your own comment: `{"body", "suggestion"?}` (omit `suggestion` to remove it). |
| `DELETE /api/galley/comments/{id}` | Deletes your own comment, and the thread when it was the last one. Returns 204. |

Every route requires `Origin` equal to `GALLEY_FRONTEND_ORIGIN` and the
session cookie; `POST`, `PUT`, `PATCH` and `DELETE` also require
`X-Galley-CSRF: 1`. CORS allows only the frontend origin, with credentials,
for `GET`, `POST`, `PUT`, `PATCH` and `DELETE` (request headers
`Content-Type`, `X-Galley-CSRF`, `If-Match` and `Last-Event-ID`; `ETag` is
exposed). Responses are `Cache-Control: no-store`. The drafts and chat
routes below share this middleware.

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

Re-anchoring: `anchor` is always the original anchor, never changed;
`position` is where the thread sits at `at` (`path`, `commit_sha`, lines,
columns and `state`): `exact` (same place), `moved` (shifted through the
diff, or the exact quote found elsewhere), `fuzzy` (the quote was edited and
the closest match within 50 lines is shown) or `orphaned` (the file was
removed or the quote is gone; the original range is returned). The server
shifts the range through the file's hunks from
`GET /repos/{o}/{r}/compare/{anchor_sha}...{at}` (renames followed through
`previous_filename`); only when a hunk touches the range does it fetch the
file at `at` and search for the quote (prefix and suffix break ties), then a
bounded fuzzy match. When GitHub truncates the comparison (300 files) or omits
the file's patch, it fetches both versions (at most 1 MB each) and diffs them
itself. A file listed under its own path wins over a file renamed from that
path. Calls use the viewer's server-side token, are cached per
(repository, base, head) and per file version (at most 64 MB each),
deduplicated, limited to 30 at once and one more every 2 seconds per user,
and failures are remembered for 30 seconds. Positions are cached in memory
per (thread, at), at most 20,000. Fuzzy matching is limited to quotes of 8 to
1,000 characters, and one listing shares a budget of 50 million comparison
cells; `GET /threads/{id}?at=` has no shared budget. If GitHub fails, a limit
is reached or the budget is spent, the stored position is returned unchanged
and not cached: its `commit_sha` is then not `at`, which tells the client the
thread was not mapped yet (fetch the single thread to map it).

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

### Drafts API

Server-side drafts: one working copy per user, repository and path, so an
edit started on one device can continue on another. Drafts are private to
their owner: nobody else can read, list or delete them (repository admins
neither, unless the owner shares one: see the admin API; another user's draft
answers 404). Access also needs `pull` on a
repository where the galley app is installed (the same check as comments).
`{path...}` is the repository-relative file path, with the comment path rules.

| Route | Purpose |
| --- | --- |
| `GET /api/galley/repos/{repo_id}/drafts` | Your drafts in the repository, newest first, metadata only: `{"drafts": [{"path", "base_sha", "base_ref", "device", "size", "updated_at", "etag"}]}`. |
| `GET /api/galley/repos/{repo_id}/drafts/{path...}` | One draft with its `content`; the `ETag` header carries its version. |
| `PUT /api/galley/repos/{repo_id}/drafts/{path...}` | Creates or replaces the draft. Body: `base_sha` (the blob or commit the edit started from), optional `base_ref`, `device` (a short label) and `expected_updated_at`, and `content`. Returns 201 (created) or 200 (replaced) with the metadata and `ETag`. |
| `DELETE /api/galley/repos/{repo_id}/drafts/{path...}` | Deletes one draft. Returns 204, or 404 when there is none. |
| `DELETE /api/galley/repos/{repo_id}/drafts` | Deletes all your drafts in the repository (call it after a successful save). Returns `{"deleted": n}`. |

Optimistic concurrency: a `PUT` without a precondition only creates. To
replace a draft, send the version you last saw, as `If-Match: "<etag>"` or as
`expected_updated_at` (the `updated_at` you received; both must agree when
both are sent). If the draft changed meanwhile (another device saved) or no
longer exists, the answer is 409 with `{"error": "Conflict", "current":
{...metadata} | null}` and nothing is written, so a stale device cannot
overwrite a newer draft. `updated_at` has millisecond precision and strictly
increases per draft. The ETag is `"<updated_at in Unix ms>-<nonce>"`, with a
random nonce renewed on every write, so a draft deleted and recreated within
the same millisecond still gets a new ETag; prefer `If-Match`, because
`expected_updated_at` alone compares only the time.

Limits: `content` at most 2 MB (UTF-8, no NUL; bidi controls are allowed in a
draft because it is a copy of a repository file shown only to its owner);
request bodies at most 12 MB + 64 KB, the worst case of JSON escaping (a
control character becomes `\u00XX`), 413 beyond; `device` at most 64 bytes on
one line; `base_ref` a branch or tag name of at most 255 bytes; per user, 200
drafts per repository (422 with `"field": "drafts"`) and, across all
repositories, 1,000 drafts (`"field": "owner_drafts"`) and 50 MB of content
(`"field": "owner_storage"`), all checked in the write transaction; 60 writes
(`PUT` and `DELETE`) at once and one more per second per user (429).

Retention: an hourly PocketBase cron job (`galley_drafts_retention`) deletes
drafts not updated for 30 days. All of a user's drafts are deleted on a real
revocation: the `github_app_authorization` revoked webhook, or GitHub
answering `bad_refresh_token`. A refresh token that merely expired or no
longer opens (for example after a key change) invalidates the user's access
but keeps their drafts until the 30-day retention. On a real revocation the
user is also marked revoked in memory for 2 minutes; the mark is checked
inside the write transaction, so a `PUT` in flight either lands before the
purge or is refused (401), and a second purge runs 30 seconds later.
Content is sealed with AES-256-GCM
under the data key; the associated data binds it to the record id, field,
owner, `repo_id` and `path`
(`galley/v1/draft/<id>/content/<owner>/<repo_id>/<path>`), so ciphertext
copied or moved anywhere else does not open (generic 500). The
`galley_drafts` collection has superuser-only API rules and a hidden
`content` field; draft content is never logged.

### Chat API

One chat per paper (repository), with persistent history, unread counts and a
live stream. Everything needs `pull` on an installed repository.

| Route | Purpose |
| --- | --- |
| `GET /api/galley/repos/{repo_id}/chat?before_seq=&limit=` | History, oldest first: `{"messages": [{"id", "repo_id", "seq", "author": {"kind", "login"}, "mine", "body", "created_at"}], "has_more"}`. Without `before_seq`, the newest page; pass the first `seq` you hold to page back. `limit` defaults to 50, at most 200. |
| `POST /api/galley/repos/{repo_id}/chat` | Posts `{"body"}` (non-blank, at most 4 KB, no NUL or bidi controls). Returns 201 and the message. 20 posts at once and one more per second per user. |
| `POST /api/galley/repos/{repo_id}/chat/read` | `{"seq"?}` moves your read marker to `seq`, or to the newest message when omitted. Markers never move back. Returns `{"last_read_seq"}`. |
| `GET /api/galley/repos/{repo_id}/chat/unread` | `{"repo_id", "unread", "last_read_seq", "latest_seq"}`: messages by others after your marker. |
| `GET /api/galley/repos/{repo_id}/chat/stream` | Server-Sent Events of new messages (below). |

Messages are numbered per repository (`seq` 1, 2, 3..., unique, assigned in
one transaction). Bodies are sealed under the data key with associated data
`galley/v1/chat/<id>/body/<repo_id>/<author user id>` in the hidden `body`
field of `galley_chat_messages`, so a body copied to another message or
reattributed to another author does not open. The author id is stored as
text, not a relation, so deleting a user keeps the history readable. Read
markers live in `galley_chat_reads`. Both collections have superuser-only API
rules.

The stream is served from Go, not by PocketBase realtime: galley users are
not PocketBase auth records, so record rules cannot express repository
access. Open it with `new EventSource(url, { withCredentials: true })`; it
needs the session cookie and the exact `Origin` like every other route. Each
new message is one event, flushed on its own:

```text
id: 42
event: message
data: {"id":"...","seq":42,"author":{"kind":"human","login":"alice"},...}
```

A `: ping` comment follows every 25 seconds; each heartbeat also re-checks the
session and the repository access, and the stream ends (with `event: close`)
when either is gone. A revocation ends the user's streams at once. Load the
history first, then open the stream with `?last_event_id=<newest seq you
hold>` (EventSource cannot set the header on its first request), so messages
posted between the two calls are replayed rather than lost. On reconnect,
EventSource sends `Last-Event-ID` itself, and the server replays up to 200
missed messages; when more were missed it sends
`event: resync` and the client should reload the history. A client that stops
reading is dropped and reconnects the same way. Each user may hold 5 streams
(1,000 per server; 429 beyond). Live delivery is in process, so it assumes
one server instance.

Proxies: the stream sets `Content-Type: text/event-stream`,
`Cache-Control: no-store` and `X-Accel-Buffering: no`, and flushes every
event. Traefik does not buffer responses by default, so it needs no extra
configuration; do not put a buffering or compression middleware in front of
`/api/galley/repos/*/chat/stream`. The heartbeat keeps idle streams under the
usual 60-second proxy timeouts, and the stream lifts PocketBase's 5-minute
server write and read timeouts (per-write deadline, read deadline cleared).

### Admin API

Repository admins (GitHub's `admin` permission on the repository, read with
the same cached check as comments) can see who uses galley on the repository,
end a user's galley sessions, restrict galley to an allowlist, and read drafts
their owners chose to share. Every route is scoped to one repository the caller
administers, behind the same middleware as the other repository routes (exact
`Origin`, `X-Galley-CSRF: 1` on writes, session cookie, `no-store`). Without
access to the repository the answer is 404; with access but without admin, 403.
Listings use the cached permission (up to 5 minutes old); changes (revoking
sessions, allowlist edits) and reading a shared draft re-ask GitHub first,
bypassing the cache (still rate limited), so an admin demoted on GitHub loses
those powers at once.

An admin never acts as another user on GitHub: galley holds no way to hand an
admin someone else's token, and these routes only change galley's own data
(sessions, allowlist, share grants). Every admin call that passes the check is
audited: allowlist and share changes write their audit row in the same
transaction as the change (and only when the change happens); views and
session revocation write it before acting or returning data, and fail (503)
when it cannot be written.

| Route | Purpose |
| --- | --- |
| `GET /api/galley/repos/{repo_id}/admin/people` | Users who used galley on this repository: `{"people": [{"user_id", "login", "github_id", "permission", "first_seen", "last_seen", "blocked", "drafts": {"count", "bytes", "oldest_updated_at", "newest_updated_at"}}]}`, most recent first (at most 1,000). `permission` (`read`, `write`, `admin`) is as last seen. Draft figures are metadata only; content is never returned. |
| `POST /api/galley/repos/{repo_id}/admin/people/{user_id}/revoke-sessions` | Deletes every galley session of the user and ends their chat streams (sessions are global, not per repository). Only for users who used galley on this repository in the last 180 days (404 otherwise). Revoking your own sessions needs `{"confirm_self": true}` (422 `confirm_self` without it). GitHub authorization and tokens are untouched; the user can sign in again. Returns 204. |
| `GET /api/galley/repos/{repo_id}/admin/allowlist` | `{"entries": [{"id", "github_id", "login", "created_at"}]}`. |
| `POST /api/galley/repos/{repo_id}/admin/allowlist` | Adds `{"github_id"}`, `{"login"}` or both (409 for a duplicate, at most 1,000 entries). When `github_id` is set it decides the match and the login is a label; prefer it, since logins can be renamed and reclaimed. Returns 201. |
| `DELETE /api/galley/repos/{repo_id}/admin/allowlist/{id}` | Removes an entry. Returns 204. |
| `GET /api/galley/repos/{repo_id}/admin/shared-drafts` | Active share grants: `{"shared_drafts": [{"id", "repo_id", "path", "owner": {"user_id", "login"}, "created_at", "expires_at", "size", "updated_at"}]}`. |
| `GET /api/galley/repos/{repo_id}/admin/shared-drafts/{id}` | A shared draft with its `content` (`read_only: true`). |
| `GET /api/galley/repos/{repo_id}/admin/audit` | The last 200 audit entries, newest first: `{"entries": [{"id", "actor": {"user_id", "login"}, "action", "target", "at"}]}`. This view is itself recorded. |

**Allowlist.** It restricts galley features, not GitHub access: when a
repository's allowlist is not empty, users who are not on it get 403 on that
repository's comments, drafts and chat (and cannot share drafts), while
GitHub, and galley on other repositories, work as before. Repository admins
are never blocked, so an admin cannot lock themselves out. The people listing
marks blocked users. Changes apply at once on this server; the allowlist is
otherwise cached for 30 seconds.

**Activity.** Every repository-scoped call (comments, drafts, chat, admin)
by a user with `pull` records `first_seen`, `last_seen` and the permission in
`galley_repo_activity`, written at most once every 5 minutes per user and
repository (or at once when the permission changes).

**Draft sharing.** Sharing is the owner's choice and read-only:

| Route | Purpose |
| --- | --- |
| `POST /api/galley/repos/{repo_id}/draft-shares/{path...}` | Shares your draft at `path` with the repository's admins for 24 hours. Sharing again renews the grant. Needs the same access as drafts. Returns 201 and `{"id", "repo_id", "path", "owner", "created_at", "expires_at"}`. |
| `DELETE /api/galley/repos/{repo_id}/draft-shares/{path...}` | Revokes your active grants on that draft at once (no repository access needed, so consent can always be withdrawn). Returns 204, or 404 when none was active. |
| `GET /api/galley/repos/{repo_id}/draft-shares` | Your active grants on the repository: `{"shares": [...]}`. |

(Sharing has its own prefix because a `{path...}` wildcard cannot be followed
by `/share`.) While a grant is active, admins read the draft's **current**
version, including edits made after sharing; they never see it after the
grant expires or is revoked. A grant covers one draft record: when the draft
is deleted (after a save, by retention or by revocation) the grant goes with
it, and a new draft at the same path is not covered. Creating, renewing and
revoking a grant are audited too.

Storage: `galley_repo_activity`, `galley_repo_allowlist`,
`galley_draft_shares` and `galley_audit`, all with superuser-only API rules.
None holds content or free text (ids, logins, paths, actions and times), so
nothing in them is sealed; the audit `target` is `repo`, `user:<id>`,
`allow:<id>` or `share:<id>`.

### Notifications API

Email only for direct asks (a review was requested from you, you were
assigned), never digests or activity. Sent with Resend when
`GALLEY_RESEND_API_KEY` and `GALLEY_MAIL_FROM` are set; otherwise the feature
reports `disabled`.

| Route | Purpose |
| --- | --- |
| `GET /api/galley/me/notifications` | `{"available", "email", "verified", "enabled", "kinds"}`. |
| `PUT /api/galley/me/notifications` | `{"email", "enabled", "kinds"?}` (`kinds` among `review_requested`, `assigned`, `invited`; omitted means all). A new address is stored unverified and gets a verification mail that does not name the requester ("someone using galley"); saving an unverified address again resends it. Verification mails are limited per user (3 at once, one more every 10 minutes), per address whoever asks (3, one more every 8 hours) and for the whole server (60, one more per minute). An empty `email` with `enabled: false` deletes the preferences. 409 `{"reason": "disabled"}` without mail configuration. |
| `GET`, `POST /api/galley/me/notifications/verify?token=` | The link of the verification mail (valid 24 hours, bound to the user and the address). `GET` only shows a confirm button, so mail scanners cannot confirm an address someone else entered; `POST` verifies. |
| `POST /api/galley/repos/{repo_id}/notify/review-requested` | `{"pr_number", "reviewer_login"}`. 202 `{"status": "accepted" \| "disabled"}`. |
| `POST /api/galley/repos/{repo_id}/notify/assigned` | `{"pr_number" or "issue_number", "assignee_login"}`. 202 as above. |
| `GET`, `POST /api/galley/unsubscribe?token=` | The `List-Unsubscribe` link: `GET` shows a confirmation button (link scanners must not unsubscribe), `POST` (the button, or RFC 8058 one-click with `List-Unsubscribe=One-Click`) turns notifications off. |

The `me` and `notify` routes use the comments middleware (Origin, session,
CSRF header). The triggers are checked on GitHub with the caller's own
server-side token: the caller needs `push` on the repository (and to pass the
allowlist), and the login must be among the pull request's
`requested_reviewers` (`GET /repos/{o}/{r}/pulls/{n}`) or the issue's or pull
request's `assignees` (`GET /repos/{o}/{r}/issues/{n}`; `pr_number` for an
issue is 404), so the web app calls them right after it requested the review
or added the assignee. 403 without push, 409 when the login is not requested
or assigned, 429 over 20 triggers at once and one more every 30 seconds per
caller. The login is resolved to the GitHub account id GitHub returns for
that reviewer or assignee, and the recipient is the galley user with that
`github_id` (never matched by login, which can be renamed and reused). They
must have signed in to galley and opted in with a verified address for that
kind; otherwise nothing is sent and
the answer is still `accepted`, so callers cannot probe who opted in.

One mail per event: an idempotency key per (kind, repository, number,
recipient, UTC day) is reserved before sending (hashed, in
`galley_notify_outbox`, purged after 48 hours) and released if Resend fails
(503), and it is also sent to Resend as `Idempotency-Key`. Each recipient gets
at most 10 mails at once and one more every 6 minutes; over that, mails are
dropped. Mails hold no paper text: who asked what, where (`owner/repo #n`),
a link to the galley route (`#/r/{owner}/{repo}/proposals/{n}`, or the
workspace for an issue) and a signed unsubscribe link, with
`List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
headers. Link tokens are HMAC-SHA256 with a key derived from
`GALLEY_TOKEN_KEY` by HKDF (purpose `galley-notify-links-v1`), carry a purpose,
the user id, a hash of the address and an expiry (unsubscribe: one year
from the start of the UTC day, so every mail of a day carries the same link), and
stop working when the address changes. Addresses are sealed with the data key
(AAD `galley/v1/notify/<user>/email`) in the hidden field of
`galley_notify_prefs`, and logs only ever show them masked (`a***@e***.com`).

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
repository's permissions and merge settings. CI status and the compiled PDF
use Checks (read) and Actions (read); see below.

The port is `ReviewGateway` in `web/src/domain/review.ts`, implemented in
`web/src/github/review.ts`; diff parsing, threads, suggestions and reviewer
states are plain functions in `web/src/review/`.

Conversations can be resolved and reopened ("Resolve conversation"). GitHub
offers this only in GraphQL: galley reads `pullRequest.reviewThreads` (node
id, `isResolved`, `viewerCanResolve`, `viewerCanUnresolve`, and the REST id of
the first comment to match the thread) and calls `resolveReviewThread` /
`unresolveReviewThread` with `{ threadId }` at `https://api.github.com/graphql`
(same origin and host check as REST, same user token). The GraphQL reference
lists no permission for these mutations, so the buttons follow GitHub's own
`viewerCanResolve` / `viewerCanUnresolve`; the app needs Pull requests read
(query) and write (mutations). Resolved conversations are folded.

### CI status and the compiled PDF

Each proposal shows a chip from the check runs of its head commit
(`GET /repos/{o}/{r}/commits/{sha}/check-runs`, Checks: read): "Compiling…"
while any run is queued or in progress, "Failed" when a run failed, timed out
or was cancelled, "Compiled" otherwise; nothing when the commit has no checks
or the app lacks the permission. The chip links to the run on GitHub. A
running chip is asked again every 20 s, only while the page is visible.

"Download PDF of this proposal" (proposal ⋯ menu) and "Download latest PDF"
(⋯ menu of every repository screen, default branch) need Actions: read:

1. `GET /repos/{o}/{r}/actions/runs?head_sha={sha}` (proposal: successful runs
   first, then other completed ones, since the paper's workflow uploads the
   PDF before its checks fail the job), or `?branch={default}&status=success`
   (only `push` and `workflow_dispatch` runs).
2. `GET /repos/{o}/{r}/actions/runs/{id}/artifacts`: the first live artifact,
   preferring a name with "pdf" (`paper-pdf-docx` in the paper repository,
   kept 14 days). Up to five runs are tried.
3. `GET /repos/{o}/{r}/actions/artifacts/{id}/zip`: GitHub answers 302/303 to a
   short-lived signed URL on Azure blob storage
   (`productionresultssaNN.blob.core.windows.net`). This is the only request
   the GitHub client lets leave `api.github.com`: any other path is refused
   before sending, and a redirect anywhere but `*.blob.core.windows.net` is
   refused before reading. The request sends only `Authorization` and
   `Accept`; the browser drops `Authorization` on the cross-origin hop, so the
   blob host sees a plain GET with `Origin: null` and no preflight. Checked
   against a real artifact (2026-10-28): the 303 carries
   `Access-Control-Allow-Origin: *` and exposes `Location`; the blob answers
   `Access-Control-Allow-Origin: *` (GET) and allows any preflight. The app CSP
   adds `https://*.blob.core.windows.net` to `connect-src` (CSP wildcards only
   cover a whole leftmost label, so the shard number cannot be narrowed).
   410 means the artifact expired: galley says so and links the run.
4. The zip is unpacked in the browser with `fflate` (lazy chunk, 2.7 kB gzip).
   The paper PDF (not the `-diff.pdf`), the DOCX and the changes PDF are
   offered as blob downloads in a notice; "Open PDF" opens the blob in a new
   tab. A `.pdf` entry that does not start with `%PDF` is dropped.

The port is `CiGateway` in `web/src/github/ci.ts`; status mapping, run and
artifact choice and unzipping are plain functions in `web/src/ci/`.

## Comments in the editor and the preview

Comments anywhere (not only on changed lines), stored by the galley backend
(see "Comments API"):

- **From the editor**: select text (or put the cursor on a line) and use the
  floating "Comment" button or Ctrl/Cmd+Alt+M. The anchor is the file, the
  workspace's head commit, the line range (columns when the selection is not
  whole lines; 1-based, end inclusive, counted in UTF-16 units like the
  editor) and a quote: the exact text plus up to 32 characters of context on
  each side. Lines with open threads get a gutter dot in Code mode and a
  subtle highlight in Writing mode; clicking opens the thread.
- **From the preview**: the renderer tags block elements with
  `data-src="path:line"` and `data-src-end="line"` (through includes and
  front matter). The sandboxed frame reports a selection with a validated
  `galley-preview:selection` message (exact keys, text at most 4,000
  characters, safe repository paths); galley finds the text in those source
  lines (tolerating Markdown marks and line breaks) and opens the composer,
  falling back to the whole block when it cannot match it.
- **Click-to-jump**: double-click in the preview moves the editor to the
  block's source line; "Show in preview" (on a selection, or Ctrl/Cmd+Alt+P)
  scrolls the preview to the line's block and flashes it.
- **Comments panel** (the speech-bubble button in the header, or Review →
  Comments in the sidebar, with the unread count): threads of the open file
  or the whole paper, resolved ones on request, with quote, author, time,
  replies, edit and delete of your own comments, and Resolve/Reopen only for
  people with push access. Opening a thread marks it read. A thread may carry
  a suggestion (replacement text for its range), shown as a diff; "Apply to my
  copy" puts it into your editor as an ordinary, undoable edit (never a
  commit) and resolves the thread only if you have push access.

All comment text, quotes, logins and paths are shown as plain text. The port
is `CommentsGateway` (`web/src/domain/comments.ts`), implemented over HTTP in
`web/src/comments/http.ts` (cookie credentials, `X-Galley-CSRF: 1` on writes,
typed errors for 401/403/404/409/413/422/429/5xx). The anchor at creation uses
the editor's current text, so with unsaved edits above the selection the lines
can differ from the head commit until the server re-anchors (phase 2).

## Drafts in the editor

Unsaved edits survive a closed tab, a crash or a change of device (see
"Drafts API"):

- **In this browser**: about one second after typing stops, every edited file
  is kept in IndexedDB (`galley-drafts`, per user, repository and path, with
  the commit its text started from). IndexedDB errors are swallowed; in a
  private window drafts last for the visit only. The header then reads
  "Draft saved · 2 unsaved files".
- **On reopening** the repository, the drafts come back into the editor with a
  short "Restored your unsaved changes from <time>" notice and an Undo that
  discards them. When the file changed in the repository since the draft's
  text started, the draft is merged with the current text by the same
  three-way merge as "Bring them in" (base = the file at the draft's commit,
  read by SHA); same-line changes open the usual conflict choice view. A draft
  never silently replaces repository changes, and a buffer already edited in
  the tab is never overwritten.
- **On the server** (Preferences → Editor → "Keep drafts on the server", on by
  default): about five seconds after the local write, only when the text
  changed, the draft is sent with `If-Match` of the version last seen (a first
  copy is a create). A 409 means another device wrote a newer draft: galley
  shows "A newer draft of <file> from <device> (<time>) exists · Use it / Keep
  mine" and pauses the server copy of that file until you choose; "Keep mine"
  replaces it against the version shown. Opening a repository on another
  device offers that device's missing server drafts (file, device and age) to
  restore. The device is a coarse label such as "Firefox on Linux". Turning
  the preference off keeps drafts in this browser only and deletes this
  repository's server copies.
- **After "Save for review"**, the saved files' drafts are deleted, locally and
  on the server (per path); files edited again during the save keep theirs.

Code: `web/src/drafts/` (`store.ts` port with IndexedDB and in-memory
adapters, `http.ts` gateway, `sync.ts` debounce and conflict handling,
`restore.ts`) and `web/src/containers/useDrafts.tsx`. Local drafts stay in the
browser until saved or discarded, also after signing out.

## Chat

Review → Chat in the sidebar (with the unread count) opens the paper's chat in
the right-hand panel; only one of comments and chat is open at a time. It
shows the history oldest first ("Show earlier messages" pages back with
`before_seq`), each message as plain text with its author and time, your own
ones subtly framed. Enter sends, Shift+Enter starts a new line; the composer
refuses blank text, more than 4 KB of UTF-8 and NUL or bidi controls before
asking the server. An open panel in a visible tab marks messages read.

Live messages arrive over `EventSource` (`withCredentials: true`) at
`/api/galley/repos/{repo_id}/chat/stream?last_event_id=<newest seq held>`,
opened after the history loads. Any error or `event: close` closes the
connection and reopens it after an exponential backoff (1 s doubling to 60 s,
reset after a good connection) from the newest message held; `event: resync`
reloads the history. A tab hidden for two minutes closes the stream and
reopens it when shown again; leaving the repository or signing out closes it.
The API origin is already in the CSP `connect-src`, which covers EventSource.
The panel's code and styles load on first open (`web/src/ui/chat/`); the
gateway, stream and unread badge are in `web/src/chat/` and
`web/src/containers/Chat.tsx`.

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

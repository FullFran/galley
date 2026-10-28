# Comments anywhere: design (proposed)

Status: proposed on 2026-10-28. See `odd/tasks/galley-roadmap.md` item 2.

## Implementation status

Backend phase 1 and the resolve/reopen part of phase 2 are built (server
only; the API is documented in the README, "Comments API"):

- `server/internal/comments`: domain, use cases and ports (`RepoAccess`,
  `Store`, `Sealer`, `Clock`, `Reanchorer`), input validation, a per-user
  write token bucket and `CachedAccess`: per user, the repositories of the
  user's app installations (5-minute cache, misses limited to 20 at once and
  one every 3 s, idle users evicted first) and the user's own unscoped access
  token (minted by `auth.Service.UserAccessToken`, reused until 5 minutes
  before expiry, replaced by tokens the browser obtains through
  `auth.Config.OnTokenIssued`), so permission checks rotate the refresh token
  at most once per token lifetime. Revocation drops the user's entry;
  installation, membership and repository webhooks drop every list.
- `server/internal/pbstore`: migration for `galley_threads`,
  `galley_comments` and `galley_thread_reads` (nil API rules, hidden sealed
  fields, cascade from thread to comments and read markers; author relations
  do not cascade) and `CommentStore`.
- `server/internal/github`: installed-repositories adapter
  (`GET /user/installations`, `GET /user/installations/{id}/repositories`,
  paginated, capped at 5,000 repositories).
- `server/internal/httpapi`: routes under `/api/galley/repos`,
  `/api/galley/threads` and `/api/galley/comments` (paths differ from the
  sketch below: they share the `/api/galley/` prefix of the auth routes).

Decisions taken while building:

- Key: comments are sealed with a key derived from `GALLEY_TOKEN_KEY` by
  HKDF-SHA256 (purpose `galley-data-at-rest-v1`), not with the token key
  itself and not with a new variable. Derivation keeps refresh tokens and
  comments cryptographically separate without a deployment change; the cost
  is that rotating `GALLEY_TOKEN_KEY` also makes comments unreadable, so a
  rotation needs a re-seal migration (or a dedicated `GALLEY_DATA_KEY` later).
- AAD binds thread quotes to thread id, field, `repo_id` and `path`
  (`galley/v2/thread/<id>/<field>/<repo_id>/<path>`) and comment bodies and
  suggestions to comment id, field and thread id
  (`galley/v2/comment/<id>/<field>/<thread>`), so a value copied to another
  record, or a record moved to another repository, file or thread, no longer
  opens; ids are generated before sealing. Changing a thread's repository or
  path therefore requires re-sealing its quotes.
- Access requires the repository to be in one of the user's galley app
  installations, not only `pull` (Fran's requirement): a public repository
  without the app answers 404.
- Unread counts use a per-thread comment sequence number (`seq`, with the
  thread's `comment_seq` stored in the read marker), not timestamps.
- Paths reject Unicode format characters (Cf); every text field rejects NUL
  and the bidi controls U+202A–U+202E and U+2066–U+2069.
- Re-anchoring is built (phase 2, `server/internal/reanchor`, see below):
  lazy on `at`, never stored; the stored anchor and position are not
  changed.
- Repositories the user cannot see and threads in them answer 404, not 403.
- Deleting the last comment deletes the thread.
- Not built yet: suggestions accept/apply, PR export, preview selection UI,
  Bearer tokens for CLI/MCP, AI authors (`author_kind`, `ai_client` and
  `ai_model` are stored but always `human` for now).

## Decision: store comments in the galley backend

GitHub cannot anchor a comment to an arbitrary line of a file:

- Commit comments anchor to diff positions only; the file-line `line`
  parameter is being closed down
  (https://docs.github.com/en/rest/commits/comments).
- PR review comments anchor to lines in the PR diff only
  (https://docs.github.com/en/rest/pulls/comments).
- Issues and discussions have no line anchor; permalinks pin one SHA.
- Git notes are not line-anchored and GitHub stopped displaying them.
- Comment files in the repo would work but cost a commit per comment, ref
  conflicts, permanent visible history and no per-user unread state.

So comments live in PocketBase, sealed with the existing AES-GCM key. GitHub
stays the source of truth for the paper and is an optional export target (a
thread whose range lies in an open PR diff can be posted as a review comment).

## Data model

- `galley_threads`: `repo_id`, `repo_full_name`, anchor at creation (`path`,
  `commit_sha`, line and optional column range), sealed W3C TextQuoteSelector
  (`quote_exact`, `quote_prefix`, `quote_suffix`), current position
  (`anchor_sha`, range, `anchor_state` = exact | moved | fuzzy | orphaned),
  `origin` (source | preview), `status` (open | resolved), export ids.
- `galley_comments`: `thread`, `author_kind` (human | ai), `author_user` (the
  accountable human), `ai_client`, `ai_model` (reported), sealed body, optional
  sealed suggestion with its `base_sha`.
- `galley_thread_reads`, `galley_notify_prefs` (sealed address, verified,
  enabled, kinds), `galley_notify_outbox` (idempotency key hashes),
  `galley_api_tokens` (hash, scopes, repo allowlist, expiry).

All collections have nil API rules; access goes through Go routes.

## Re-anchoring (lazy, cached per thread and head)

1. Shift the range through the hunks of `compare/{anchor_sha}...{head}`.
2. If a hunk overlaps, look for the exact quote near the predicted line, using
   prefix and suffix to break ties.
3. Else bounded fuzzy match (Bitap, about ±50 lines) scored with context.
4. Else mark the thread orphaned and list it with its original quote. Never
   delete or silently move it.

Implementation (`server/internal/reanchor`, `reanchor.Service` implements
`comments.Reanchorer`, which now receives the viewer's user id):

- Runs when `GET .../threads` or `GET /threads/{id}` carry `at`; `at` empty or
  equal to `anchor_sha` returns the stored position. `position.path` is new
  (it differs from `anchor.path` after a rename).
- Hunks: the file's `patch` from the comparison (found by `filename` first,
  else by `previous_filename` when `status` is `renamed`; `removed` orphans). The
  range is clean when no line in it was deleted and nothing was inserted
  between its lines; then it is shifted (`exact` if unchanged, else `moved`)
  without fetching the file.
- Otherwise the file at `at` is fetched (raw media type, at most 1 MB). The
  exact quote is searched in the whole file, scored by how much of the prefix
  and suffix agree, then by distance to the predicted line. The fuzzy step is
  Sellers' approximate substring matching (edit distance, the dynamic
  programming relative of Bitap without its 64-rune limit) over ±50 lines,
  accepting a distance of at most a quarter of the quote, for quotes of 8 to
  1,000 runes and at most 16,000 runes of text. A listing shares a budget of
  50 million cells (`comments.WithWorkBudget`); a thread over budget gets the
  stored, unmapped position, uncached, and `GET /threads/{id}?at=` (no
  budget) maps it. Columns are recomputed in
  UTF-16 units, as the editor stores them.
- Truncation: a comparison with 300 files or a body over 16 MB is treated as
  truncated; a file missing from it, or listed without a patch, is diffed in
  Go from both versions (common prefix and suffix trimmed, LCS on the rest up
  to about 4 million cells, otherwise one hunk, which falls back to search).
- GitHub calls use the viewer's server-side token
  (`CachedAccess.Token`), are cached per (repository, base, head) and per
  (repository, ref, path) in LRUs bounded by count (512 comparisons, 64
  files) and by bytes (64 MB each; larger entries are not cached). The whole
  comparison is kept rather than one file of it, so the threads of a listing
  in different files share one compare call,
  deduplicated while in flight, limited per user (30, one more every 2 s),
  and failures are remembered for 30 s. Positions are cached per
  (thread, anchor_sha, at), at most 20,000. Shared caches are safe because
  the comments service checks the viewer's access to the repository first.
- Degradation: GitHub errors, the rate limit or a missing token return the
  stored position (its `commit_sha` is then not `at`) and are not cached, so
  the listing never fails because of re-anchoring.

## Authorization

Read and comment need `pull` on the repository; resolve and reopen need `push`
(write access), whoever wrote the thread (Fran, 2026-10-28), and the
repository must be one where the galley app is installed. Checked server-side
with the user's own token (the repositories of `GET /user/installations`, each
with its `permissions`), cached about 5 minutes per user, dropped on
revocation or installation webhooks. No installation token and no extra
private key on the server.

## API (shared by the web UI, a CLI/skill and an MCP server)

```
GET    /api/repos/{repo_id}/threads?path=&status=&at={sha}
POST   /api/repos/{repo_id}/threads
GET    /api/threads/{id}
POST   /api/threads/{id}/comments
PATCH  /api/comments/{id}      DELETE /api/comments/{id}
POST   /api/threads/{id}/resolve   POST /api/threads/{id}/reopen
POST   /api/threads/{id}/export    {pr_number}
POST   /api/threads/{id}/read
GET    /api/repos/{repo_id}/document?path=&ref=
GET/PUT /api/me/notifications   POST /api/unsubscribe/{token}
```

Web: session cookie + exact Origin + `X-Galley-CSRF`. CLI/MCP: Bearer galley
tokens. One `comments` application service with ports for repository access,
GitHub content and sealing; the MCP tools are thin adapters over it.

## AI agents (MCP)

- Remote MCP over Streamable HTTP (spec revision 2026-07-28), plus a local
  stdio CLI wrapper for the lighter skill path.
- OAuth 2.1 with PKCE, Protected Resource Metadata (RFC 9728), resource
  indicators (RFC 8707), audience validation; galley issues its own tokens and
  never passes a GitHub token to the client.
- Consent per repo and scope; revocable grants; per-token write limits and
  daily caps; bulk dismiss per grant; audit log.
- Attribution: "AI (client, reported model) via <human>", visually distinct.
- Prompt injection: paper text and comments are untrusted data for the agent;
  comments are inert (no AI comment triggers commits, merges, emails to
  non-participants or tool calls); suggestions apply only when a human accepts.

## Email notifications (Resend)

No digests (Fran, 2026-10-28: "we don't want to bother anyone"). Email only
for things that need the person to act: a review was requested from them or
they were assigned to a proposal, they were invited to a paper, and similar
direct asks. Nothing for ordinary activity (new comments, replies, merges).
One email per event, deduplicated with an idempotency key; a sending subdomain
such as `notify.fullfran.com`; one-click `List-Unsubscribe` headers; emails
carry no paper text, only who asked what, where, and a link.

Implementation (`server/internal/notify`, API in the README, "Notifications
API"):

- Optional: `GALLEY_RESEND_API_KEY` and `GALLEY_MAIL_FROM`; without them the
  service reports `disabled` and sends nothing.
- Opt-in per user with a verified address (`PUT /api/galley/me/notifications`
  stores it unverified and mails a signed link that does not name the
  requester). The link's `GET` only shows a confirm button and `POST`
  verifies, so mail scanners cannot confirm an address someone else entered.
  Verification mails are limited per user, per address hash (about 3 a day)
  and globally. Addresses are sealed with the data key; logs mask them.
- Triggers are galley-originated, no GitHub webhooks:
  `POST /api/galley/repos/{repo_id}/notify/review-requested` and
  `.../notify/assigned`. The server checks with the caller's own token that
  the caller has push and that the login is a requested reviewer or an
  assignee on GitHub. The GitHub account id from that answer (not the login)
  maps to the galley user with that `github_id`; others,
  and users without a verified, enabled address for the kind, get nothing,
  with the same `accepted` answer. Invitation notices are reserved
  (`invited`) for later.
- Idempotency key per (kind, repository, number, recipient, UTC day),
  reserved in `galley_notify_outbox` before sending and released when Resend
  fails; per-caller and per-recipient rate limits.
- Links (verification 24 h, unsubscribe one year from the UTC day, so a
  day's mails carry identical links) are HMAC-SHA256 tokens with
  a key derived from `GALLEY_TOKEN_KEY` by HKDF (`galley-notify-links-v1`),
  bound to purpose, user and a hash of the address. Unsubscribe `GET` only
  shows a button; `POST` (button or RFC 8058 one-click) turns mail off.
  Verification works the same way.
- Tokens travel in link URLs, so they may appear in PocketBase request logs;
  they only allow verifying or unsubscribing that one address.

## Chat per paper

`galley_chat_messages` sealed; galley users are not PocketBase auth records, so
realtime is broadcast from Go (`SubscriptionsBroker`) or a small SSE endpoint
that checks the session and repo access; unread counts from a `last_read`
marker.

Implementation status (backend built; the API is in the README, "Chat API"):

- `server/internal/chat`: domain, use cases and an in-process broker. It
  reuses the comments shared kernel: `CachedAccess` (installed repositories,
  `pull`), the per-user rate limiter (20 posts, one more per second) and the
  text rules (no NUL, no bidi controls; bodies at most 4 KB).
- Messages carry a per-repository `seq` assigned in the append transaction
  (unique index on `repo_id, seq`); posts are serialized in process so
  streams see increasing `seq`. Read markers (`galley_chat_reads`) store
  `last_read_seq`, never move back and are clamped to the newest message.
- Bodies are sealed with the data key, AAD
  `galley/v1/chat/<id>/body/<repo_id>/<author>` (author stored as text).
- Realtime is the small SSE endpoint, not PocketBase realtime:
  `GET /api/galley/repos/{repo_id}/chat/stream`, behind the same Origin and
  session middleware as the other routes. Heartbeats every 25 s re-check the
  session and the repository access (fail closed); revocation (`OnRevoke`)
  and server shutdown close streams at once; `Last-Event-ID` replays up to
  200 missed messages, otherwise `event: resync`; a subscriber whose 64-message
  buffer fills is dropped and reconnects; 5 streams per user, 1,000 per
  server. Delivery is in memory, so it assumes one server instance.
- Not built yet: the chat UI, mentions, edits, deletes and attachments.

Drafts (comfort roadmap C4) are built alongside in `server/internal/drafts`
(README, "Drafts API"): owner-only sealed drafts with optimistic
concurrency, purged after a save, after 30 days idle (hourly cron) and on
real revocation (webhook or `bad_refresh_token`; not on expired or
unreadable tokens).

## Phases

1. Comment MVP (editor anchoring at head, threads, replies, auth, sealing).
2. Resolve/reopen, re-anchoring, preview selection, suggestions, PR export.
3. AI: galley tokens, CLI/skill, remote MCP with OAuth (high risk).
4. Email for direct asks (built; no digests, see above).
5. Chat.

## Main risks

Re-anchoring errors on heavy rewrites; stale permissions; refresh-token
contention for server-side checks; owning an OAuth authorization server;
prompt injection and AI spam; leaks of unpublished text through email or
export; lock-in (offer a JSON export).

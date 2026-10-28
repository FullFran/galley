# Comments anywhere: design (proposed)

Status: proposed on 2026-10-28, not built. See `odd/tasks/galley-roadmap.md`
item 2.

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
- `galley_thread_reads`, `galley_notify_prefs`, `galley_notify_outbox`,
  `galley_api_tokens` (hash, scopes, repo allowlist, expiry).

All collections have nil API rules; access goes through Go routes.

## Re-anchoring (lazy, cached per thread and head)

1. Shift the range through the hunks of `compare/{anchor_sha}...{head}`.
2. If a hunk overlaps, look for the exact quote near the predicted line, using
   prefix and suffix to break ties.
3. Else bounded fuzzy match (Bitap, about ±50 lines) scored with context.
4. Else mark the thread orphaned and list it with its original quote. Never
   delete or silently move it.

## Authorization

Read and comment need `pull` on the repository; resolve and reopen need `push`
(write access), whoever wrote the thread (Fran, 2026-10-28). Checked server-side with the user's own token
(`GET /repos/{o}/{r}` → `permissions`), cached about 5 minutes per user and
repo, dropped on revocation or installation webhooks. No installation token and
no extra private key on the server.

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

## Chat per paper

`galley_chat_messages` sealed; galley users are not PocketBase auth records, so
realtime is broadcast from Go (`SubscriptionsBroker`) or a small SSE endpoint
that checks the session and repo access; unread counts from a `last_read`
marker.

## Phases

1. Comment MVP (editor anchoring at head, threads, replies, auth, sealing).
2. Resolve/reopen, re-anchoring, preview selection, suggestions, PR export.
3. AI: galley tokens, CLI/skill, remote MCP with OAuth (high risk).
4. Email digests.
5. Chat.

## Main risks

Re-anchoring errors on heavy rewrites; stale permissions; refresh-token
contention for server-side checks; owning an OAuth authorization server;
prompt injection and AI spam; leaks of unpublished text through email or
export; lock-in (offer a JSON export).

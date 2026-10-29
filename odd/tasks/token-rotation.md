# Stop token refresh storms from signing users out
One GitHub user token per user, reused until near expiry, so clients and the server stop rotating each other's tokens away.
Branch: fix/token-rotation. Delivery: work-unit commits; PR/merge/deploy are the user's decision. Runners: `go test ./...` in server/, `npm test` in web/.

## Specs
- S1. "quito el token restringido por repo y dejo un único token por usuario" → user: "hazlo!". `/auth/token` returns one token per user (no repository scoping); `repository_id` in the body is still accepted and ignored, so older clients keep working.
- S2. The server reuses the user's current access token until about 5 minutes before it expires, for every client and for its own server-side calls; it refreshes only then, or when the client reports that exact token as rejected (`{"rejected": "<token>"}`).
- S3. The browser keeps one token and one in-flight request; a GitHub 401 marks only that token as rejected, so parallel 401s share one refresh and never discard a newer token.
- S4. GitHub answering `bad_refresh_token` signs the user out but no longer deletes their server drafts (drafts go only on a webhook revocation); every revocation is logged with its reason.
- S5. Existing behavior kept: sign-in, logout, webhook revocation (drafts purged), expired/unreadable refresh tokens.

## Tasks
- [ ] T1 (S1, S2, S4, S5) server: token reuse in auth.Service, `rejected` request field, revocation logging, drafts only on webhook. Route: inline. Risk: items 1, 2.
- [ ] T2 (S1, S3) web: single token, shared in-flight request, token-specific invalidate. Route: inline. Risk: item 2.
- [ ] T3 independent verifier over the whole feature (high-risk items 1, 2).

## Log
- L1 (2026-10-29) user: "pues testealo!" then a real-session E2E signed both the user's Firefox and a headless client out.
- L2 (2026-10-29) evidence: PocketBase _logs show one headless client made 46 POST /auth/token in ~3 s, serialized on the per-user mutex, then all 401 with no error logged. Every /auth/token rotates the GitHub pair (GitHub: "Once you use a refresh token, that refresh token and the old user access token will no longer work."). Client: per-repository token keys, invalidate() clears the shared in-flight request, one retry then sign-out. Inferred end: bad_refresh_token → refresh token and server drafts deleted.
- L3 (2026-10-29) user decision on scoped tokens: "hazlo!" (drop per-repo scoping, one token per user).
- L4 (2026-10-29) Engram mirror pending: mem_save blocked by hook ("host session already ended").

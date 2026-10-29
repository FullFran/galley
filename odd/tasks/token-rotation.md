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
- [x] T1 (S1, S2, S4, S5) server: token reuse in auth.Service, `rejected` request field, revocation logging, drafts only on webhook; permission-cache minter passes the rejected token. Route: inline. Risk: items 1, 2. Commit 7c1dfbb.
- [x] T2 (S1, S3) web: single token, shared in-flight request, token-specific invalidate. Route: inline. Risk: item 2. Commit: see L6.
- [x] T3 independent verifier over the whole feature (high-risk items 1, 2): no blockers, S1-S5 PASS. Advisory 1 fixed (sign-in clears the cached token).

## Log
- L1 (2026-10-29) user: "pues testealo!" then a real-session E2E signed both the user's Firefox and a headless client out.
- L2 (2026-10-29) evidence: PocketBase _logs show one headless client made 46 POST /auth/token in ~3 s, serialized on the per-user mutex, then all 401 with no error logged. Every /auth/token rotates the GitHub pair (GitHub: "Once you use a refresh token, that refresh token and the old user access token will no longer work."). Client: per-repository token keys, invalidate() clears the shared in-flight request, one retry then sign-out. Inferred end: bad_refresh_token → refresh token and server drafts deleted.
- L3 (2026-10-29) user decision on scoped tokens: "hazlo!" (drop per-repo scoping, one token per user).
- L4 (2026-10-29) Engram mirror pending: mem_save blocked by hook ("host session already ended").
- L5 (2026-10-29) T1 evidence: auth tests rewritten first (RED: compile), then GREEN; new tests for reuse until near expiry, refresh only for the current rejected token, revocation dropping the cached token, bad_refresh_token not Revoked(); comments access test asserts the retry passes the rejected token. `go test -race ./...`, vet, gofmt clean.
- L6 (2026-10-29) T2 evidence: new session tests RED (the parallel-401 test reproduced the storm), then GREEN: 5 parallel GitHub calls hitting 401 share one refresh with body {rejected: "t1"}; a late report about an old token keeps the new one. Scoped-token assertions in 6 gateway tests now expect no repository argument. Web: 1045/1045, tsc and eslint clean. RequestOptions.repositoryId kept (35 call sites) but documented as unused.
- L7 (2026-10-29) T3 verifier: S1-S5 PASS, no blockers. Fresh `go test -race -count=1 ./...` clean; web 1045/1045; differential /auth/token status codes identical to b4336f7 except `{"rejected":5}` 200→400 (out of domain). Probes: refreshed token also rejected ends in AuthRequiredError after 2 token requests (no loop); logout during in-flight fetch does not refill; 40 concurrent callers with the same rejected token cause one rotation.
- L8 (2026-10-29) Fixed advisory 1 (RED then GREEN, TestSignInStartsFromTheNewAuthorization): a new sign-in kept serving the previous authorization's token. Open advisories, not fixed: server-side notify/reanchor never report a rejected token (fail until near expiry); browser clock >4 min ahead makes every call fetch (no rotation); no rate limit on forced refreshes (own tokens only); reuse margin duplicated in auth.tokenReuseMargin and comments.DefaultTokenMargin (must stay equal).

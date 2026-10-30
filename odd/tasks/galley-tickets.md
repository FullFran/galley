Objective: reuse Mazmorra Sombría's ticket system (report form, triage inbox, mail notice) in galley.
Branch: feat/tickets. Delivery: ask-on-risk. Test runners: `go test ./...` in server, `npm test` in web.

## Specs

- S1: User request, verbatim: "hemos hecho un sistema de tickets en mazmorra sombria no?! reutilizalo para galley!!!!!"
- S2: A signed-in user can send a ticket from the Help menu and gets a `GL-XXXXXX` reference. Assumption: signed-out reports stay out, because they would need a public route on an unverified proxy IP.
- S3: Ticket text and diagnostics are sealed at rest with the data key. Assumption: reports can quote unpublished papers, as comments can.
- S4: Technical context is an allowlist the user sees and can switch off: version, device summary, locale, viewport and pixel ratio, screen kind, recent errors. Never repository or file names, so of galley's own errors only the kind is kept. Switching it off sends none of it.
- S5: Sending is limited per user and per UTC day; past the cap the server refuses. A draft survives a failed send and a reload.
- S6: Only accounts in `galley_ticket_admins`, which only superusers edit, can list and triage tickets. Repository admins do not qualify. The server enforces it on every call.
- S7: Admins see an inbox with a status filter, search, full detail, status changes, a link to a GitHub issue and a copy-as-issue-Markdown action.
- S8: A new ticket mails `GALLEY_TICKETS_MAIL_TO` with its reference, category and reporter login, never its text; at most 20 per UTC day; failure never fails the ticket.
- S9: The help text and the docs describe the routes, the variables and how to name an admin.

## Tasks

- [x] T1 S2 S3 S5 S6 S8 inline: server service, store, migration, routes, mail, wiring. go test ./... green.
- [x] T2 S2 S4 S5 S6 S7 inline: web form, inbox, Help menu entries, i18n, diagnostics. vitest 1126 passed, eslint and tsc clean, browser flow on the production build (en 1440, es 480, non-admin).
- [x] T3 S9 inline: README, compose, pages build id.

## Log

- L1 (2026-10-30): hemos hecho un sistema de tickets en mazmorra sombria no?! reutilizalo para galley!!!!!
- L2: Source is `release/0.9.3` in the mazmorra-sombria clone. Dropped from it: honeypot and IP hash (sessions identify the sender), expected/observed fields (a simpler form for galley's readers), PB auth guard (galley sessions are not PB auth). No GitHub issue is opened automatically.
- L3: Verifier found three blockers, fixed in one batch: the switch left version and device on and the preview hid them; the scrub let file names through, so only engine errors keep a message; one ticket that did not open took the inbox down and PATCH saved before failing, so a ticket now answers `unreadable`. Pixel ratio added to S4 on purpose: it shows the zoom that hurt readers. Left as known limits: the daily cap is soft under parallel sends, and the inbox fetches only the newest 200.
- L4: Verifier recheck at e72bf96: B1, B2, B3 fixed. Advisory left: a TypeError, RangeError or ReferenceError that quotes a file name keeps it, since scrub is only a best effort for those. Not deployed; push, PR and deploy are the owner's call.

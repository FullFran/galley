# galley roadmap (decided backlog)

Decisions taken with Fran on 2026-10-28, after the Overleaf gap research. Items
move into a feature document (`odd/tasks/<feature>.md`) when work starts.

## Philosophy (non-negotiable)

galley exists to work on papers the way disciplined programmers work: branches,
proposals and review. No real-time co-editing of the same file.

## Decided, to build

1. **Sync with main before working.** Before a user edits, their working branch
   `galley/<login>` must include the latest default branch (create it from the
   current head, or bring main into it when it is behind), so proposals never
   start from a stale base. Never force; surface conflicts.
2. **Comments anywhere** (not only on changed lines), also from the preview,
   anchored to commit + file + line range and carried forward as the text
   changes; threads with replies, resolve/reopen, suggestions. Designed as an
   extensible comment API so AI agents (Claude, ChatGPT and others, via an MCP
   server or a skill) can read the paper and post comments and suggestions with
   a clear "AI" author kind and the same permissions model. Storage: galley
   backend (PocketBase) is the sensible default; research what GitHub offers
   first (commit comments, review threads, issues, discussions, git notes,
   files in the repo) and record the trade-offs.
3. **Resolve/reopen review threads** (GitHub GraphQL `resolveReviewThread`).
4. **Email notifications**, only for direct asks: review requested from you,
   assigned to you, invited to a paper. No digests and no emails for ordinary
   activity (Fran: don't bother anyone). Reuse the Resend account already used
   by Shadow Dungeon.
5. **Click-to-jump** between preview and source, both ways (renderer tags blocks
   with `file:line`).
6. **History**: versions = commits on main, labels = tags, compare with the
   existing diff view, restore = a proposal (PR), zip download.
7. **Download the CI-compiled PDF** from galley (needs Actions/Checks read on the
   app; the org must approve the new permission).
8. **Symbol palette** with KaTeX previews.
9. **Dark theme.**
10. **Vim mode** toggle (CodeMirror keymap).
11. **Chat per paper** on PocketBase realtime (persistent history, private,
    encrypted at rest like drafts, unread counts), not P2P.
12. Also from the research: "accept all suggestions", find and replace across
    files, print-to-PDF from the preview as an unofficial copy.

## Later

- Bibliographic GraphRAG (like the Shadow Dungeon lore graph).

## Out of scope

- Real-time co-editing and presence-based editing (against galley's philosophy).
- Zotero/Mendeley integration (for now).
- Full WYSIWYG editor, templates, share links.

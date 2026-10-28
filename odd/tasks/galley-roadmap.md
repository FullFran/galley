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
   Progress (2026-10-28): design in `docs/comments-design.md`; backend phase 1
   plus resolve/reopen built (`feat/comments-api`); UI phase 1 built
   (`feat/comments-ui`): comment from the editor and from the preview,
   gutter/highlight markers, threads panel with replies, edit/delete own,
   resolve/reopen with push, unread counts, suggestions applied to the
   buffer. Pending: re-anchoring, PR export, AI authors (MCP/CLI).
3. **Resolve/reopen review threads** (GitHub GraphQL `resolveReviewThread`).
   Done in `feat/comments-ui`: `reviewThreads` query plus
   `resolveReviewThread`/`unresolveReviewThread`, gated on
   `viewerCanResolve`/`viewerCanUnresolve`.
4. **Email notifications**, only for direct asks: review requested from you,
   assigned to you, invited to a paper. No digests and no emails for ordinary
   activity (Fran: don't bother anyone). Reuse the Resend account already used
   by Shadow Dungeon.
5. **Click-to-jump** between preview and source, both ways (renderer tags blocks
   with `file:line`).
   Done in `feat/comments-ui`: `data-src="path:line"` tags, double-click in
   the preview jumps to the source, "Show in preview" (Ctrl/Cmd+Alt+P).
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

13. **New section** (Fran, 2026-10-28; goes with CX2 next to figure upload):
    "New section" / "New subsection" from the paper outline. Asks for title and
    position, creates `sections/<slug>.qmd` with `# Title {#sec-slug}`, inserts
    the `{{< include >}}` at that position in the entry file, adds a label to
    `.galley.yml`; all in the user's proposal. Default: anyone with write;
    `.galley.yml` can restrict it to admins. File names are slugs; order comes
    from the include list (never renumber files). Rename/move/delete later, with
    warnings about `@sec-` references they would break.

14. **Team management** (Fran, 2026-10-28), from the team research:
    - Section owners from CODEOWNERS, shown in the outline, with automatic
      review requests (owners need write access).
    - Per-section status (draft / in review / approved) stored in
      `.galley.yml`, shown as outline badges.
    - Asks with due dates ("Review Methods by Friday") as issue + assignee +
      milestone, listed under "My asks" (needs Issues write; org approval).
    - Weekly activity view per person (owner only, non-judgemental).
    - Invite co-authors from galley with a role and pending invites (needs
      Administration write; admins only; 50 invites per repo per day).
    - Writer vs reviewer roles in `.galley.yml`, backed by CODEOWNERS on
      `.galley.yml` and branch protection where available.
    New-section files follow the repo's existing naming (this paper:
    `sections/NN-name.qmd`); `sections/_slug.qmd` only when there is none.

## Later

- Bibliographic GraphRAG (like the Shadow Dungeon lore graph).

## Out of scope

- Real-time co-editing and presence-based editing (against galley's philosophy).
- Zotero/Mendeley integration (for now).
- Full WYSIWYG editor, templates, share links.

# galley comfort and team features

## Objective

Turn the working MVP into a comfortable editor for a small academic team: a
preview close to the elsarticle PDF, review on GitHub primitives, drafts that
survive before saving, an admin view for the owner, and small writing aids.

## Problem and why

The MVP proves login, edit and save-as-PR. Non-technical co-authors still need
to see the rendered paper, review and comment without leaving galley, and not
lose unsaved work. The owner wants to help teammates without any way to act as
them on GitHub.

## Scope (ordered)

Inserted before C4 (Fran, 2026-10-28): CX "Overleaf experience", driven by a
`.galley.yml` file in the paper repository (decision A: config lives in the
repo, versioned, GitHub stays the source of truth; galley lets only repo admins
edit it, but anyone with write access could still change it on GitHub).
- CX1 Project config: `.galley.yml` schema (editable paths/globs, upload
  folders with accepted types and size limits, friendly file labels, entry
  file, preview defaults), strict validation, safe YAML load; "Set up galley"
  wizard for repo admins when the file is missing (prefilled from
  `_quarto.yml`, includes and a `figures/` folder) that proposes the file as a
  PR; admin-only settings screen; non-admins only see editable files; preview
  "Recompile" button (Overleaf-style, Ctrl+Enter) with an auto-compile toggle.
- CX2 Writing feel and uploads: user-selectable editor modes (Fran,
  2026-10-28): "Writing" (soft wrap, comfortable font, no code colouring or
  line-number gutter) and "Code" (the current CodeMirror look with line
  numbers and highlighting); per-user choice remembered, default from
  `.galley.yml`; paper outline sidebar (sections,
  jump to heading) instead of a folder tree, friendly file names, figure
  upload into configured folders as part of the proposal (image preview, size
  check).
- CX2 also gets autocomplete, moved up from C7 (Fran, 2026-10-28): on `@`,
  bib keys (author, year, title) and crossref labels (`@fig-`, `@tbl-`,
  `@eq-`, `@sec-` with number and caption) from all `.qmd`; path completion in
  `{{< include >}}` and `![](…)`; inline warnings for unknown citation keys and
  dangling crossrefs; reuse the C2 BibTeX parser and label collection.
- CX4 References manager (Fran, 2026-10-28): `references.bib` is editable (the
  setup wizard includes it by default) both as text and through an interactive
  editor: list and search entries, add from a DOI (Crossref) or a form, edit
  fields, delete with a warning when the key is cited, duplicate-key checks;
  writes BibTeX that leaves untouched entries byte-for-byte as they were.
- CX-UI App shell redesign (Fran, 2026-10-28), after CX1 and before CX2:
  follow Álvaro's hagalink design rules (hagalink-ops skills, puertanueva
  shell); collapsible sidebar (Paper outline/files, Proposals, Settings for
  admins, Help with the guided tour); fix the usability audit findings; a
  professional, scientific-looking sign-in/landing screen; visible author
  credit ("Built by Francisco Olmedo", links to https://www.fullfran.com and
  the GitHub repo) in the landing footer, the sidebar footer and an About
  dialog, so galley can serve as a portfolio piece.
- CX-i18n Spanish/English UI (Fran, 2026-10-28), after CX-UI: follow the
  owner's hagalink/criba pattern: no library; `as const` typed dictionaries
  grouped by area (`web/src/i18n/en.ts` exists since CX-UI, `es.ts` to add
  with the same `Messages` shape); plurals and interpolation as small
  functions; a Preact context whose default is the dictionary; the choice in
  `localStorage` wrapped in try/catch; `<html lang>` kept in sync; a
  hagabox-style key-parity Vitest test between catalogs; an ES | EN switcher
  in the sidebar footer (slot left by CX-UI). Spanish register: informal
  "tú", neutral Spanish compatible with Spain, no voseo, no exclamation marks
  (owner's decision, 2026-10-28). `es.ts` is written after CX-UI.
- CX3 Guided tour (Fran, 2026-10-28): an interactive onboarding guide modelled
  on hagalink/puertanueva `src/dominios/recorrido/` (PR #555, driver.js,
  author alvaroofernaandez): targets marked with `data-tour` attributes,
  guides as plain data (centred welcome step + anchored steps), lazy
  `import('driver.js')` with its CSS bundled as a file, steps skipped when the
  target never appears, Esc/X/overlay = skip, last step = done; seen/skipped
  stored per user (proposed: galley backend user record, mirrored in
  sessionStorage, best effort); replay from a header "?" help button (full
  tour + "guide for this screen"); progress via CSSOM or `<progress>`, never an
  inline `style` attribute (strict CSP); text escaped; reduced motion; 44 px
  touch targets.

1. C1 Polish: http-origin notice, editor heading style, confirmed deploy values
   in `docs/deploy.md`, MVP task document closed.
2. C2 Preview: client-side Quarto-to-HTML render behind `render(project) -> html`
   in a sandboxed iframe (no `allow-same-origin`), elsarticle-like styling,
   section/figure/equation/table numbering and crossrefs, KaTeX (`trust:false`),
   citations with the Elsevier Harvard CSL, `{{< include >}}`.
3. C3 Review: review ANY open PR of the repository from galley, not only the
   user's own working PR (Fran, 2026-10-28): list open PRs, view the changed
   files as a readable diff (and in the preview once C2 exists), list, reply to
   and create line comments and suggestions, submit a review (comment, approve,
   request changes), apply suggestions, show approval and merge state; manage
   who reviews: request/remove reviewers (collaborators with write access,
   otherwise GitHub returns 422), assignees, and show each reviewer's status
   ("pending", "approved", "changes requested"). Merge from galley: yes, for
   anyone GitHub allows to merge (Fran, 2026-10-28); show the button only when
   the PR is mergeable and the user has write access, never bypass checks, and
   confirm before merging.
4. C4 Drafts: IndexedDB autosave first, then server-side drafts encrypted in Go
   (AES-GCM, AAD `owner|repo|path`), owner-only, purged on save, after 30 days
   idle, and on revocation.
5. C5 "What changed since your last visit" (compare against a stored SHA).
6. C6 Admin panel: users, last seen, open galley PRs, draft metadata (never
   content), revoke a user's galley sessions, sign-in allowlist, consent-based
   read-only draft sharing (24 h, audited, revocable).
7. C7 Writing aids: crossref and bib-key autocomplete, per-section word counts
   with limits from YAML, DOI to BibTeX via Crossref, browser spellcheck.
8. C8 PR/CI status and CI PDF link (needs Checks/Actions read on the app: the
   org must approve the new permissions).

## Constraints

- Same constraints as `odd/tasks/galley-mvp.md` (security posture, English
  artifacts, conventional commits, no AI attribution).
- The admin can never obtain or use another user's GitHub token; help on GitHub
  happens with the admin's own identity.
- Defaults chosen pending Fran's review: draft retention 30 days; app-level
  encryption (VPS root with the env file can still decrypt; E2E rejected because
  it breaks admin help); share grants last 24 h.
- Note: `main` of the paper repo has no branch protection (GitHub Free private
  repo returns 403); `docs/deploy.md` must not claim it does.

## Delivery

- Strategy: stacked-to-main, one branch and PR per task, merged in order after CI
  passes (Fran's MVP choice and merge authorization, 2026-10-28).
- Forecast: well above ~400 lines per task for C2, C3, C4, C6.

## Tasks

- [x] C1 Polish (`feat/comfort-polish`). Route: delegated (2+ files).
- [x] C2 Preview (`feat/comfort-preview`). Route: delegated. Merged (PR #7,
  `06f1b0c`) and deployed.
- [x] C3 Review (`feat/comfort-review`). Route: delegated (2+ non-trivial
  files). Merged (PR #8, `e34cbcc`) and deployed; the live bundle contains
  the review UI.
- [x] CX1 Project config (`feat/comfort-config`). Route: delegated (2+
  non-trivial files). Merged (PR #9, `4589bf1`) and deployed.
- [ ] CX-UI App shell redesign (`feat/comfort-shell`). Route: delegated (2+
  non-trivial files, broad UI rewrite). Implemented and checked; pending
  review, commit and PR.
- [ ] CX-i18n Spanish/English UI. After CX-UI.
- [ ] CX2 Writing feel, uploads and autocomplete.
- [ ] CX3 Guided tour.
- [ ] CX4 References manager.
- [ ] C4 Drafts.
- [ ] C5 Changed since last visit.
- [ ] C6 Admin panel.
- [ ] C7 Writing aids.
- [ ] C8 PR/CI status.

## Progress and evidence

- 2026-10-28: plan agreed with Fran. Engram mirror pending (memory hook refuses
  writes in this session).

- C1 merged: PR #6 (`96cec89`).
- C2 implemented (delegated writer): renderer in `web/src/render/` behind
  `render(project)`, running in a module Web Worker with a 5 s compute budget;
  separate sandboxed `preview.html` (no `allow-same-origin`, own CSP); citeproc-js
  with vendored Elsevier Harvard CSL; self-hosted CMU Serif; no Paged.js (size
  and injected `<style>`). Independent read-only review: no confidentiality or
  integrity blockers; fixed quadratic comment/shortcode scans (16 s → <200 ms on
  400 KB), include fan-out caps (500 includes, 8 MB), dev-server `null`-origin
  CORS restricted to preview paths, one `ready` per frame load, asset caps.
  Checks: `npm ci --ignore-scripts` (0 vulns), lint, typecheck, test (139
  passed), build, headless Chromium check (no CSP violations; `parent.document`
  throws); parent spot check test + typecheck: pass. Sizes: main 136.9 kB gzip,
  render worker 245 kB gzip. Real paper rendered with no diagnostics.

- C2 merged: PR #7 (`06f1b0c`). Live check on production: `preview.html` is
  served with its own CSP, and the opaque-origin frame handshake (ready, then
  render) works.
- C3 implemented (delegated writer):
  - Port `ReviewGateway` (`web/src/domain/review.ts`), separate from
    `RepoGateway` because reviewing is a different capability from editing;
    GitHub adapter `web/src/github/review.ts` on the existing client (origin
    check, pagination, error mapping, 401 retry). Shared git helpers moved to
    `web/src/github/git.ts`; `save` keeps the same requests. 422 now maps to
    `RejectedError` (a `GatewayError`, so existing callers are unaffected).
  - Pure logic in `web/src/review/`: patch parsing and anchors, thread
    grouping, reviewer states, merge gating, suggestion parse/apply with
    co-author trailer, plain-language labels.
  - Containers `Proposals` and `ProposalDetail`; presentational components in
    `web/src/ui/review/`. All PR text rendered as text nodes; links only to
    https://github.com URLs.
  - Endpoints checked against docs.github.com: everything fits Contents RW,
    Pull requests RW and Metadata R (assignees: Issues or Pull requests).
    Merge settings (`allow_*_merge`) need Contents read+write; if GitHub hides
    them, galley offers no merge method and points to GitHub. Team reviewers
    are not shown. CI status stays in C8.
  - Fixed a C2 race found during the headless check: the preview frame's first
    `ready` could arrive before the message listener (registered in a passive
    effect) existed, leaving the preview blank when the frame loaded fast; the
    listener is now registered in a layout effect.
  - Checks: tests written first (RED: missing modules), then GREEN.
    `npm ci --ignore-scripts` (0 vulnerabilities), lint, typecheck, test (189
    passed, 20 files), build (main 145.2 kB gzip). Headless Chromium against
    the production build with mocked GitHub: list with review and merge
    states, 422 reviewer message, queued line comment sent with an approval,
    range comment with suggestion block, suggestion applied as a fast-forward
    commit with `Co-authored-by`, merge with `sha` and method, PR-head preview
    rendered, `<img onerror>` in titles and comments stays text, no horizontal
    overflow at 390 px.
  - One scoped correction after an independent review (no blockers): draft
    and queued comments are tied to the head they were written on and, when
    the head moves, are not sent but shown with copyable text; unchanged diff
    lines carry both LEFT and RIGHT anchors, and threads that cannot be placed
    go to "earlier version" (file-level comments get their own list); 422
    errors carry the refused action for accurate messages; suggestion
    matching ignores `\r` and keeps CRLF consistent, also on a last line
    without newline; reviewer/assignee controls need push access; a refused
    fast-forward on an unmoved head reports a protected branch; suggestion
    fences follow CommonMark (longer closing fence, up to 3 spaces indent).
    Regression test for the preview ready race (hooks mocked; fails with a
    passive effect). Checks: lint, typecheck, test (204 passed, 23 files),
    build (main 146.1 kB gzip); headless check: review after an applied
    suggestion posted on `c2` without the stale comment, LEFT and file
    threads shown.

- C3 merged: PR #8 (`e34cbcc`), deployed; the live bundle contains the
  review UI.
- CX1 implemented (delegated writer):
  - Schema and docs in `docs/galley-yml.md` (linked from README):
    `version: 1`, `title`, `entry`, `editable` (required), `uploads`
    (`folder`, `accept`, `max_size_mb`), `labels`, `preview.auto_compile`.
    Parsed with js-yaml's core schema, `maxAliases: 0`, `maxDepth: 20`,
    64 KB cap; unknown keys warn, any error invalidates the file and galley
    falls back to safe defaults.
  - Own glob matcher in `web/src/config/glob.ts` (no new dependency):
    segment-wise `*`, `?`, whole-segment `**`, memoized (polynomial, no
    regex from input); wildcards never match dotted names. Validation refuses
    leading `/` or `~`, drive letters, `..`, `.`, empty segments, backslashes,
    brackets, braces and `!`.
  - Visibility (`web/src/config/project.ts`): admins see all files; others
    see `editable` matches, never `.galley.yml` or `.github/`; without a valid
    file, co-authors see `.qmd/.md/.bib` outside hidden folders (keeps galley
    usable before setup without exposing config or scripts). Admin comes from
    `permissions.admin` on `GET /repos/{owner}/{repo}` (`RepoAccess.admin`);
    a failed access call is treated as non-admin.
  - Wizard (`web/src/config/wizard.ts`) and settings form
    (`containers/ProjectSettings.tsx`, `ui/config/`): prefill from
    `_quarto.yml`, `{{< include >}}` reachability, bibliography, `figures/`
    and first headings; the form validates the exact serialized file and
    saves it as a normal galley save (commit on `galley/<login>` + PR).
  - Preview: `.galley.yml` `entry` reaches the renderer (`ProjectSource.entry`,
    worker message); Recompile button, Ctrl/Cmd+Enter (window capture
    listener, before CodeMirror's Mod-Enter), auto-compile toggle with a
    per-repository localStorage choice (guarded); `web/src/compile/`.
  - YAML parser, wizard and settings load on demand: main 149.5 kB gzip
    (146.1 before); `schema` chunk 18.6 kB gzip.
  - Checks: tests written first (RED: 6 new test files failing on missing
    modules), then GREEN. `npm ci --ignore-scripts` (0 vulnerabilities), lint,
    typecheck, test (273 passed, 31 files), build. Headless Chromium against
    the production build with mocked GitHub: admin wizard saved
    `.galley.yml` with the expected content in the `git/trees` request
    (commit and PR titled "Set up galley (.galley.yml)"); co-author tree
    limited to editable files (`.galley.yml` listed in `editable` still
    hidden); no render on edit with auto-compile off, render on Ctrl+Enter
    (no blank line inserted) and on the button, auto-compile renders and is
    remembered; missing and invalid configs show the notices and errors as
    text; no horizontal overflow at 390 px.

- CX1 merged: PR #9 (`4589bf1`), deployed.
- CX-UI implemented (delegated writer, branch `feat/comfort-shell`):
  - Shell (`web/src/ui/shell/AppShell.tsx`): skip link, sidebar (16rem /
    3.5rem icon rail with tooltips / phone drawer with scrim), sticky 3.5rem
    header with breadcrumb, save state and actions, `100dvh` layout where
    sidebar, editor and preview scroll on their own; toasts (z 60) instead of
    banners above the editor; native `<dialog>` About (version, MIT, credits).
  - Pure logic with tests: navigation data filtered by role
    (`web/src/shell/nav.ts`), sidebar state machine and guarded persistence
    (`sidebar.ts`; hook `useSidebar.ts` owns Ctrl/Cmd+B, Escape, focus
    return), outline extraction with `{#sec-x}` ids and includes
    (`outline.ts`), main document and save label (`workspace/session.ts`),
    admin "View as co-author" filter and per-repo storage
    (`config/viewAs.ts`, added at Fran's request), preview scroll message
    (`preview/protocol.ts`, validated id/text).
  - Audit fixes: "Save for review" in the header with an optional note
    popover; aria-current plus weight and indicator for location; main
    document opens on its own; Edit | Preview switch below 1024px; review
    decision first with an action-named button, hunk headers shown as
    "Lines 5–9", one Merge button with "Merge options", sticky review bar on
    phones; proposal rows as one click target with status chips and a
    teaching empty state; repository rows with visibility, last update
    (`pushed_at`) and search from 6 repositories; accent tint instead of
    success green for the open file; skeletons instead of "Loading…".
  - Landing: value line, one "Sign in with GitHub", access note, HTML/CSS
    editor + preview drawing, credit footer; http→https notice kept.
  - Credit "Built by Francisco Olmedo" (https://www.fullfran.com) and the
    source link in the landing footer, sidebar footer (info icon when
    collapsed) and About, all `rel="noopener noreferrer"`.
  - Tokens and light/dark themes in `web/src/styles.css`; editor colours and
    syntax highlighting through CSS custom properties (they cross the shadow
    root). No new dependency. Copy of the new UI in `web/src/i18n/en.ts`
    (`as const`, `useT()` context with the English default).
  - Checks: tests written first (RED: 5 new files failing on missing modules
    plus 6 protocol cases; later `viewAs` RED on the missing module), then
    GREEN. `npm ci --ignore-scripts` (0 vulnerabilities), lint, typecheck,
    test (330 passed, 37 files), build. Sizes: main JS 149.5 → 159.1 kB gzip,
    main CSS 2.2 → 6.7 kB gzip.
  - Headless Chromium against the production build with mocked GitHub, at
    1440, 1280 and 390 px in light and dark (82 screenshots in the session
    scratchpad `shots-v2/`): no CSP violations, no page errors, no
    horizontal overflow; main document opened automatically; outline heading
    moves the editor cursor and scrolls the preview; Save stays in view while
    the editor scrolls; Ctrl+B collapses and expands; the drawer takes focus,
    closes on Escape and on opening a file, and returns focus to the menu
    button; skip link is the first tab stop and focuses `main`; 2px focus
    rings; no raw `@@` in the proposal view. The C3 review and CX1 config
    scripts give the same requests and results as before the redesign. Admin
    toggle: co-author view hides `figures/` and `_quarto.yml`, keeps project
    settings, and is remembered after a reload.

## Next step

Review, commit and open the CX-UI pull request; then CX-i18n (`es.ts`).

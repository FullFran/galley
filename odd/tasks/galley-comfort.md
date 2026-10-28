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
- CX2 also gets "go to definition" in the editor (Fran, 2026-10-28: small
  comforts are key): double-click (and Ctrl/Cmd+click) on a
  `{{< include path >}}` opens that file; on a figure path opens or previews
  the image; on `@fig-x`/`@sec-x`/`@eq-x`/`@tbl-x` jumps to where the label is
  defined (in whichever file); on `@citekey` opens the entry in the references
  manager (CX4) or `references.bib`.
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
  credit ("Built by FullFran", originally "Francisco Olmedo"; links to https://www.fullfran.com and
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
- [x] CX-UI App shell redesign (`feat/comfort-shell`). Route: delegated (2+
  non-trivial files, broad UI rewrite). Merged (PR #11, `bb291f2`) and
  deployed.
- [x] CX-i18n Spanish/English UI (`feat/comfort-i18n`). Route: delegated (2+
  non-trivial files: catalogs, locale, every UI component). Merged (PR #12,
  `883ec53`).
- [ ] CX-UX Shell usability pass and hash routes (`feat/shell-usability`).
  Route: delegated (2+ non-trivial files: shell, sidebar, header, router,
  every container). Implemented and checked; pending review, commit and PR.
- [ ] CX2 Writing feel, uploads and autocomplete. Route: delegated (2+
  non-trivial files).
  - [x] CX2a (`feat/cx2-editor`): sync with the default branch (watch and
    offer, merge before every save, roadmap 1), Writing | Code modes with
    `editor.default_mode`, lazy Vim (roadmap 10), autocomplete, inline
    warnings and go to definition; credit reads "FullFran". Implemented and
    checked; pending review, commit and PR.
  - [x] CX2b (`feat/cx2-structure`): figure upload into `uploads` folders
    (Files, drop on folders and on the editor, preview, Replace / Keep both,
    Insert figure, binary blobs in the single save), New section / New
    subsection from the Outline (roadmap 13, `structure: admin|write`),
    friendly names with path tooltips. Implemented and checked; pending
    review, commit and PR.
- [ ] CX-C Comments UI phase 1, review thread resolve, click-to-jump
  (`feat/comments-ui`; roadmap 2, 3, 5). Route: delegated (2+ non-trivial
  files). Implemented and checked; pending review, commit and PR.
- [ ] CX3 Guided tour.
- [ ] CX4 References manager.
- [ ] C4 Drafts. Server API merged. UI (`feat/drafts-chat-ui`, with roadmap
  11 chat): IndexedDB autosave (~1 s), restore with notice and Undo, server
  sync (~5 s, If-Match, 409 "Use it / Keep mine", never overwrites), offer of
  other devices' drafts, three-way merge on a moved base, deletion after
  save, "Keep drafts on the server" preference, header "Draft saved".
  Route: delegated (2+ non-trivial files). Implemented and checked; pending
  review, commit and PR.
- [x] C5 Changed since last visit (`feat/history`, with roadmap item 6).
  Route: delegated (2+ non-trivial files). Assessed tier and review outcome:
  pending (not committed by the writer).
- [ ] C6 Admin panel. Server side: Admin API (`feat/admin-api`, PR #21).
  - [x] C6-UI (`feat/admin-ui`): Admin tabs People, Access, Shared drafts,
    Activity log (lazy chunk `ui/admin/AdminPanels`), revoke sessions with
    confirmation (`confirm_self` for yourself), allowlist add/remove with
    validation and a "blocked now" preview, read-only shared-draft viewer with
    the logging banner and "Copy into my own draft", activity filter, "Open
    their proposals" (`proposals/by/{login}`), owner share toggle in the
    editor ⋯ menu, co-author deep links to admin routes redirected, en + es.
    Route: delegated (2+ non-trivial files). Checks: lint, typecheck, Vitest
    (RED then GREEN), build, headless Chromium against the production build
    with mocked APIs (admin and co-author, no CSP violations). Pending
    review, commit and PR.
- [ ] C7 Writing aids.
- [x] C8 PR/CI status and CI PDF (`feat/ci-pdf`). Route: delegated (2+ files).
  Assessed tier and review outcome: pending (not committed by the writer).

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

- CX-UI merged: PR #11 (`bb291f2`), deployed.
- CX-i18n implemented (delegated writer, branch `feat/comfort-i18n`):
  - Catalogs: `web/src/i18n/en.ts` extended to every interface string
    (status banners, view notice, settings form and glob messages, stale
    comments, diff, composer and threads, people and merge boxes, review
    labels, `describeError`/`describeReviewError`, preview and compile bar,
    proposal toasts, native confirm prompts, landing mock, About credits,
    aria-labels and tooltips); `web/src/i18n/es.ts` implements `Messages`
    with the agreed register (header comment). Plurals through
    `Intl.PluralRules` (`i18n/plural.ts`); commit messages for saves and
    settings follow the active language.
  - Locale (`i18n/locale.ts`, `i18n/LocaleProvider.tsx`): stored choice
    (`galley-locale`, try/catch), else `navigator.languages[0]` starting with
    `es`, else English; `<html lang>` synced. ES | EN two-button toggle with
    `aria-pressed` (`ui/shell/LanguageSwitch.tsx`) in the sidebar footer
    (App passes it through `ShellContext.languageSwitch` to the AppShell
    slot; stacked in the icon rail) and in the landing footer.
  - Switching without reload must not re-run data effects: callbacks read the
    catalog through `useTRef()`, otherwise `Workspace.load` would be
    re-created and reload the repository, dropping unsaved edits. Messages
    that must follow a switch are stored as data (preview status, merge
    state of proposal rows), not as text. The editor's aria-label is
    reconfigured through a CodeMirror compartment.
  - Dates: `i18n/format.ts` with `Intl.DateTimeFormat` and
    `RelativeTimeFormat` (repository and proposal "updated", comment dates,
    compile time).
  - Phones: the Spanish header overflowed by 3px at 390 and 33px at 360;
    the save button now shows a short label ("Guardar" / "Save") below
    480px, with the full name as its accessible name. The outline's main
    file chip reads "Principal" so the file name is not cut.
  - Still English, by choice: renderer diagnostics (preview notes, produced
    in the worker), `.galley.yml` validation problems from `config/schema.ts`
    and `config/load.ts` (admin-facing), and the pull request body written by
    the gateway.
  - Checks: tests first (RED: `src/i18n/i18n.test.tsx` failed on the missing
    `es.ts`, `locale.ts`, `format.ts` and switch modules), then GREEN:
    `npm ci --ignore-scripts` (0 vulnerabilities), lint, typecheck, test (352
    passed, 38 files), build. Sizes: main JS 159.1 → 167.9 kB gzip, main CSS
    6.7 → 6.8 kB gzip, ProjectSettings chunk 4.0 → 3.6 kB gzip.
  - Headless Chromium against the production build with mocked GitHub,
    browser locale `es-ES`, at 1440 and 390 (30 screenshots in the session
    scratchpad `shots-es/`): no CSP violations, no page errors, no
    horizontal overflow, header not clipped, no truncated text except
    visually-hidden legends; Spanish detected on first visit; the landing
    switch to EN survives a reload; the sidebar switch to EN re-renders
    without reload, keeps the unsaved edit, updates `<html lang>` and
    storage, and switches back. The C3 review and CX1 config scripts (forced
    to `en-US`) give the same requests and results as before, apart from the
    relative "updated" time.

- CX-i18n merged: PR #12 (`883ec53`).
- CX-UX usability pass (delegated writer, branch `feat/shell-usability`, from
  the shell spec in the session scratchpad `ux-shell-spec.md`; merged with
  `origin/main` after CX-i18n landed):
  - Sidebar by task, adopting Álvaro's patterns (hagalink/turing
    `nav-config.ts` and `use-sidebar-state.ts`, hagalink/puertanueva
    `navegacion-grupos.ts`, hagalink/gdr `administracion-tabs.ts` and
    `nav-user.tsx`): one data source whose order is the tab order; daily work
    first, admin last and separate; group open state as one guarded JSON map
    (`galley:nav-groups`); a footer outside the main nav; one admin page with
    tabs and a pure `resolve()` that falls back to the default tab; an
    account dropdown with a theme radio group and sign out last. Not adopted:
    role badges (galley has two roles and shows none) and a command palette.
  - Repository switcher row; Write (Contents with Outline | Files over one
    tree, per repository); Review (collapsible, closed by default, opens on
    its route, one "Proposals 2 · 1 yours" row); one Admin entry for admins
    opening the Admin area (Project settings, View as co-author; People,
    Sessions, Allowlist declared, not shown); "Viewing as co-author · Exit"
    banner; one-line "Not set up" banner above the editor, dismissible per
    repository; active entry with a 3px bar and bold, no dot.
  - Account menu (theme, language English · Español with `lang`,
    Preferences…, Keyboard shortcuts, tour, About, Sign out last), Help menu,
    credit line; Preferences dialog (auto-compile default, theme, language);
    Keyboard shortcuts dialog on `?`; Ctrl/Cmd+S opens Save for review.
  - Header: actionable breadcrumb (repository → switcher, folder → Files),
    save state with a dot, ⋯ menu (Recompile now, Keyboard shortcuts; "Add a
    note…" on phones), split "Save for review" button; phone header keeps the
    file name.
  - Theme System/Light/Dark stored as `galley:theme`, applied before first
    paint by `web/public/theme-init.js` (external, CSP-safe).
  - Fixes: drawer footer one row, no overlap; "Out of date · Ctrl+Enter"
    badge only when stale (opening a file no longer marks the preview stale);
    auto-compile as a switch; no active card on the repository list; phone
    review bar hides at the review card; "You can't approve your own
    proposal."; no GitHub link in proposal rows.
  - Hash routes (owner bug: reload went back to Repositories):
    `web/src/shell/route.ts`, strict parsing, `pushState`, back/forward with
    the unsaved-changes guard, `?login=failed` still stripped with the hash
    kept, return to the route after sign in (validated `sessionStorage`).
  - Spanish strings for every new key (key-parity test passes).
  - Checks: tests first. RED: 7 new test files failed on missing modules
    (`navGroups`, `prefs`, `theme` + `public/theme-init.js`, `shortcuts`,
    `menuNav`, `adminTabs`, `route`) and the rewritten `nav.test.ts` failed 5
    assertions; later `textsEdited` failed with "not a function". Then GREEN:
    `npm ci --ignore-scripts` (0 vulnerabilities), lint, typecheck, test (439
    passed, 45 files), build. Sizes against `origin/main`: main JS 167.9 →
    173.6 kB gzip, main CSS 6.8 → 7.8 kB gzip. No new dependency.
  - Headless Chromium against the production build
    (`VITE_API_BASE=https://galley-api.fullfran.com`) with mocked GitHub, at
    1440, 1280 and 390 in light and dark (108 screenshots in the session
    scratchpad `shots-v3/`, script `pw/shell-check-v3.mjs`): 0 failed checks,
    no CSP violations, no page errors, no horizontal overflow, no inline
    style attributes from galley (Playwright's screenshot leaves `style=""`
    on inputs; those are ignored). Checked: return to `#/r/o/paper/proposals/4`
    after sign in; reload keeps the file, the proposal detail and the admin
    tab; invalid and unknown routes land on `#/`; back goes to the previous
    file; the unsaved guard holds on sidebar navigation and on a hash change;
    the Contents tab persists; folder crumb opens Files; Ctrl+S opens the
    note with focus in it; ⋯ and account menus open on the first item, move
    with arrows/End and return focus on Escape; `?` opens the shortcuts
    dialog; Ctrl+B rail keeps Review open; theme switch applies, is present
    at `DOMContentLoaded` after reload, and System removes the attribute;
    the drawer footer ends at the viewport bottom with no overlap; Review
    opens on the proposals route with "2 · 1 yours"; no link in proposal
    rows; "You can't approve your own proposal."; the phone review bar shows
    only when the review card is off screen; admin entry and tabs, the view
    as co-author banner and Exit; the setup banner gives admins "Set up…" and
    stays dismissed after a reload; a co-author on an admin address sees only
    "Only admins…". The C3 review (`pw/review-check-v3.mjs`) and CX1 config
    (`pw/config-check-v3.mjs`) scripts give the same requests and results as
    v2, apart from selectors (Files tab, "Set up…", "Fix…", Admin entry) and
    the proposal rows no longer linking to GitHub.
  - Not done: Writing | Code slot and Vim (CX2), notifications, Download PDF
    and History in ⋯, and the admin panel tabs (C6) beyond their declaration.

- 2026-10-28, CX2a (`feat/cx2-editor`):
  - Sync with main, as refined by Fran: while editing galley polls the
    default branch head every 60 s while the tab is visible and on focus, and
    shows "main has N new changes · Bring them in" with a dismiss; it never
    merges while you type. Bring in and every save use the merges API
    (`POST /repos/{o}/{r}/merges`, Contents: write per GitHub's "Permissions
    required for GitHub Apps" page), or a fast-forward when the branch is only
    behind; 409 gives a non-blocking conflict banner with a GitHub link;
    nothing is forced. Edited files keep the user's text (only the base moves,
    with a warning); a save stops if main changed a file the user edited. The
    open-time fast-forward and squash-merge recovery are unchanged.
  - Editor: Writing (paper font 16px/1.7, 72ch centred, no gutter, quiet
    headings/math/citations) and Code; header Writing | Code (⋯ on phones);
    per-person choice in `galley:prefs`, else `editor.default_mode`, else
    Writing for co-authors and Code for admins; Preferences → Editor has the
    mode and a Vim switch. `@replit/codemirror-vim` 6.4.0 loads only when on.
  - Autocomplete on `@` (bib keys with author/year/title, labels with number
    and caption), include and figure path completion, warnings for unknown
    keys and dangling crossrefs, go to definition (double-click,
    Ctrl/Cmd+click, F12) with screen-reader announcements; the index is built
    in `indexWorker.ts`.
  - Credit: "galley · by FullFran", "Built by FullFran", "Hecho por FullFran".
  - Tests first: RED observed for the gateway merge tests (8 failing before
    the code), the editor-mode schema (3) and prefs tests (5), the
    `shouldOffer` prompt test, and missing-module failures for the upstream,
    index client, assist and UI tests; then GREEN: 51 files, 498 tests.
  - `npm ci --ignore-scripts`, lint, typecheck, test and build pass. Headless
    Chromium against the production build with mocked APIs
    (`pw/cx2-check.mjs`, screenshots in `shots-cx2a/`, light/dark at
    1440/390): 0 failed checks, no CSP violations, no page errors. Checked:
    co-authors start in Writing (no gutter, 16px paper font), Code shows line
    numbers, the bring-in prompt and its dismissal, the autocomplete popup on
    `@` lists bib keys and labels, an unknown key is underlined,
    double-clicking an include opens `02-model.qmd` and announces it,
    Ctrl+click on a figure path opens the lightbox, Vim's chunk is not
    requested until the switch is on and then gives the block cursor.
  - Bundle: initial JS 521 kB (gzip 174) → main 269 kB + shared CodeMirror
    chunk 293 kB = 562 kB (gzip 187). Lazy: `editorAssist` 43 kB (gzip 15),
    Vim 131 kB (gzip 42), `indexWorker` 9 kB.

- 2026-10-28, CX2a review correction (one scoped round):
  - Blocker fixed: an edited file that main also changed is now merged
    three-way (base the user started from, user text, new text) with
    `node-diff3` 3.2.1; clean merges go into the buffer with a notice,
    conflicts show a resolution view (Their version / Your version / Keep
    both, en + es) and block saving until every place is chosen. Both "Bring
    them in" and the save path go through `bringIn` + `rebase`.
  - A merge that landed is applied for every save outcome (also when the
    commit fails); "edited" is judged from the snapshot before the reads and
    typing during the fetch counts as edited; the index caches text by blob
    SHA with at most 6 reads in flight; a merge commit with the wrong first
    parent is a moved branch; figure size is checked from the tree before
    downloading; a wrong `editor.default_mode` is a warning and is ignored.
  - RED observed: 7 rebase/save tests, 2 `bringIn` tests, 4 gateway tests
    (blobs, first parent), 1 schema test, and missing-module failures for
    `merge3`, `textCache` and `MergeResolver`; GREEN: 53 files, 519 tests.
  - Headless (`pw/cx2-check.mjs`, `shots-cx2a/`): all earlier checks plus a
    conflict (resolution view, no markers, save blocked, Keep both) and a
    clean merge (both changes kept, notice); 0 failed, no CSP violations.
  - Bundle: main 269 → 278 kB (gzip 92.5 → 95.4); lazy chunks unchanged.

- 2026-10-28, CX-C comments UI (`feat/comments-ui`):
  - `CommentsGateway` port + HTTP adapter (cookie credentials, CSRF header,
    typed 401/403/404/409/413/422/429/5xx errors, field-by-field response
    checks); anchors with 32-character quote context; renderer `data-src`
    tags through includes and front matter; validated frame `selection`,
    `jump` and `reveal` messages; threads panel; suggestions applied to the
    buffer only; GraphQL resolve/unresolve of review threads.
  - RED observed (missing modules / functions) for the adapter, anchors,
    preview mapping, suggestions, source tags, frame messages, panel gating
    and GraphQL; GREEN: 60 files, 593 tests.
  - Headless (`pw/comments-check.mjs`, `shots-comments/`): 43 checks, 0
    failed, no CSP violations (the API and GraphQL are already in
    `connect-src`).
- 2026-10-28, CX2b (`feat/cx2-structure`). Route: delegated writer (2+
  non-trivial files: gateway, upstream save, workspace, outline, files,
  dialogs, catalogs).
  - Uploads: `web/src/uploads/upload.ts` (name cleaning, type/size check before
    reading, signature check after reading, Keep both `-2`, figure markdown);
    the gateway save creates `POST /git/blobs` (base64) for binary changes and
    puts them with the text in one tree and one commit, fast-forward only,
    after the usual merge-before-save; `FileChange` gained `encoding:
    'base64'`. Pending uploads count as unsaved, show under "In this save"
    with Remove, and the preview reads them before they are saved. App CSP
    `img-src` gained `blob:` for the preview `<img>`.
  - New section: `web/src/structure/` (slug, include list and convention,
    plan with blocking problems and warnings, permission) and
    `web/src/config/configEdit.ts` (comment-keeping `labels`/`editable`
    edits, verified by re-parsing, else a full rewrite). Numbered includes:
    a new file between `02-` and `03-` becomes `02a-` (never renumber; the
    include list is the order; the folder still lists in paper order), the
    next number at the end, the one before the first at the start. Without
    includes: `sections/_slug.qmd`. Sections and subsections are buffers in
    the next save; the default commit message is the plain summary.
    `structure: admin|write` in the schema, settings form and docs.
  - Friendly names: Outline rows and the main file carry the path as
    tooltip; Files already did.
  - Tests first: RED observed for 5 tests (gateway blobs, two upstream
    uploads tests, two schema `structure` tests) and missing-module failures
    for `upload`, `includes`, `convention`, `permission`, `configEdit` and
    `summary`; then GREEN: 59 files, 582 tests.
  - Headless Chromium against the production build with mocked APIs
    (`pw/cx2b-check.mjs`, screenshots in `shots-cx2b/`, light/dark at
    1440/390): 0 failed checks, no CSP violations, no page errors. Checked:
    labels and tooltips, Upload to figures/, blob preview, Insert figure with
    an escaped caption, Keep both, a refused type, drop into the editor at the
    drop point, the save summary and Remove, uploads counted as unsaved, the
    save (two base64 blobs, one tree, one commit), a duplicate id blocking,
    `01a-methods.qmd` proposed after Introduction, and the admin save with
    exactly the new file, the include and the `.galley.yml` label (comments
    kept) under the message "New section “Methods” after “Introduction”".
  - Bundle: main 278.0 → 308.6 kB (gzip 95.4 → 106.9; about half is the new
    en + es copy); the plan module with js-yaml edits is a lazy 6 kB chunk.

- C8 implemented (delegated writer, `feat/ci-pdf` on `1b8257e`): CI chip per
  proposal (list and detail) from `commits/{sha}/check-runs`, polled every
  20 s only while running and visible; "Download PDF of this proposal" and
  "Download latest PDF" (default branch, successful push/dispatch runs) via
  `actions/runs` → `artifacts` → `artifacts/{id}/zip`, unzipped with `fflate`
  0.8.3 (lazy). The GitHub client allows leaving api.github.com only for the
  artifact zip endpoint and only to `*.blob.core.windows.net`; CSP
  `connect-src` adds `https://*.blob.core.windows.net`.
  - CORS (real artifact `paper-pdf-docx`, owner's token, read-only): the zip
    endpoint answers 303 to `productionresultssa12.blob.core.windows.net` with
    `Access-Control-Allow-Origin: *`; the blob answers `*` on GET and allows
    preflights. Headless Chromium against the build fetched a real artifact
    through the redirect and produced a 430 kB PDF blob.
  - Tests first (RED: modules missing, `downloadArtifact` not a function), then
    GREEN: status mapping, run and artifact choice (latest successful for the
    SHA, expired), redirect allowance limited to the zip endpoint and blob
    hosts, unzip picks the paper PDF. Lint, typecheck, 73 files / 702 tests,
    build. Headless check (`pw/ci-check.mjs`, `shots-ci/`): 15 checks, 0
    failed, no CSP violations, no page errors.
  - Bundle: main 118.2 → 121.7 kB gzip (+3.4); fflate chunk 2.7 kB gzip.

- C5 + roadmap 6 implemented (delegated writer, `feat/history` on
  `49c5005`): History screen (`#/r/{o}/{r}/history`, lazy chunk) with versions
  of the default branch (merged proposals named), tag labels (add/remove via
  `git/refs`, names validated first), compare via `compare/{a}...{b}` in the
  read-only diff view, preview at a SHA, zip as a github.com archive link
  (codeload sends `Access-Control-Allow-Origin:
  https://render.githubusercontent.com`, so a browser fetch fails; no CSP
  change), restore of a file or the whole paper as unsaved changes in the
  user's buffers (pending deletions are `sha: null` tree entries in the same
  commit). Last visit: head per login + repository in `localStorage`, banner
  "N changes since your last visit", "See what changed", "Mark as seen".
  - Tests first (RED: modules missing, history routes and nav entry absent,
    deletion test sending content), then GREEN: commit and tag mapping, label
    rules and requests, compare mapping, restore plan and buffers (deletions),
    last-visit store and banner. Lint, typecheck, 77 files / 767 tests, build.
    Headless check (`pw/history-check.mjs`, `shots-history/`): 27 checks, 0
    failed, no CSP violations, no page errors.
  - Bundle: initial JS 120.1 -> 125.3 kB gzip (+5.2, mostly en + es copy and
    the shared-chunk split); History chunk 2.9 kB gzip.

## Next step

Review, commit and open the C8 pull request; the org must have approved the
Actions (read) and Checks (read) permissions (verified 2026-10-28).

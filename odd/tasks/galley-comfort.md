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
- [x] C2 Preview (`feat/comfort-preview`). Route: delegated. Merge on hold
  until Fran decides the citeproc-js licence question (CPAL-1.0/AGPL).
- [ ] C3 Review.
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

## Next step

Fran's citeproc-js licence decision, then merge C2 and start C3.

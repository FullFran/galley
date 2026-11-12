# Draft PDF in the Browser (T3 + T4) — Antigravity Report

## Executive Summary
Completed tasks **T3** and **T4** of the feature "Draft PDF compiled in the browser" for `galley`, following all requirements and constraints specified in `.agy-brief.md` and `odd/tasks/browser-pdf.md`.

- **Branch**: `feat/browser-pdf-ui`
- **Worktree**: `/home/fran/orca/workspaces/galley/browser-pdf-ui`
- **Commits**:
  - `ba5ec6c feat(compile): in-browser TeX compile client and WASM CSP` (T3)
  - `494aa82 feat(ui): draft PDF view and compile toggle in preview pane` (T4)

---

## Tasks & Scope

### T3 (S2, S6, S7): Compile Client + CSP
- **CSP**: Added `'wasm-unsafe-eval'` to `script-src` in `web/vite.config.ts` (`APP_CSP`). Verified with `web/src/ui/ci/csp.test.ts`.
- **Compile Client**: Implemented `createCompileClient` in `web/src/compile/client.ts`:
  - Lazily spawns ONE long-lived classic worker (`web/public/tex/busytex_worker.js`) on first compile.
  - Sends `init` message once with engine assets (`busytex.js`, `busytex.wasm`, `galley-tex.js`, `galley-tex.data`) respecting Vite `BASE_URL`. Reuses initialized worker across subsequent compiles.
  - Calls `renderLatex(project)` and translates files to the worker compile protocol with `bibtex: true`, `verbose: 'silent'`, and `driver: 'pdftex_bibtex8'`.
  - 60-second execution budget: terminates worker on timeout and recreates next time.
  - Sequential queue replacement: newer compilation request replaces queued pending request.
  - Log error extraction: parses first `! ` error line and `l.<n>` source line into structured diagnostics. Passes through any `renderLatex` diagnostics.
  - Missing asset safety: gracefully handles missing `/tex/` assets (or network errors) without crashing, returning an actionable error note.
- **Tests**: Comprehensive unit tests in `web/src/compile/client.test.ts` covering single init, worker reuse, queue replacement, timeout recreation, TeX error note extraction, and missing asset handling.

### T4 (S1, S6, S8): UI & Integration
- **Preferences**: Added persistent `previewMode` (`'html' | 'pdf'`) to `Prefs` in `web/src/shell/prefs.ts` and tested in `web/src/shell/prefs.test.ts`.
- **i18n**: Added English (`web/src/i18n/en.ts`) and Spanish (`web/src/i18n/es.ts`) catalogs for draft PDF tab, downloading note ("Downloading the PDF engine (~32 MB, once)" / "Descargando el motor de PDF (~32 MB, solo una vez)"), compiling states, and official draft notice. Verified 100% parity in `web/src/i18n/i18n.test.tsx`.
- **CompileBar**: Updated `web/src/ui/CompileBar.tsx` and `web/src/ui/editing/toolbar.css` with a tab toggle between HTML and Draft PDF ("Draft PDF" / "PDF borrador").
- **DraftPdfView**: Created `web/src/ui/DraftPdfView.tsx`:
  - Reuses `useObjectUrl` from `web/src/ui/ci/CompiledPdf.tsx` to display the PDF in an `iframe`.
  - Displays download and open in new tab buttons.
  - Displays the first-time engine download status, "Compiling…" state, draft status label, and expandable `<details class="preview-notes">` diagnostics list.
  - Retains the last good PDF visible while recompiling or after a compilation failure.
- **Preview Container**: Updated `web/src/containers/Preview.tsx`:
  - Independent debounce compiler for Draft PDF (1500 ms debounce).
  - Lazy dynamic import (`await import('../compile/client')`) so that no TeX/WASM dependencies load until the user first clicks Draft PDF.
  - Recompile button and `Ctrl+Enter` trigger compilation for the active preview mode.
- **Documentation**:
  - `README.md`: Added `### Draft PDF (in-browser)` detailing engine, environment (`--no-shell-escape`), elsarticle template support, limits, first download size, and `npm run tex:build`.
  - `docs/deploy.md`: Updated Pages build documentation to include `npm run tex:build`.

---

## Verification & Observed Results

### 1. Static Checks & Test Suite
Ran command:
```sh
cd web && npx tsc --noEmit && npx eslint . && npm test && npm run build
```
- **TypeScript (`tsc --noEmit`)**: Clean (0 errors).
- **ESLint (`eslint .`)**: Clean (0 errors, 0 warnings across all files).
- **Vitest (`npm test`)**:
  - **117 passed test files** (117)
  - **1187 passed tests** (1187)
  - Duration: ~3.1 s
- **Vite Production Build (`npm run build`)**:
  - Production build successful in 884 ms.
  - `dist/assets/client-*.js` (522 kB raw / 155 kB gzip) split into its own lazy chunk, keeping initial app bundle lean.

### 2. Browser Verification on Production Build
- **Server**: Production build previewed at `http://localhost:4950/?demo#/` via `npx vite preview --port 4950`.
- **Headless Chromium**: Executable `/home/fran/.cache/ms-playwright/chromium-1194/chrome-linux/chrome`.
- **Scratch Directory**: `/home/fran/.cache/galley-pdf-scratch/` (contains `package.json`, `run-check.mjs`, and screenshot; kept on disk).
- **Measured Timings**:
  - **First compile duration** (downloading ~32 MB engine package + WASM init + 3-pass TeX compile): **4835 ms** (~4.8 s).
  - **Warm compile duration** (subsequent Recompile): **1606 ms** (~1.6 s).
- **PDF Iframe**: Verified loaded with Blob URL (`blob:http://localhost:4950/...`).
- **Screenshot**: Captured at `/home/fran/.cache/galley-pdf-scratch/draft-pdf-screenshot.png` (137 KB).
- **Console & CSP Check**:
  - **App CSP errors (WASM / script / connect / worker)**: **0** (WASM and TeX worker executed without CSP violations).
  - Note: Chromium's internal PDF viewer extension generated benign internal `style-src` warnings for its own `<embed style="...">` wrapper inside the blob iframe (standard Chromium behavior with strict CSPs; PDF rendered and displayed normally).

---

## Files Changed

| File | Change |
| --- | --- |
| `web/vite.config.ts` | Added `'wasm-unsafe-eval'` to `script-src` in `APP_CSP` |
| `web/src/ui/ci/csp.test.ts` | Pinned `'wasm-unsafe-eval'` in CSP test suite |
| `web/src/compile/client.ts` | Implemented in-browser TeX compile client |
| `web/src/compile/client.test.ts` | Unit tests for compile client |
| `web/src/shell/prefs.ts` | Added persistent `previewMode` to user preferences |
| `web/src/shell/prefs.test.ts` | Unit tests for `previewMode` preferences |
| `web/src/i18n/en.ts` | Added English UI strings for Draft PDF |
| `web/src/i18n/es.ts` | Added Spanish UI strings for PDF borrador |
| `web/src/ui/ci/CompiledPdf.tsx` | Exported `useObjectUrl` for reuse |
| `web/src/ui/CompileBar.tsx` | Added mode toggle buttons for HTML vs Draft PDF |
| `web/src/ui/editing/toolbar.css` | Added styling for compile mode toggle and draft notice |
| `web/src/ui/DraftPdfView.tsx` | New component for draft PDF view pane |
| `web/src/ui/DraftPdfView.test.tsx` | Unit tests for DraftPdfView |
| `web/src/ui/config/config.test.tsx` | Updated tests for CompileBar mode toggle |
| `web/src/containers/Preview.tsx` | Integrated Draft PDF compiler, mode switching, lazy import |
| `README.md` | Documented Draft PDF feature, limits, and build commands |
| `docs/deploy.md` | Documented `npm run tex:build` step in Pages deployment |
| `odd/tasks/browser-pdf.md` | Marked T3 and T4 complete with evidence and commits |

---

## Scratch Paths
- Scratch Directory: `/home/fran/.cache/galley-pdf-scratch/`
- Playwright Runner: `/home/fran/.cache/galley-pdf-scratch/run-check.mjs`
- Verification Screenshot: `/home/fran/.cache/galley-pdf-scratch/draft-pdf-screenshot.png`

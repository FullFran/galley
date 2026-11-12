# Draft PDF in the Browser (T3 + T4) — Antigravity Report

## Summary
Execution of tasks T3 and T4 for the galley feature "Draft PDF compiled in the browser" based on `.agy-brief.md` and `odd/tasks/browser-pdf.md`.

- **Branch**: `feat/browser-pdf-ui`
- **Worktree**: `/home/fran/orca/workspaces/galley/browser-pdf-ui`
- **Status**: In Progress

## Tasks & Progress

### T3 (S2, S6, S7): Compile Client + CSP
- [x] Add `'wasm-unsafe-eval'` to `script-src` in `web/vite.config.ts` (`APP_CSP`)
- [x] Update `web/src/ui/ci/csp.test.ts` to pin the new directive list
- [x] Implement browser TeX compile client in `web/src/compile/client.ts` (lazy worker spawn, 60s budget, queue replacement, timeout handling, note extraction, missing assets handling)
- [x] Unit tests for compile client in `web/src/compile/client.test.ts` (9 tests passed)
- [x] Verification of T3 (tests: 1181 passed across 116 files; types: tsc clean; lint: eslint clean; build: clean in 941ms)
- [ ] Commit T3: `feat(compile): in-browser TeX compile client and WASM CSP`

### T4 (S1, S6, S8): UI & Integration
- [ ] Add preview preference for HTML vs Draft PDF in prefs store (`web/src/shell/prefs.ts` + tests)
- [ ] Add i18n copy (EN / ES) for Draft PDF switch, status, notes, labels, downloading engine message
- [ ] Update `CompileBar.tsx` / `Preview.tsx` to support switching between HTML and Draft PDF
- [ ] Implement Draft PDF view component (reusing PDF viewer iframe & blob handling from `CompiledPdf.tsx`, draft label, notes list, first-time download note, keep last good PDF on recompile)
- [ ] Debounced compiler with 1.5s delay for Draft PDF auto-compile; lazy dynamic import of TeX client
- [ ] Update `README.md` and `docs/deploy.md`
- [ ] Commit T4: `feat(ui): draft PDF view and compile toggle in preview pane`

### T5 / Final Verification
- [ ] `cd web && npx tsc --noEmit && npx eslint . && npm test && npm run build`
- [ ] Browser check with Playwright Chromium on production build (`vite preview --port 4950`)
- [ ] Screenshot captured and console/timings verified

---
## Detailed Log
- Initialized report. TeX assets built and verified locally (`galley-tex.data` 25.5 MB LZ4 / 20.2 MB gzip).

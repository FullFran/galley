# Demo mode with a full interactive tour
In-browser demo with a fictional repository so the interactive tour can walk the whole flow, no GitHub or backend calls.
Branch: feat/demo-mode. Delivery: work-unit commits on the branch; push/PR are the user's decision. Runner: `npm test` (Vitest) in web/.

## Specs
- S1. "que aparezca un repositorio de prueba super tonto para enseñar todo el flujo y todas las funciones": a fictional, silly sample repository (Quarto paper with headings, an equation, a citation) served by in-memory gateways; no GitHub, galley API or other network call while in demo.
- S2. Entering the demo: `?demo` on the app URL (flag kept in sessionStorage, because App strips the query string at boot); links to it from the signed-out landing and the Help menu. A visible banner says it is a demo and offers an exit that clears the flag.
- S3. The demo works like the real flow: open the repository and file, outline, editor, preview, compile, "Save for review" creates a commit and a proposal in memory, the proposal list shows it, comments can be read and added. A seeded co-author proposal and comment thread exist from the start.
- S4. "el tour interactivo [...] todo el flujo y todas las funciones": in demo, the full tour navigates between screens (repo list, file, proposals, comments panel) so every step has its target; Back works across screens. Copy in English and Spanish.
- S5. The tour for real users keeps its current behavior (no navigation, no mutation, API-backed state).
- S6. The demo code is loaded on demand only in demo mode.
- Out of scope (user agreed): tutorial video, deferred; could later be recorded from the demo with Playwright.

## Tasks
- [ ] T1 (S1, S2, S3, S6) demo gateways, sample paper, entry, banner, landing link. Route: inline (no Writer trigger reason).
- [ ] T2 (S4, S5) demo tour with navigation, new anchors, copy en/es, Help menu link. Route: inline.
- [ ] T3 (S1-S5) README docs, browser check of the whole demo tour.

## Log
- L1 (2026-10-29) user: "revisa como esta el tour interactivo y mejoralo si hace falta por ejemplo que aparezca un repositorio de prueba super tonto para enseñar todo el flujo y todas las funciones, que te parece? o hacer un video del tutorial con el repo de prueba ficticio con todas las funcionalidades que opinas? como lo haria alvaro?"
- L2 (2026-10-29) finding: guideSteps drops steps without a visible anchor and the tour never navigates, so a new user with no file open sees only welcome, sidebar and help. Recommended an in-browser demo with fake gateways; video deferred.
- L3 (2026-10-29) user: "montalo! hazlo asi"

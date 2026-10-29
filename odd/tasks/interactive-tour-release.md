# Interactive tour release
Deliver issue #30 and deploy for the thesis director today. Branch: feat/interactive-tour-release.
Verification: frontend Vitest/lint/typecheck/build, Go tests/vet, production-browser smoke and deployment health checks. Delivery: auto-chain; feature-branch-chain selected by user. Tracker feat/interactive-tour-release; API slice feat/tour-api; web slice feat/tour-web. Baseline/default branch: main at ff79bec. Forecast about 860 authored changed lines, split into cohesive API (~363) and web (~499) slices; web overage retained to keep integration/tests together.

## Specs
S1. "Hay una issue para hacer la guia interactiva como las hace alvaro, revisala, revisa el resto de issues para ver si hay algo que cambie tanto que no merezca la pena hacer la issue ahora o algo que este roto."
S2. "Y Ejecuta lo que haga falta para desplegar cuanto antes una version con guia interactiva para dar a mi director de tesis hoy."
S3. "Te doy permiso para que despliegues y todo. tambien tienes permiso para hacer ssh a vspcontavo. Adelante"
S4. Issue #30 acceptance (existing requested issue): "Guides as plain data: a centred welcome step plus anchored steps; steps whose target is missing are skipped and \"Step X of Y\" is recomputed." "import('driver.js') lazily, its CSS bundled as a file; progress via CSSOM or <progress>, never inline style (strict CSP); text escaped; reduced motion; 44 px touch targets; Esc/X/overlay = skip, last step = done." "Shown on first visit with a Skip button; seen/skipped stored per user (galley backend, mirrored in sessionStorage, best effort)." "Replay from the sidebar Help entry (\"Take the tour\") plus \"Guide for this screen\"." "English and Spanish copy (\"tú\")."

## Tasks
T1 [S1,S2,S4] delegated: authenticated per-user tour persistence with tests; done; commit pending. RED missing Deps.Tour, GREEN focused/full Go tests and vet; independent verifier passed, notification route differential 42 records identical.
T2 [S1,S2,S4] delegated: lazy interactive guides, shell integration, translated copy, tests and docs; in_progress; commit pending.
T3 [S2,S3,S4] parent + independent verifier: verify final feature, backup/deploy API then frontend, public smoke and release handoff; pending; commit pending.

## Log
L1. User request verbatim: Hay una issue para hacer la guia interactiva como las hace alvaro, revisala, revisa el resto de issues para ver si hay algo que cambie tanto que no merezca la pena hacer la issue ahora o algo que este roto. Y Ejecuta lo que haga falta para desplegar cuanto antes una version con guia interactiva para dar a mi director de tesis hoy. Te doy permiso para que despliegues y todo. tambien tienes permiso para hacer ssh a vspcontavo. Adelante
L2. Read-only exploration: #30 is ready; #29/#31/#32/#33 do not invalidate guides. #34 anchors comments against head SHA using unsaved buffer coordinates; known limitation, not a tour dependency. Live frontend HTTP 200, API health ok, latest CI/Pages successful at ff79bec. Neither vspcontavo nor vpscontabo resolves. Need actual SSH target or permission to inspect SSH config before API deployment.
L4. User correction verbatim: es ssh fran@vpscontavo
L5. SSH works at fran@vpscontavo. ~/galley-api exists but is not a git checkout; investigating deployment layout read-only before choosing release transfer. T1 and T2 use disjoint surfaces and a fixed API contract; both workers active, visible todo projects backend first.
L6. User selected feature-branch-chain. Backend independent verification passed boundary/auth/isolation/private migration checks, full suite/vet and 42-record notification routing differential. Parent focused Go tests/vet passed. Frontend worker reports lint/typecheck/1031 tests/build passed; independent verifier and production-browser smoke running. Review assessment unavailable because intended untracked files were not declared; RDD remains off, independent verification follows explicit risk escalation.
L3. CSP interpretation: retain strict policy; use CSSOM property assignments for driver positioning (existing application convention), no style strings/cssText or CSP relaxation. Done only through explicit completion; dismissal always skipped. Backend is additive and must preserve stored users. Risk: item 2 (authenticated per-user state), item 5 (dependency and deployment).

# UI9 verification journal (eque2-verifier, action: verify, batch UI6-UI12)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario UI9. No semantic verdict in this dispatch.
- State at start: UI9 not_started, untrusted, retryCount 0. No prior UI9 journal.
- Read: tasks.md T4.4 and T4.5 (support UI9), shared.tsx, peek.tsx (`builderHeading`, `Peek`), the seven designs,
  shared.test.tsx, the tui test helper `view.ts`, the projected fixture.
- No sibling verify spec covers UI9, so write packages/opencode/test/task/verify-spec-UI9.spec.ts, each title with
  `[UI9]`. Plan: build the status from the real projection of facts (T1.4 budget exhausted, T1.2 failed, T1.5 and T1
  blocked) through `TaskEngineXState` + `TaskStatus.project`, decode with the task-ui `parse`, drive the real
  `taskView` actor (tui test helper `viewFor`), render each of the seven designs expanded and collapsed with
  `testRender`, and the Peek with the selected task.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-UI9.spec.ts (4 tests, each title starts with `[UI9]`, no describe).
  Renders without JSX (`createComponent`, `testRender`); the view is the real `taskView` actor via the tui helper
  `viewFor`, waited on until `selected` and `expanded` follow the events (a loaded machine was slow once).
- Given: facts T1.1 trusted, T1.2 exhausted (3 failed proofs), T1.3 started then `task.failed` with a 155-char merge
  reason; folded by `TaskEngineXState`, projected by `TaskStatus.project`, written by `TaskStatus.write` with a fresh
  heartbeat, decoded by the task-ui `parse`. Test 1 pins the status: T1.2 budget_exhausted + dead, T1.3 failed + dead,
  T1 and T1.4 "blocked by T1.2: budget exhausted", T1.5 "blocked by T1.4: blocked", 5 stopped, run active.
- Test 2 (shared region, 7 designs expanded; Ledger in a 120-row sidebar, the others 120 x 40): the region's scroll
  box read whole (mouse wheel); `STOPPED 5`; 4 lines, dead then blocked; each line equals its full text or its start
  cut with `…` at the region width; each shows the reason (dead) or `blocked by T1.x` (blocked); where the region is
  90+ cells (Matrix, Gantt, Ticker) every line that fits is whole.
- Test 3 (Peek, 7 designs expanded): T1.3 selected: heading line 1 `failed · attempt 1 · 0s`, then the reason over
  2+ lines, joined equal to the full reason, no `…`, each line in theme.error; T1.4 selected: heading joined equals
  `blocked by T1.2: budget exhausted`, in theme.warning.
- Test 4 (collapsed, 7 designs): the design's own collapsed view (Ledger, Dock, HUD) plus the shortcut bar at 200
  cells: no reason or cause text, no BUILDER, no STOPPED; glyph+id for every stopped task (Ledger tree, Dock chips) or
  the selected one (HUD line, Ticker bar part); `5 stopped` count shows.
- Trial: 4 pass, 0 fail, 204 expect() calls (three runs). oxlint 0 warnings; prettier clean; `bun typecheck` shows
  no error in this file (errors only in another verifier's verify-spec-UI2.spec.ts).

## 2026-10-16 OUTCOME (Layer 1+2)
- `update UI9 start`: not_started -> executing.
- Real run 20261016T180416Z-c71492 through the adapter at HEAD c8ffccfee1 (test file untracked, sha256 prefix
  63202e426e09d194): bun exit 0, 4 pass, 0 fail, 0 skip, 204 expect() calls, 39.6 s. Decision: handed-off, exit 0.
- `verify UI9 --evidence=<spec>/evidence/UI9.json`: structural pass (testInCommit false). State completed, trust
  untrusted -> verified ("awaiting semantic verifier").
- Note (not a defect): in every region the failed task's 155-char reason is cut with `…`; the Peek shows it whole.

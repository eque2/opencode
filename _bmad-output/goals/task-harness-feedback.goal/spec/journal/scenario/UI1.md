# UI1 verification journal (eque2-verifier, action: verify, batch UI1-UI5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for UI1. No semantic verdict in this dispatch.
- State at start: UI1 not_started, untrusted. No prior UI1 journal, no test file. `update UI1 start`: not_started ->
  executing.
- Read: the dispatch prompt, guardrails.md, verify-scenario/SKILL.md, spec.md (phase 4, owner rulings), tasks.md T4.2
  and T4.6, packages/tui/src/task-ui/store.ts (columnOf, stoppedGroup, counts, focus, nextRunning, severity, DISPLAY),
  designs/3-board.tsx (cardsIn, BoardView), ui.tsx (trustedText, stoppedText, ShortcutBar), view.ts, machine.ts, the
  tui test helper test/task-ui/view.ts (viewFor), designs.test.tsx and task-ui.test.tsx (the unit tests of T4.2/T4.6),
  packages/opencode/src/task/engine-xstate/machine.ts (CLASS: the harness's class tags of each state).
- Plan:
  1. Write packages/opencode/test/task/verify-spec-UI1.spec.ts. A status with waiting, active (building, proving,
     verifying), trusted, dead (budget exhausted, failed), blocked and cancelled tasks; each task's tags are the tags
     the harness's own CLASS table gives its state. Render the real BoardView over the real taskView actor (tui
     helper `viewFor`) and read each column from the frame; check cardsIn, counts, trustedText/stoppedText, the
     shortcut bar, focus and nextRunning (store and machine). Prove "only from the tags": the same classes with the
     non-active states renamed to names the task-ui does not know, and states that contradict their tags. Scan the
     task-ui sources with the TypeScript AST: no ACTIVE/ENDED name and no list literal of state names.
  2. Trial `bun test` until green; oxlint and prettier clean; one adapter run; `verify UI1`.

## 2026-10-16 OUTCOME (Layer 1+2)
- Test file written: packages/opencode/test/task/verify-spec-UI1.spec.ts (5 tests, each title starts with `[UI1]`).
  (1) A status of 11 tasks (T1.7 waiting, T1.8 ready, T1.2 building, T1.3 proving, T1.6 judging, T1.1 trusted, T1.4
  budget exhausted, T2 failed, T1 and T1.5 blocked, T3 cancelled), tags from the engine's CLASS table, decoded by the
  task-ui `parse`: `cardsIn` and the real BoardView (over the real taskView actor, read from the captured frame) give
  WAITING [T1.7, T1.8], BUILDING [T1.2], PROVING [T1.3], VERIFYING [T1.6], TRUSTED [T1.1], STOPPED [T1.4, T2, T1, T1.5,
  T3] with matching heading counts. (2) STOPPED = dead, blocked, rest, against tree order T1 first; the STOPPED list
  has the same groups. (3) counts {11, 1 trusted, 3 active, 5 stopped}, "1/11 trusted", " · 5 stopped", both in the
  rendered shortcut bar; focus T1.2 (store and machine); nextRunning T1.2 -> T1.3 -> T1.6 -> T1.2 (store and the
  machine's `select.nextRunning`); with nothing active the focus is the first dead task T1.4. (4) Unknown state names
  (non-active states renamed) classify the same, on screen too; states that contradict their tags follow the tags
  (state building + tag ended -> TRUSTED; state failed + tags ended,stopped -> rest group). (5) A TypeScript-AST scan of
  every task-ui source finds no ACTIVE/ENDED name and no list literal of state names; a negative control finds the old
  lists; SEVERITY is a list of tags.
- Trial (load about 20): 5 pass, 0 fail. oxlint 0 warnings (fixed two unsafe assertions), prettier clean, package
  `tsgo --noEmit` clean for the file (fixed a readonly-array type).
- Real run 20261016T175247Z-189395 through the adapter (file untracked, sha256 prefix bc0190fa1255c54b): bun exit 0,
  5 pass, 0 fail, 44 expect() calls, 7.0 s. Decision: handed-off.
- `verify UI1`: structural pass (testInCommit false). State completed, trust untrusted -> verified.

## 2026-10-17 INTENT (semantic trust)
- Check each UI1 step against the real Board render, selectors, and source audit.
- Rerun the focused scenario test, then issue one CLI verdict and record its result.

## 2026-10-17 OUTCOME (semantic trust)
- Focused rerun: 5 pass, 0 fail, 44 assertions. The real Board render and tag-contradiction cases cover classification, grouping, counts, focus and running selection.
- Inspected store and Board source. The source scan only catches array literals and two identifiers, but the observed selectors use tags for classification.
- One CLI verdict: trusted. Prior state completed with trustLevel verified; the verdict response set trustLevel trusted. No material semantic gap.

# UI5 verification journal (eque2-verifier, action: verify, batch UI1-UI5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for UI5. No semantic verdict in this dispatch.
- State at start: UI5 not_started, untrusted. No prior UI5 journal, no test file. `update UI5 start`: not_started ->
  executing.
- Read (beyond UI1-UI4): tasks.md T4.4-T4.8, EXPERIENCE "Outside wait line", shared.tsx (`outsideWaits`,
  `outsideLine`, `outsideCollapsed`, `waitSentences`, SharedRegion), peek.tsx (`builderHeading`, Peek), 3-board.tsx
  (`cardLines`), 1-ledger, 2-dock, 6-hud, 7-ticker, screen.tsx, ui.tsx (ShortcutBar's outside-wait part), the UI5 unit
  tests in designs.test.tsx and shared.test.tsx, core-status.test.ts (a subtree plan's external region).
- Plan:
  1. Write packages/opencode/test/task/verify-spec-UI5.spec.ts over a status in which T1.2 waits on the untrusted
     outside id T9 and the external id T1.1 (decoded by the task-ui `parse`), rendering the real views over the real
     taskView actor (`viewFor`): (a) the Board card and the Peek heading read "waiting on T9 (outside) — run /task trust
     T9" in the warning tone and "waiting on T1.1 (not in this run)" muted, the command never cut on a narrow card;
     (b) for each of the seven designs, its collapsed view (Ledger, Dock segment, full-screen header, HUD) and its
     expanded view (shared region) show the outside line, and its shortcut bar has the part "/task trust T9 outside
     wait"; (c) no render anywhere has a trust command for T1.1; (d) the same texts from the harness's own projection
     of a subtree run (release-notes T1.5: outside T9, external T1.3 and T1.4) through the task-ui.
  2. Trial until green; oxlint, prettier, typecheck clean; one adapter run; `verify UI5`.

## 2026-10-16 OUTCOME (Layer 1+2)
- Test file written: packages/opencode/test/task/verify-spec-UI5.spec.ts (4 tests, each title starts with `[UI5]`).
  Status: a live subtree run, T1.2 waiting with waitingOn [T1.1, T9], waitingOnOutside [T9], outside T9 untrusted,
  external T1.1 untrusted (tags from CLASS), decoded by the task-ui `parse`; every view the real component over the
  real taskView actor (`viewFor`), rendered by `testRender`.
  (1) `cardLines` and `builderHeading`: [outside line, warning], [external line, muted]. The Board at 300 cells shows
  each sentence on its own card line in those tones; at 120 cells the command "/task trust T9" stays whole, no
  "trust…"; the Peek's BUILDER heading holds the outside line, the external line under it 9 cells in; no "trust
  T1.1" anywhere.
  (2) Every design: Ledger collapsed and expanded, Dock collapsed (segment "│ /task trust T9 │") and expanded, the
  full-screen Board, Matrix and Gantt, HUD collapsed (the line wrapped in its 40-cell panel, the command whole) and
  expanded, the Ticker dialog: each shows the outside wait, "/task trust T9" in the warning tone, no T1.1 command; the
  shortcut bar of each of the 7 designs has "/task trust T9 outside wait" in the warning tone.
  (3) With only the external wait: card and Peek read the external line; no view of any design and no bar shows
  "/task trust" or an outside-wait part; the outside wait goes once T9 is trusted or the run has ended.
  (4) The harness's own projection (`TaskStatus.project` over `TaskEngineXState.initial`) of the release-notes T1.5
  subtree (`plan.external` = [T1.3, T1.4]): T1.5 waitingOn [T1.3, T1.4, T9], outside T9 untrusted; the card reads the
  outside line (warning), "waiting on T1.3 (not in this run)" and "waiting on T1.4 (not in this run)" (muted), "proofs
  0/5"; the Board, the Ledger and the bar show the outside wait; no trust command for T1.3 or T1.4.
- Trial 1: 3 pass, 1 fail (the real plan's T1.5 has five obligations: the card adds "proofs 0/5") -> expectation
  extended. Trials 2 and 3: 4 pass. oxlint 0 warnings, prettier clean, package typecheck clean.
- Real run 20261016T181959Z-c0cf47 through the adapter (file untracked, sha256 prefix f4dac768ceac9787): bun exit 0,
  4 pass, 0 fail, 102 expect() calls, 20.1 s. Decision: handed-off.
- `verify UI5`: structural pass (testInCommit false). State completed, trust untrusted -> verified.

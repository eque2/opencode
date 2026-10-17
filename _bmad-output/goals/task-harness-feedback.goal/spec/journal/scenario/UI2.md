# UI2 verification journal (eque2-verifier, action: verify, batch UI1-UI5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for UI2. No semantic verdict in this dispatch.
- State at start: UI2 not_started, untrusted. No prior UI2 journal, no test file. `update UI2 start`: not_started ->
  executing.
- Read (beyond UI1): tasks.md T4.1 and T4.3, packages/tui/src/task-ui/index.tsx (the plugin entry: one taskView
  actor per instance), machine.ts (regions feed, expansion, watch, stopKey, liveness, sessions, activity, tail; delays
  feed 1000, sessions 2000, activity 1500, tail 500, stopWindow 5000), view.ts, actor.ts, watch.tsx (registerWatch,
  liveTail, the esc layer), peek.tsx (liveSessions), ui.tsx (barKeys, registerTab, ShortcutBar), the tui tests
  plugin.test.tsx, machine.test.ts and task-ui.test.tsx (the T4.1/T4.3 unit tests), test/fixture/tui-plugin.ts.
- Plan:
  1. Write packages/opencode/test/task/verify-spec-UI2.spec.ts:
     (a) the real plugin entry `TaskUi.tui` loaded on the session route ses_root with opencode's keymap and the host
         slot registry; real keys switch the design (ctrl+x v), select (ctrl+x j), expand (ctrl+x o), watch (ctrl+x w)
         and press esc once; then esc after 5 s warns again (disarmed), a quick second esc stops the run; a status
         text "{" keeps the last status on screen, a deleted file clears it;
     (b) the real taskView machine (its own feed read on a temp status.json, SimulatedClock) with `viewOf`: the same
         acts are states (expansion, watch, stopKey) and context (design, chosen, target) of one snapshot; the view
         reads them back; the stop key disarms at 5 000 ms, not 4 999; one actor and one signal in the sources;
     (c) the delays table and the delayed transitions; the status read every 1 s, the session list every 2 s and the
         activity lines every 1.5 s through `liveSessions` (counting SDK requests), the proof tail every 500 ms
         through `liveTail` on a real file;
     (d) a text that does not parse keeps the last good status (machine and view).
  2. Trial until green; oxlint, prettier and the package typecheck clean; one adapter run; `verify UI2`.

## 2026-10-16 OUTCOME (Layer 1+2)
- Test file written: packages/opencode/test/task/verify-spec-UI2.spec.ts (4 tests, each title starts with `[UI2]`).
  (1) The real plugin entry `TaskUi.tui` on the route of ses_root (opencode keymap, host slot registry, a real SDK
  client over a recording fetch, one harness session "T1.3 builder"): ctrl+x v six times -> bar "In the Flow Ticker",
  kv task_ui_design 7; the bar names the focus "◐ T1.2 building"; ctrl+x j -> "◑ T1.3 proving"; ctrl+x o -> "ctrl+x o
  collapse"; ctrl+x w -> route {sessionID ses_root, watch ses_harness_0} and the watch keys; esc once -> "Press esc
  again to stop the run"; after 5.3 s esc warns again with no abort (disarmed); a quick second esc aborts ses_root and
  toasts the restart line; status text "{" keeps the bar and the selected task; a deleted file clears the bar.
  (2) The real taskView machine (own feed read of a temp status.json, SimulatedClock) and `viewOf`: root is one
  parallel machine with regions feed, expansion, watch, stopKey, liveness, sessions, activity, tail; after design.set
  4, select T1.3, expand.toggle, watch.set on, watch.target, stop.key: one snapshot has expansion expanded, watch on,
  stopKey armed and context design 4, chosen T1.3, target ses_harness_0; the view reads them back; armed at 4 999 ms,
  disarmed at 5 000 ms with no stop; a second press within the window emits stop.run; watch off clears target. The
  task-ui sources hold one `createActor(` (index.tsx, on TaskView.machine) and one `createSignal(` (actor.ts).
  (3) `implementations.delays` = feed 1000, sessions 2000, activity 1500, tail 500, stopWindow 5000, and each region's
  `after` names its delay; the status file re-read at 1 000 ms not 999; the proof tail (`liveTail`, real file) at 500;
  the activity lines (`liveSessions`, counted SDK requests) at 1 500 not 1 499; the session list at 2 000 not 1 999;
  after 4 000 ms the ticks are sessions 2, activity 2, tail 8. (4) Texts "{", "" and '{"run":{}}' each keep the last
  good status (context and view) and the liveness; a good text replaces it; a gone file gives none and `absent`.
- Fixes during trials: the design-switch toasts are counted before the esc checks; the bar line is found by the name
  " In the Flow " because the diamond is a spinner while live. oxlint 0 warnings, prettier clean, package typecheck
  clean (Show `keyed: true` for createComponent's overload, kv.get with a fallback).
- Trials (load 20 to 130): 4 pass twice. Real run 20261016T180552Z-2a2f65 through the adapter (file untracked, sha256
  prefix eaa9252d4ba70afe): bun exit 0, 4 pass, 0 fail, 81 expect() calls, 25.7 s. Decision: handed-off.
- `verify UI2`: structural pass (testInCommit false). State completed, trust untrusted -> verified.

## 2026-10-17 INTENT (semantic trust)
- Rerun UI2 and inspect plugin-to-actor wiring, not only the independent machine test.
- Decide whether the real-key assertions and source check prove one machine owns view state.
- Issue one CLI verdict and record any precise gap.

## 2026-10-17 SEMANTIC GAP (before verdict)
- The real plugin key test checks visible results, but it never observes the actor created by `TaskUi.tui` or the snapshot after those keys.
- The snapshot test creates a separate actor with `machineOver` and sends synthetic events directly. It proves the machine can hold those values, not that the plugin's keys dispatch to that same actor.
- The source check counts `createActor(` and `createSignal(` text and checks one constructor line. It does not assert that the plugin's design, selection, expansion, watch and stop-key handlers read and send through `viewOf(actor)` without parallel state.
- The cadence test builds `liveSessions` and `liveTail` over its separate actor. It cannot prove that the plugin's installed readers use those delayed transitions for all four feeds.
- Thus the scenario's one-machine and plugin-cadence claims can survive a disconnected actor or parallel plugin state. Reject UI2 despite the green focused run.

## 2026-10-17 OUTCOME (semantic trust)
- Focused rerun: 4 pass, 0 fail, 81 assertions. The real plugin keys, separate machine snapshots, 5-second disarm, simulated read cadences and parse retention passed.
- Inspected index.tsx, view.ts and actor.ts. The current product source wires the actor correctly, but the scenario assertions do not bind plugin actions to the actor snapshot.
- One CLI verdict: rejected. The prior state was completed with trustLevel verified; the verdict response set trustLevel suspect. The gap is D15 in defects.md.

## 2026-10-17 INTENT (fresh Layer 1+2 after D15 repair)
- Query returned completed / suspect. Do not start or mint a semantic verdict.
- Inspect the committed f0027830d7 test-only repair and its scoped `viewOf` spy. It calls the original view adapter and restores the spy after plugin setup.
- Run root-pinned oxlint and Prettier, then a package Bun trial. On a pass, run the existing JUnit adapter once and consume its signed result with `state.mjs verify UI2`.
- Record the CLI state and trustLevel. Leave the semantic decision to the separate verifier.

## 2026-10-17 OUTCOME (fresh Layer 1+2 after D15 repair)
- Read guardrails, the verify-scenario skill, spec.md, UI2 Gherkin, T4.1/T4.3 tasks and journals, D15, the committed test, plugin index and view. The spy wraps `viewOf(actor)`, calls the original with that same actor, returns its view and restores itself after plugin setup.
- Root-pinned oxlint: 0 warnings, 0 errors. Prettier: matched. Package trial: 5 pass, 0 fail, 110 assertions, 22.20 s.
- Adapter run `20261017T141604Z-dba7c2`: Bun JUnit 5 pass, 0 fail, 110 assertions, exit 0; reporter handed off signed UI2 evidence. Adapter decision `handed-off`.
- `state.mjs verify UI2 --evidence=…/evidence/UI2.json`: structural file/pattern/execution/pass checks true, trust `suspect` → `verified`; `testInCommit` false is reported by the CLI. Query returned state `completed`, trustLevel `verified`.
- No test or source edit, manual state edit, semantic verdict or commit. The separate semantic verifier must decide whether the repaired assertions close D15.

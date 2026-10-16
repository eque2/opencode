# UI3 verification journal (eque2-verifier, action: verify, batch UI1-UI5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for UI3. No semantic verdict in this dispatch.
- State at start: UI3 not_started, untrusted. No prior UI3 journal, no test file. `update UI3 start`: not_started ->
  executing.
- Read (beyond UI1, UI2): machine.ts `livenessOf` and the `liveness` and `stopKey` regions, ui.tsx `registerTab`,
  watch.tsx `registerWatch` (the toggle and the esc layer check `view.live()` and `ctx.owns()`), the T4.3 unit tests
  in task-ui.test.tsx and plugin.test.tsx, owner ruling 5 ("Show it as still"), `@ASSUMPTION:A2.a`.
- Plan:
  1. Write packages/opencode/test/task/verify-spec-UI3.spec.ts:
     (a) liveness through the real taskView machine: the exact 15 000 / 15 001 ms boundary (the tui helper `viewFor`,
         whose read gives the clock), and with its own feed read of a real status.json and the real clock: live,
         still (old heartbeat, none at all), ended (the ended tag, even with a fresh heartbeat; a refused run),
         absent (no file); a heartbeat that ages past 15 s turns the view still;
     (b) the real plugin entry on a session route with a heartbeat that the test keeps writing (as the harness's status
         writer does): with the root owning a harness session, Tab selects, ctrl+x w watches, esc twice stops;
     (c) the same keys leave the run alone (Tab reaches the agent key, no watch, no toast, no abort) when the root owns
         no harness session, when the heartbeat is a minute old, when the run has ended, and with no status file;
         and a stop key armed while live does nothing once the view is no longer live.
  2. Trial until green; oxlint, prettier, typecheck clean; one adapter run; `verify UI3`.

## 2026-10-16 OUTCOME (Layer 1+2)
- Test file written: packages/opencode/test/task/verify-spec-UI3.spec.ts (4 tests, each title starts with `[UI3]`).
  (1) Liveness on the real taskView machine: through `viewFor` (real machine, the read gives the clock) a heartbeat 0
  and 15 000 ms old is live, 15 001 and 60 000 ms still; no heartbeat still; the ended tag ended even with a fresh
  heartbeat (budget_exhausted, done, refused); no status absent; LIVE_MS is 15 000. With the machine's own feed read
  of a real status.json and the real clock: no file absent, then live after the file appears; 5 s old live, a minute
  old still, no heartbeat still, ended ended; a heartbeat 13 s old turns still at a read 2.5 s later, live again on a
  fresh heartbeat, ended on the ended tag, absent when the file goes.
  (2) The real plugin entry on ses_root (design 7, opencode keymap and agent key, real SDK client over a recording
  fetch, harness session "T1.3 builder"), the status file rewritten every 500 ms with a fresh aliveAt: the bar offers
  Tab; Tab selects T1.3 (agent key not reached); ctrl+x w navigates to {ses_root, watch ses_harness_0}; esc twice
  aborts ses_root and toasts the restart line; Tab in the watch view selects the next task in work.
  (3) The same keys (Tab, ctrl+x w, esc, esc) leave the run alone - Tab reaches the agent key, the bar does not
  change, no navigation, no toast, no abort - when the root owns no harness session (live), when the heartbeat is a
  minute old or absent (still; the bar offers ctrl+x j/k), when the run has ended, and with no status file (nothing
  shown).
  (4) The stop key does not arm while still or ended (two presses, nothing heard); armed while live, a second press
  after the heartbeat went stale or the run ended stops nothing; while live the second press stops.
- Fixes during trials: the bar is compared from the name on (the diamond spins while live). Typecheck fix: the cases
  table typed with `Liveness`. oxlint 0 warnings, prettier clean, package typecheck clean.
- Trials: 4 pass twice (load 40 to 80). Real run 20261016T181141Z-b1d346 through the adapter (file untracked, sha256
  prefix 9f22a84484bc1535): bun exit 0, 4 pass, 0 fail, 71 expect() calls, 13.1 s. Decision: handed-off.
- `verify UI3`: structural pass (testInCommit false). State completed, trust untrusted -> verified.

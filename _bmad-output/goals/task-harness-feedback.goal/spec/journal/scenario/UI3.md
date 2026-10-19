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

## 2026-10-17 INTENT (semantic trust)
- Check the heartbeat boundary and each run-key permission case against real plugin actions.
- Rerun the focused test, issue one CLI verdict, and record the outcome.

## 2026-10-17 OUTCOME (semantic trust)
- Focused rerun: 4 pass, 0 fail, 71 assertions. The heartbeat threshold, disk feed, positive plugin keys, and negative permission and liveness cases cover the steps.
- One CLI verdict: trusted. Prior state completed with trustLevel verified; the verdict response set trustLevel trusted. No semantic gap found.

## 2026-10-19 INTENT (structural re-verify after 162ce61dee)
- Action: verify (Layer 1+2) only. No verdict, no `update start` (UI3 is completed, trustLevel trusted at query).
- Commit 162ce61dee added a local `until` helper (up to 100 settles) before three positive checks in the
  "stop key arms only while live" case; the source hash changed, so the evidence must be refreshed.
- Plan: read the Gherkin and the changed case; confirm with `git show 162ce61dee` that no assertion changed;
  run root-pinned oxlint (from the repository root) and Prettier on the file; one focused `bun test` trial in
  packages/opencode; one fresh adapter run (runs dir journal/adapter/runs/UI3); `verify UI3` with the new evidence.
  No source, test, or state edit; no commit.

## 2026-10-19 OUTCOME (structural re-verify after 162ce61dee)
- `git show 162ce61dee`: 9 added lines, 0 removed, in the "stop key arms only while live" case only. A local
  `until` (up to 100 `settle()` calls) runs before three positive checks: the warn after the first press, the new
  liveness after `advance(1_000)`, and the ["warn", "run"] stop while live. Each waits for the same condition that
  the unchanged `expect` then checks. The checks that nothing happened (still/ended presses, the second press after
  the view left live) keep the single settle inside `press()`. Intended behaviour is unchanged. The test file is
  committed and clean at HEAD 162ce61dee.
- Root oxlint 1.60.0 `--deny-warnings` (run from the repository root): 0 warnings, 0 errors. Prettier 3.6.2
  `--check`: clean.
- Trial (packages/opencode, load about 12-15): 4 pass, 0 fail, 71 expect() calls, 16.7 s.
- Adapter run 20261019T110041Z-7b5b6e: bun exit 0, tests=4 pass=4 fail=0 skip=0, decision handed-off, exit 0;
  the reporter wrote signed passing evidence for UI3.
- `verify UI3`: exit 0; structural testFileExists, testPatternFound, testExecuted, testPassed true; testInCommit
  false. Trust trusted -> verified ("awaiting semantic verifier"). Query after: state completed, trustLevel verified.
- No gap found. A separate fresh verifier rejudges semantics.

## 2026-10-19 INTENT (semantic trust after 162ce61dee)
- Action: verify-scenario-trust. Query at start: state completed, trustLevel verified. No `update start`.
- Plan: read the current Gherkin (scenarios.gherkin, spec.md), the committed test, `git show 162ce61dee`, and the
  real code the test drives (task-ui machine.ts liveness and stopKey, ui.tsx registerTab, watch.tsx stop and watch
  keys, index.tsx plugin entry). Judge whether the bounded `until` waits can hide a failure. Rerun the focused test
  from packages/opencode. Issue exactly one CLI verdict through verification-runner.py. No source, test, or state
  edit; no commit.

## 2026-10-19 OUTCOME (semantic trust after 162ce61dee)
- Test file clean at HEAD 162ce61dee. `git show 162ce61dee`: 9 added lines, 0 removed, only in the stop-key case.
- The `until` waits cannot hide a failure. Each wait stops on the expected positive change, or after 100 settles,
  and the unchanged exact `toEqual` then runs. A missing event or an extra event still fails. The SimulatedClock
  does not move during a real-time wait, so the 5 s `stopWindow` cannot disarm the key. The disarm stays
  attributable to the `armed.always` liveness guard (machine.ts 266).
- Residual note (not new): the negative checks keep one 15 ms settle. A late wrong emit under heavy load can escape
  one run. An unloaded run catches it, and the machine unit tests kill the same mutations.
- Focused rerun (packages/opencode, load about 13-15): 4 pass, 0 fail, 71 expect() calls, 15.86 s.
- One CLI verdict through verification-runner.py: trusted, exit 0. Query after: state completed, trustLevel trusted.

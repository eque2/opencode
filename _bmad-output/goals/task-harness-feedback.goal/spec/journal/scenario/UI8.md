# UI8 verification journal (eque2-verifier, action: verify, batch UI7-UI24)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario UI8. No semantic verdict in this dispatch.
- State at start: UI8 not_started, untrusted. No prior UI8 journal. `update UI8 start` -> executing.
- Read: as UI7 (T4.11, summary/workers/run supervisor/prompt `say`), plus `SessionRunState.cancel` (it cancels the
  background jobs whose parentSessionId is the session) and TaskLimits (live cancelDeadline 5 s).
- No sibling verify spec covers UI8; write packages/opencode/test/task/verify-spec-UI8.spec.ts, titles `[UI8]`.
- Plan: the product wiring of UI7 (SessionPrompt's graph, `TaskHarness.Service`, `/task` via SessionPrompt.command,
  real background jobs). The stored whole-spec slice leaves S4 waiting for its judge; the judge's scripted reply is
  held, and the root session gets a user question whose model reply is held (a turn in flight). Three tests, one per
  When: (a) the judge's verdict ends the run, (b) the user aborts the root session (`SessionPrompt.cancel`, which
  also cancels the /task job), (c) the job is cancelled (`BackgroundJob.cancel`). Each asserts: no summary while the
  turn runs, then exactly one summary after the turn ends, no logged summary failure, and a later user prompt runs a
  model turn. D10 (UI7) predicts a failure; a trial with `say` in the instance context checks the test itself.

## 2026-10-16 OUTCOME (verify consumed failing evidence)
- Wrote packages/opencode/test/task/verify-spec-UI8.spec.ts (3 tests, titles `[UI8]`): (a) the run ends while a root
  turn is in flight, (b) the user aborts the root session, (c) the run's job is cancelled (forked, since the cancel
  returns only after the job's finalizers). oxlint, prettier and `bun run typecheck` clean.
- Each test: the summary is absent while the root turn runs and no summary failure is logged; after the turn ends (or
  is aborted), one summary, answering the header, last in the transcript; a later prompt gets its model answer.
- Trial with D10 bypassed (`say` in the instance context; trial only): (a) and (c) pass; (b) fails, "the closing
  summary was dropped" -> defect D11 (SessionRunState.cancel awaits the job's cancel before it cancels the turn).
  Test-only fixes found by the trial: the S4 verdict check (the slice holds other scenario.verified facts) and the
  forked job cancel.
- Product run, adapter 20261016T221641Z-a00389: exit 1; 3 tests, 0 pass, 3 fail; each logs "the closing summary could
  not be written: Error: InstanceRef not provided" (D10).
- `verify UI8 --evidence=…`: exit 0; testPassed false; untrusted -> untrusted. Query after: not_started, untrusted.

## 2026-10-17 INTENT (fresh verification)
- State: not_started, untrusted, retryCount 1. D10 and D11 were fixed in e63744e21b and e2cb2bb1f0.
- Keep all three committed cases and assertions. Run a focused trial, formatting and lint checks, then the adapter and CLI verify.
- Record structural evidence only; another verifier decides semantic trust.

## 2026-10-17 OUTCOME
- Trial: 3 pass, 0 fail (52.89 s). Prettier passed. Oxlint did not parse the committed `.oxlintrc.json` (`options.typeAware` nesting).
- Adapter run `20261017T091529Z-f4d797`: 3 pass, 0 fail, exit 0; reporter produced signed evidence.
- `verify UI8`: all structural checks passed; trust untrusted → verified. Query: state completed, trustLevel verified.
- Three cases cover normal run end, root abort, and job cancellation during a root turn, followed by one summary and a later model turn. No scenario coverage gap found.

## 2026-10-17 INTENT (independent semantic review)
- CLI reports completed / verified. Read the full three-case test and the T4.11 summary contract. Run the file and check each distinct end path, turn-order assertion, single summary and later model request. Issue one CLI verdict; do not edit tests or source.

## 2026-10-17 OUTCOME (independent semantic review)
- Three tests passed with 48 assertions. Each end path runs through the product boundary, and the root model turn is held by a gate. The summary order, single write and later model hit are asserted in each path. Called `verdict UI8 trusted` once; CLI query reports state completed, trustLevel trusted. No Gherkin gap found.

## 2026-10-19 INTENT (re-verification after 688450d923)
- State at start: completed, trusted. Do not run `update UI8 start` (completed scenario).
- 688450d923 changed only the committed test: `runFinal` polls the lease and the stored facts (no fold every 20 ms), each of
  the two cases that use it asserts once that the folded slice is ended; bound 60 s -> 120 s, test timeouts 180 s -> 300 s.
- Plan: check with `git show 688450d923` that the behaviour and every assertion stay; run root-pinned oxlint and Prettier;
  one focused trial; one fresh adapter run; `verify UI8` with the new evidence. No edits to source, test or state; no commit.

## 2026-10-19 OUTCOME (re-verification after 688450d923)
- `git show 688450d923`: only verify-spec-UI8.spec.ts changed. `runFinal` now waits for a free lease and the `last` fact
  and returns the slice; new `ended(flight, slice)` asserts the folded slice is ended (run-ends case right after
  `runFinal`, cancel case after `closed`, on the same captured slice). Every other assertion and the three When paths
  are unchanged; bound 120 s, test timeouts 300 s. No product code changed.
- Root-pinned oxlint 1.60.0 `--deny-warnings` (from the repository root): 0 warnings, 0 errors. Prettier 3.6.2: clean.
- Trial (load ~17): 3 pass, 0 fail, 50 expect() calls, 43.03 s.
- Adapter run `20261019T115122Z-1ff91b`: 3 pass, 0 fail, bunExit 0, decision handed-off, adapter exit 0; signed evidence.
- `verify UI8`: exit 0; structural testFileExists/testPatternFound/testExecuted/testPassed true (testInCommit false);
  trust trusted -> verified. Query: completed, verified. Semantic rejudgement is left to a separate verifier.

## 2026-10-19 INTENT (independent semantic review after 688450d923)
- State at start: completed, verified (structural run 20261019T115122Z-1ff91b). Fresh-context trust dispatch.
- Read the current Gherkin, `git show 688450d923`, the whole committed test, and the real code it drives: the lease
  release after the final snapshot (SD-19) in src/task/core/supervise/run.ts and harness.ts, and the summary step.
- Judge: can a free lease plus the last stored fact let a case pass while the run machine is not final, or before the
  summary step? Does every Gherkin step stay covered?
- Rerun the focused test from packages/opencode. Issue exactly one CLI verdict for UI8 through verification-runner.py.
  No edits to source, test or state; no commit.

## 2026-10-19 OUTCOME (independent semantic review after 688450d923)
- The test file is identical to 688450d923. The commit changed only `runFinal` (lease + `last` fact, returns the slice),
  added `ended(flight, slice)`, and raised the bounds. Every other assertion and all three When paths are unchanged.
- Lease soundness: the lease is freed only by (a) the supervisor's `finish` (after the run actor left `active` and the
  writer ended; `summarizing` follows), (b) `closing` after a failed start, or (c) the job scope finalizer. (c) runs
  last, after the cancel finalizer (`untilClosed` or the 5 s deadline, then `removeRun`). Run-ends case: `latestRun`
  already holds S1-S12 `scenario.verified`, so the wait is the lease alone; only (a) applies, so the summary step is next.
  Cancel case: a release by the deadline path drops the summary, and the summary-log and one-summary checks fail it.
  A not-final machine fails `ended(slice)`. The Recorder stores a fact before it applies it, so the stored slice
  matches the actor. No false pass found.
- Every Gherkin step stays covered (Given: held judge + held root turn, busy; When: three paths; Then: no summary in the
  window, then exactly one summary after the turn, answering the header; And: a later prompt gets a model turn).
- Rerun (load 26): 3 pass, 0 fail, 50 expect() calls, 32.39 s.
- `verdict UI8 trusted` through verification-runner.py: exit 0, trustLevel trusted. Query: completed, trusted.
- Residual (not a gap): the "waits" window is time-based (1 s / 0.5 s), as in the earlier trusted version.

## 2026-10-19 INTENT (re-verification after cfc1bb0948, owner ruling 10; batch UI8, RM19)
- State at start (query 22:03 local): completed, trusted. Do not run `update UI8 start` (completed scenario).
- Cause: cfc1bb0948 raised only time bounds in the committed test (judge wait 60 s -> 240 s, root-turn wait 30 s ->
  120 s, run's-end and close waits -> 240 s, each test 300 s -> 900 s); the source hash changed, so the evidence
  must be refreshed.
- Plan: read the Gherkin and goal.md rulings 8 and 10; check with `git show cfc1bb0948` that only bounds changed;
  run root-pinned oxlint (from the repository root) and Prettier; one focused trial; one fresh adapter run;
  `verify UI8` with the new evidence. No edits to source, test or state; no evidence or key reads; no commit.

## 2026-10-19 OUTCOME (re-verification after cfc1bb0948)
- `git show cfc1bb0948`: only verify-spec-UI8.spec.ts changed. Five `pollWithTimeout` bounds (judge 60 s -> 240 s,
  root turn 30 s -> 120 s, `runFinal` 120 s -> 240 s, `closed` 60 s -> 240 s) and three test timeouts (300_000 ->
  900_000), plus one comment that cites owner ruling 10. Every `expect`, the Given, the three When paths and the
  1 s / 0.5 s windows are unchanged. The file at HEAD equals cfc1bb0948; src is clean.
- goal.md ruling 10 allows a larger time bound for a load-only failure with no assertion change; the diff matches it.
- Root-pinned oxlint 1.60.0 `--deny-warnings` (repository root): 0 warnings, 0 errors. Prettier 3.6.2: clean.
- Trial (load ~36-40): 3 pass, 0 fail, 50 expect() calls, 50.03 s.
- Adapter run `20261019T210517Z-990e42`: 3 pass, 0 fail, bunExit 0, 73.93 s, decision handed-off, adapter exit 0;
  the reporter wrote signed evidence for UI8.
- `verify UI8`: exit 0; testFileExists/testPatternFound/testExecuted/testPassed true (testInCommit false); trust
  trusted -> verified. Query: completed, verified. A separate verifier rejudges semantics. No gap.

## 2026-10-19 INTENT (independent semantic review after cfc1bb0948; batch UI8, RM19)
- State at start (query 22:12 local): completed, verified. Fresh-context trust dispatch; do not run `update UI8 start`.
- Read the current Gherkin, goal.md rulings 4, 8 and 10, `git show cfc1bb0948`, the whole committed test and the real
  code it drives (summary step, lease release, prompt `say`, session cancel, job cancel).
- Judge each Gherkin step's coverage, and whether a larger bound can hide a failure (a bound must only wait for an
  expected change or end a hang). Rerun the focused test from packages/opencode (host load ~62-80).
- Issue exactly one CLI verdict for UI8 through verification-runner.py. No edits to source, test or state; no evidence
  or key reads; no commit.

## 2026-10-19 OUTCOME (independent semantic review after cfc1bb0948)
- `git show cfc1bb0948`: only the four `pollWithTimeout` bounds (judge 240 s, root turn 120 s, `runFinal` 240 s,
  `closed` 240 s), three test timeouts (900 s) and one comment changed. HEAD equals the working tree for packages/.
- Each bound waits for a positive progress signal (a model hit, a free lease plus the last fact, a closed job) or ends
  a hang. No bound covers a negative check: the 1 s / 0.5 s no-summary windows, `summaryLog`, the one-summary count
  and the order checks are unchanged. A dropped summary or a hang still fails. No false pass found.
- Code read: the run supervisor goes `finishing` (writer awaited, lease released) -> `summarizing` -> `closed`;
  `TaskWorkers.summary` logs a failure or a drop; `SessionPrompt.say` waits through `ensureRunning` until it wrote.
- Every Gherkin step stays covered (Given: held judge and held root turn, busy; When: run end, root abort, job cancel;
  Then: no summary while the turn runs, then exactly one, last, answering the header; And: a later prompt gets a model
  turn and the count stays 1).
- Rerun (load 43-66): 3 pass, 0 fail, 50 expect() calls, 73.67 s.
- `verdict UI8 trusted` through verification-runner.py: exit 0, trustLevel trusted. Query: completed, trusted.

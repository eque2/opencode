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

# VF5 verification journal (eque2-verifier, action: verify, batch VF1-VF5)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for scenario VF5, the last of the batch. No semantic verdict here.
- State at start: VF5 not_started, untrusted, retryCount 0. No prior VF5 journal.
- Sources: scenarios.gherkin VF5 (@ASSUMPTION:A3.a), tasks.md T3.3 (State Transitions, Boundary, SD-15 texts), the
  T3.3 journal, workers.ts `staleCheck`/`idChanges`, supervise/run.ts, machine.ts `check`, status.ts.
- Plan: no sibling verify spec covers VF5, so write packages/opencode/test/task/verify-spec-VF5.spec.ts. To count
  stale checks exactly, run the REAL `RunSupervisor.machine` (no actor overrides) as a root actor on a SimulatedClock,
  with a real Recorder (`runOf`, `writes: true`, so the real status writer writes status.json) over a temp copy of
  release-notes.spec whose T1.1 and T1.2 are after the outside T9 (no unit supervisor spawns). Each check is one
  clock step of the 1 s cadence. Steps: break T1.3 VERIFY.md (two failures) -> warning of two; restore -> spec.checked
  with no failures, warning gone in the view and status.json, history entry; same failures again -> nothing recorded
  (with a control that a changed list records); a valid reload that adds T1.3.c9 or removes T1.3.c4 -> a spec.checked
  failure with the SD-15 line, and the supervisor keeps the old text. Trial with bun test, then `update VF5 start`,
  one adapter run, `verify VF5`.
- Never read or write evidence or key files; never edit the reporter, the state CLI or any source file; commit nothing.

## 2026-10-16 OUTCOME (test file written)
- Wrote packages/opencode/test/task/verify-spec-VF5.spec.ts (3 tests, each title starts with `[VF5]`, no describe).
- The run is the real `RunSupervisor.machine` (no actor replaced) on a SimulatedClock, with a real Recorder that
  writes status.json (`runOf`, `writes: true`) and the real stale-check worker reading a temp copy whose T1.1 and
  T1.2 are after T9. One check = one 1 s clock step, observed as `staleCadence` checking -> waiting.
- Assertions. Given: two R3 faults in T1.3 VERIFY.md give one spec.checked with the two loader lines, the view
  warning and status.json warning (two lines). Test 1: restore -> stored spec.checked list is [two lines, []], the
  last fact has `failures: []`, the view warning is undefined, status.json has no `warning` key, the run history is
  ["spec.checked: 2 failures", "spec.checked: no failures"], the supervisor is still running. Test 2: three more
  checks with the same two failures record nothing and keep the warning; control: one fault fixed records the new
  one-line list on the next check; a valid spec after a valid check records nothing. Test 3: a valid reload that adds
  T1.3.c9 (and changes c1's text) records exactly the SD-15 line "obligation T1.3.c9 is not in the loaded plan; the
  run keeps the plan it loaded"; one that removes T1.3.c4 records "obligation T1.3.c4 of the loaded plan is missing;
  ..."; each time the supervisor keeps the old c1 text and the old obligation ids; no obligation.stale; the same
  id-change failure again records nothing; status.json shows the id-change warning.
- Trial 1: 3 pass, 62 expect() calls. tsgo then found a type error in the TEST (node `path` passed where
  `TaskStatus.file` takes the Effect `Path` service). Fixed with `yield* Path.Path`. Trial 2: 3 pass, 0 fail.
  tsgo clean; oxlint 0 warnings; prettier --write once (new file), then clean.

## 2026-10-16 OUTCOME (Layer 1+2)
- `update VF5 start`: not_started -> executing.
- Real run 20261016T122441Z-17c4e3 through the adapter (HEAD 9ae952134b after the orchestrator's commits during the
  batch; the VF5 file untracked, sha256 prefix 545485e95d20921b): bun exit 0, 3 pass, 0 fail, 0 skip, 62 expect()
  calls, 8.9 s. Decision: handed-off, exit 0.
- `verify VF5 --evidence=<spec>/evidence/VF5.json`: structural pass (testInCommit false, as expected).
  State completed, trust untrusted -> verified ("awaiting semantic verifier").
- Run artefacts: scratchpad/adapter/runs/VF5/20261016T122441Z-17c4e3/{junit.xml,run.log,run.json,mapped.json}.
- No gap found in the code for VF5.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context semantic verifier)
- Action: Layer 3 semantic trust for VF5. State at start: completed, trustLevel verified.
- Plan: read verify-spec-VF5.spec.ts and the code it drives (RunSupervisor.machine, staleCheck/idChanges, the machine
  `check` action, the status projection); judge each Gherkin step; run the file myself; then one `verdict VF5`.
- I judge only; I change no source or test file; I read no evidence or key file; I commit nothing.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Read: the test file (committed in 3789623276), test/task/lib/supervise.ts `runOf` (real TaskRecorder, real writer
  with `writes: true`), workers.ts `staleCheck`/`idChanges`, the machine `check` action, tasks.md T3.3 (SD-15 texts).
- Own run: `bun test --timeout=30000 ./test/task/verify-spec-VF5.spec.ts` in packages/opencode: 3 pass, 0 fail,
  62 expect() calls, 18.1 s.
- Every Gherkin step has an exact assertion; each "records nothing" check follows an observed real stale check, and
  controls show a changed list is recorded.
- Verdict: `verdict VF5 trusted` -> trustLevel trusted. No gap.

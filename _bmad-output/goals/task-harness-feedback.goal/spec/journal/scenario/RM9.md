# RM9 verification journal (eque2-verifier, action: verify, batch RM7, RM8a, RM8b, RM8c, RM9)

## 2026-10-16 INTENT (start)
- Action: verify (Layer 1+2) for RM9 only. No semantic verdict in this dispatch.
- State at start: RM9 not_started, untrusted, retryCount 0. No prior RM9 journal.
- No sibling verify spec covers RM9 (engine-xstate.test.ts has an RM9 unit test on the release-notes plan, not the
  T1 -> T2 -> T3 plan of the Gherkin). I write the registered file packages/opencode/test/task/verify-spec-RM9.spec.ts.
- Plan: the test writes a small blend spec folder in a temporary directory (T2 after T1, T3 after T2, S1 needs T3,
  plus T4 after T1, T5 after [T4, T2] and T6 after [T2, T4] for the two-dead-dependencies step, so dependency order
  differs from id order), loads it with the real loader (`Blend.load`, `TaskCommand.plan`), then folds run.started,
  task.started T1 and one `apply` of task.failed T1 through the engine API, and reads the selectors, `view` and the
  status projection.
- Write only the test file; no source edit; commit nothing; never read evidence or key files.

## 2026-10-16 OUTCOME (test file written, Layer 1+2)
- Wrote packages/opencode/test/task/verify-spec-RM9.spec.ts: 4 tests, each title starts with `[RM9]`, no describe.
- The test writes a temporary spec folder `rm9-chain.spec` (SPEC.md, six top-level leaves T1-T6 with TASK.md and
  VERIFY.md, acceptance/S1.md) and loads it with `Blend.load` and `TaskCommand.plan`; the loader refused the first
  draft with R3 ("'refs' is a required property"), so SPEC.md carries one ref. No repository file is written.
- Assertions: T2 after [T1], T3 after [T2], S1 needs [T3], T5 after [T4, T2], T6 after [T2, T4] (loader order); before
  the failure every dependant waits with no cause. After one `apply` of task.failed T1: T2 blocked by { T1, failed },
  T3 blocked by { T2, blocked }, S1 blocked by { T3, blocked }, each with exactly one history entry of that step and
  its "blocked by ..." reason, in cascade order; the status projection carries S1's cause; the run ends failed (every
  region final). Two dead dependencies: T2 and T4 die in one microstep; T5 names T4 (first in dependency order, not
  in id order) and T6 names T2, in the selector, the history and the status projection.
- Trial runs: 4 pass, 0 fail, 50 expect() calls, about 9-12 s (twice, the machine is loaded). tsgo clean, oxlint 0
  warnings, prettier clean (new file).
- `update RM9 start`: not_started -> executing.
- Real run 20261016T121954Z-db6cc6 through the adapter at HEAD 62554af3aa (test file untracked, sha256 prefix
  9006533db5ab9fbd): bun exit 0, 4 pass, 0 fail, 0 skip, 50 expect() calls. Decision: handed-off, adapter exit 0.
- `verify RM9 --evidence=<spec>/evidence/RM9.json`: structural pass; testInCommit false, as expected. State
  completed, trust untrusted -> verified.
- No gap found in the code for RM9.

## 2026-10-16 INTENT (verify-scenario-trust, fresh-context Layer 3 reviewer, batch RM7, RM8a, RM8b, RM8c, RM9)
- Action: judge RM9 afresh and call `verdict RM9` once. State at start: completed, trust verified.
- Plan: read the committed test file and the code it drives; map each Gherkin step, including "the same fold step"
  and "dependency order"; run the file with bare `bun test`. No edit; commit nothing; no evidence or key reads.

## 2026-10-16 OUTCOME (verify-scenario-trust)
- Read the test file (committed b9553cc37d, no later change) and src/task/engine-xstate/machine.ts (`DEAD` includes
  `blocked`; `blockRows` emit rows in dependency order; `dependenciesOf` = afterEffective, then children).
- Own run: `bun test --timeout=30000 ./test/task/verify-spec-RM9.spec.ts` -> 4 pass, 0 fail, 50 expect() calls.
- Every Gherkin step has a discriminating assertion: one apply, before/after contrast, history order, and T5 after
  [T4, T2] naming T4 (dependency order, not id or region order). No gap.
- `verdict RM9 trusted`: trustLevel trusted.

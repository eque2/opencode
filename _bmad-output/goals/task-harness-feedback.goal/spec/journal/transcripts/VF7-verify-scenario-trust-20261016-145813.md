# VF7 — verify-scenario-trust transcript (2026-10-16)

Role: fresh-context semantic reviewer (Layer 3), dispatched by the orchestrator. No source or test file changed.

## Read
- VF7 Gherkin; tasks.md T3.4 (VF7 cases); coverage.md (permissions row); journal/scenario/VF7.md.
- packages/opencode/test/task/verify-spec-VF7.spec.ts; test/task/lib/command.ts, lib/machine.ts, lib/supervise.ts
  (`runOf`, `eventually`); src/task/core/command.ts (`run` trust branch, `job`, `folderTrust`);
  src/task/core/supervise/run.ts (`startRun`, `applyTrusts`, `untrustedOutside`, `trust`, `trusting`, `dispatch`).
- The fix 109948a797 (supervise/run.ts diff).

## Gherkin step -> assertion
| Step | Assertion | Result |
|---|---|---|
| Given a stored run in which T1.1 ended trusted | whole-spec slice published on the run aggregate; pure fold gives T1.1 `trusted`; T1.3 subtree external `["T1.1"]` | covered |
| When /task runs on the T1.3 task folder | real `TaskCommand.run`, job registry in "run" mode runs the real job (Recorder, machine, supervisor) | covered |
| Then the run starts and its external region for T1.1 is trusted directly after run.started | header reply; one job; lease path T1.3; newest slice `[run.started path T1.3, outside.trusted T1.1]`; fold untrusted after fact 1, trusted after fact 2; old slice unchanged | covered |
| And /task trust T1.1 never moves an external region | test 2: live command run, run slice trusted ids `[T1.1, T9, T8]` (T1.1 once, from start-up), directory aggregate `[T9, T1.1, T8]`; test 3: real supervisor with T1.1 untrusted, T9 and T8 trusted, T1.1 untrusted in snapshot and fold, stored trusted ids `[T9, T8]`, T1.3 not ready; test 4: typed trust T1.1, R12 refusal stays | covered, with positive controls |

## Commands
- `state.mjs <spec> query scenario/VF7` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-VF7.spec.ts` at 6d3f86d553 -> 4 pass, 0 fail, 33 expect(), exit 0, 120 s.
- The same at 2e6ff969e3 (holds fix 109948a797) -> 4 pass, 0 fail, 33 expect(), exit 0, 121 s.
- `state.mjs <spec> verdict VF7 trusted --reason ...` -> exit 0, trustLevel trusted.

## Notes
- The tests wait (condition poll, 20 s cap) for the supervisor in `running` with a snapshot before any trust. They
  neither depend on the start-up trust drop nor test its fix; SV20 and the fix's own tests (ada6b2a113) cover that.
- The fix keeps `untrustedOutside` on the pending path, so a T1.1 trust in the start-up window cannot move the
  external region either (code read, not asserted by VF7).

## Outcome
TRUSTED. State completed, trustLevel trusted.

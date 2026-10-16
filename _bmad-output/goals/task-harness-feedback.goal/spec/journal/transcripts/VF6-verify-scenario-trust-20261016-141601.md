# VF6 — verify-scenario-trust transcript (2026-10-16 14:16)

Role: fresh-context semantic reviewer (Layer 3), dispatched by the orchestrator. No source or test file changed.

## Read
- guardrails.md; semantic-verify-scenario/SKILL.md; spec.md; scenarios.gherkin (VF6); tasks.md T3.4; coverage.md A3.a.
- journal/scenario/VF6.md (the earlier verify run).
- packages/opencode/test/task/verify-spec-VF6.spec.ts; test/task/lib/command.ts; test/task/lib/machine.ts;
  src/task/core/command.ts (`run`, `plan`, `folderTrust`, `slicePlan`, `sliceOf`).

## Gherkin step -> assertion
| Step | Assertion | Result |
|---|---|---|
| Given the release-notes spec with no stored run | `Blend.load` failures `[]`; T1.3 `after` `["T1.1"]`; T1.3 subtree tasks `["T1.3"]`, external `["T1.1"]`, T1.1 not in `outside`; `storedOf` `[]` | covered |
| When /task runs on the T1.3 task folder | real `TaskCommand.run` with a real `TaskHarness.make`, event store and database | covered |
| Then the run is refused before any work | `jobs.starts` `[]`; `harness.live` none; stored facts `[]`; git worktree list unchanged; status run `refused` | covered |
| And the refusal line names T1.3 and T1.1 as "R12 ..." | message equals header + exact R12 line + hint; regex of the template; folder = relative path of T1.3; status `reason` = R12 line | covered |
| And the trust of T1.1 is read by folding the stored slices through their own plans | four cases: whole-spec trusted (runs); trusted then `obligation.stale` (refused); whole-spec `outside.trusted T1.1` (refused); T1.3-subtree `outside.trusted T1.1` (runs). The command must agree with the pure fold of each slice through its own plan | covered, discriminating |

## Commands
- `state.mjs <spec> query scenario/VF6` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-VF6.spec.ts` (packages/opencode) -> 5 pass, 0 fail, 42 expect(), exit 0, 162 s.
- `state.mjs <spec> verdict VF6 trusted --reason ...` -> exit 0, trustLevel trusted.

## Notes
- Each case stores one slice; the newest-first walk across several slices belongs to VF20 and VF24.
- VF6 does not depend on the reported defect (a `/task trust` dropped while the run supervisor is in `trusting`).

## Outcome
TRUSTED. State completed, trustLevel trusted.

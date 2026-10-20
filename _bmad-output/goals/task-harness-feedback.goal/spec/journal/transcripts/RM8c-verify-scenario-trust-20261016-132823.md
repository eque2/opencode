# RM8c verify-scenario-trust transcript

Fresh-context Layer 3 reviewer (eque2-verifier), batch RM7, RM8a, RM8b, RM8c, RM9.

## Read
- spec.md (D3 via owner ruling 1, SD-18), scenarios.gherkin (header definition of "the observed facts", RM8c, RM10),
  tasks.md (T1.6, T1.7, T1.11, T2.11 rows), journal/task/T1.7.md and T1.7-verify.md (the documented reading).
- journal/scenario/RM8c.md (Layer 1+2 record and its gap note).
- packages/opencode/test/task/verify-spec-RM8c.spec.ts (committed b9553cc37d; not changed since).
- packages/opencode/test/task/lib/machine.ts; src/task/core/command.ts `sliceOf`.
- `git show 2c0214ab71:packages/opencode/src/task/core/runner.ts` `schedule`: it proves every waiting scenario whose
  needs are all trusted.
- task-formats/blend/release-notes.spec: T1.4 after [T1.2, T1.3]; S2, S7 need [T1.1]; S3 needs [T1.2]; S4, S12 need
  [T1.3]; every other scenario needs T1.4 or T1.5.

## The reading of the Given
The header defines "the observed facts" with no scenario facts. Under D3 and RM10 that fold is not done: S2, S3, S4,
S7 and S12 stay pending. So the literal RM8c contradicts the binding decisions. The old runner proved those five
scenarios as soon as their needs were trusted, and all five were provable before T1.4 started. The real observed
stored slice therefore holds their facts. The test stores exactly that slice and pins the literal behaviour in test 1.
I accept this reading. The header wording is a spec gap for the owner.

## Gherkin step -> assertion
| Step | Assertion |
|---|---|
| Given the observed facts stored with no run.ended | No run.ended or run.cancelled; run.started `{ base }` with no path; the non-scenario facts equal `observed(plan)` by shape; the header facts alone fold to running with exactly S2, S3, S4, S7, S12 pending and every other scenario blocked; the stored slice proves exactly those five. |
| When the slice is folded through the new machine | `TaskEvents.fold` over the real engine. |
| Then the fold is done with the outcome budget exhausted, and T1.5 and T1 are blocked | status done, ended, no stored stop; run `{ budget_exhausted, reason "T1.4 budget exhausted\nT1 blocked by T1.4\nT1.5 blocked by T1.4" }`; last history run running -> budget_exhausted; T1.4 budget_exhausted; `blockedBy` T1.5 and T1 = `{ T1.4, budget_exhausted }`; one fact less is not done; failed S3 and rejected S4 give the same outcome. |
| And /task on the same spec starts a new slice and never resumes a done fold | `sliceOf` = new for the stored slice, = resume for one fact less; real /task: reply is the header alone, first appended fact equals `{ run.started, base, path: spec }`, no run.resumed, two slices, the new one latest. |

## Commands
- `node state.mjs <spec> query scenario/RM8c` -> completed, trust verified.
- `bun test --timeout=30000 ./test/task/verify-spec-RM8c.spec.ts` (packages/opencode) -> 3 pass, 0 fail, 45 expect() calls, 4.1 s.
- `node state.mjs <spec> verdict RM8c trusted --reason ...` -> `{"verdict":"trusted","trustLevel":"trusted"}`.

## Outcome
Trusted on the stored-slice reading. Gap: the Gherkin header's "observed facts" omits the scenario facts; the owner
should reword the header or RM8c. Not a test or code defect.

# RM7 verify-scenario-trust transcript

Fresh-context Layer 3 reviewer (eque2-verifier), batch RM7, RM8a, RM8b, RM8c, RM9.

## Read
- spec.md, scenarios.gherkin (header definition of "the observed facts", RM7), tasks.md (T1.3, T1.5, T1.7 rows).
- journal/scenario/RM7.md (Layer 1+2 record).
- packages/opencode/test/task/verify-spec-RM7.spec.ts (committed b9553cc37d; not changed since).
- packages/opencode/test/task/lib/machine.ts (`loadPlan`, `observed`, `trustLeaf`, `exhaustLeaf`).
- packages/opencode/src/task/engine-xstate/index.ts exports (initial, apply, unitState, tags, waitingOn, blockedBy, view).

## Gherkin step -> assertion
| Step | Assertion |
|---|---|
| Given the release-notes plan and the observed facts up to the second failing proof of T1.4 | Plan from the real loader; task ids, T1.5 afterEffective [T1.3, T1.4, T9], budget 3; 3 failing T1.4 proofs in the list, 2 in the given prefix, only `task.ready` T1.4 after the second; given fold: T1.1-T1.3 trusted, T1.4 proving attempt 3, run running; T1.5 and T1 waiting, not ready, no blocked tag, no cause, no blocked history. |
| When the third failing proof of T1.4 is applied | One `engine.apply` of the last observed fact (asserted to be the failing `T1.4.c7` proof). |
| Then T1.4 is budget exhausted | unitState, view `{ budget_exhausted, attempts 3 }`, `dead` tag, one added history entry proving -> budget_exhausted. |
| And T1.5 and T1 are blocked in the snapshot that apply returns | unitState, view state, `blocked` tag, not ready, all on the returned snapshot; T1.1-T1.3 stay trusted. |
| And each has a history entry with reason "blocked by T1.4: budget exhausted" | The entries added by the one apply are exactly `{ waiting -> blocked, reason }`; one such entry each in the full log; view reason; status projection history. |
| And T1.5 and T1 carry the blocked cause T1.4 in state budget_exhausted | `blockedBy` equals `{ id: "T1.4", state: "budget_exhausted" }`; `TaskStatus.project` tasks match; T1.4 has no cause. |

## Commands
- `node state.mjs <spec> query scenario/RM7` -> completed, trust verified.
- `bun test --timeout=30000 ./test/task/verify-spec-RM7.spec.ts` (packages/opencode) -> 5 pass, 0 fail, 52 expect() calls, 11.7 s.
- `node state.mjs <spec> verdict RM7 trusted --reason ...` -> `{"verdict":"trusted","trustLevel":"trusted"}`.

## Outcome
Trusted. No gap.

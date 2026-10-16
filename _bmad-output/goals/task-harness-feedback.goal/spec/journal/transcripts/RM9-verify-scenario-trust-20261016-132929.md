# RM9 verify-scenario-trust transcript

Fresh-context Layer 3 reviewer (eque2-verifier), batch RM7, RM8a, RM8b, RM8c, RM9.

## Read
- spec.md, scenarios.gherkin (RM9), tasks.md (T1.3 Boundary: "names the first in dependency order"; T1.5, T1.7).
- journal/scenario/RM9.md (Layer 1+2 record).
- packages/opencode/test/task/verify-spec-RM9.spec.ts (committed b9553cc37d; not changed since).
- src/task/engine-xstate/machine.ts: `DEAD` = needs_human, budget_exhausted, failed, blocked; `BLOCKING`;
  `blockRows` (one row per dependency and blocking state, in dependency order); `dependenciesOf`.

## Gherkin step -> assertion
| Step | Assertion |
|---|---|
| Given a plan: T3 after T2, T2 after T1, S1 needs T3 | Temporary spec folder loaded by the real `Blend.load` (no failures) and `TaskCommand.plan`; afterEffective T2 = [T1], T3 = [T2]; S1 needs [T3]; T5 = [T4, T2], T6 = [T2, T4]; before: T1 building, every dependant waiting with no cause. |
| When T1 fails | One `engine.apply` of `task.failed T1`. |
| Then T2 blocked by T1 and T3 blocked by T2 in the same fold step | T1 failed; `blockedBy` T2 = `{ T1, failed }`, T3 = `{ T2, blocked }`; the added history of the one step holds waiting -> blocked with the named reasons, T2 before T3. |
| And S1 is blocked by T3 | `blockedBy` S1 = `{ T3, blocked }`; one added history entry with "blocked by T3: blocked", after T3's; status projection carries state, cause and reason; run ends failed. |
| And a task with two dead dependencies names the first in dependency order | T2 and T4 both blocked by T1 in the one microstep; T5 (after [T4, T2]) names T4, not T2; T6 (after [T2, T4]) names T2; history and status projection agree. |

## Commands
- `node state.mjs <spec> query scenario/RM9` -> completed, trust verified.
- `bun test --timeout=30000 ./test/task/verify-spec-RM9.spec.ts` (packages/opencode) -> 4 pass, 0 fail, 50 expect() calls, 2.3 s.
- `node state.mjs <spec> verdict RM9 trusted --reason ...` -> `{"verdict":"trusted","trustLevel":"trusted"}`.

## Outcome
Trusted. No gap. Note: "dead dependency" covers a blocked one (the code's `DEAD` list), and two dependencies can die
at once only in one microstep, which the test builds.

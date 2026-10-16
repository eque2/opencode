# RM16 verify-scenario-trust transcript

- Scenario: RM16 Two siblings with no order between them become ready in the same step.
- Reviewer: eque2-verifier, fresh context, batch RM15-RM19. State before: completed, trustLevel verified.

## What I read
- journal/scenario/RM16.md; tasks.md T1.3 and T1.7 lines for RM16.
- packages/opencode/test/task/verify-spec-RM16.spec.ts (unchanged since dc3c63e00b).
- test/task/lib/machine.ts; src/task/engine-xstate/index.ts; machine.ts work-region rows; RunSupervisor.supervised.

## Gherkin step -> assertion
| Step | Assertion |
|------|-----------|
| Given a plan with leaves T1.1, T1.2 after T1.1, T1.3 after T1.1 | Test 1: spec folder in a scoped temp dir, loaded by real Blend.load (failures []) and TaskCommand.plan; afterEffective/children equal T1 [T1.1,T1.2,T1.3], T1.1 [], T1.2 [T1.1], T1.3 [T1.1]. At start only T1.1 ready and supervised. |
| When the fact that makes T1.1 trusted is applied | Test 2: T1.1 folded to `verifying` (asserted); one `engine.apply` of task.verified with trust T1.1.c1; T1.1 `trusted` in the returned snapshot. |
| Then T1.2 and T1.3 are both ready in the snapshot that apply returns | Test 2: on that snapshot both equal READY (machine `ready`, ready tag, waitingOn [], status waiting); supervised = {T1.2, T1.3}; the step's log entries are only T1.1.c1 and T1.1 to trusted. Test 3: same on the passed-results path. |

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM16.spec.ts`: 3 pass, 0 fail, 24 expect(), 42.6 s.
- `state.mjs <spec> verdict RM16 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap. (tasks.md words RM16 differently; the Gherkin governs.)

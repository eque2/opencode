# RM15 verify-scenario-trust transcript

- Scenario: RM15 A task becomes ready only when every after task and every child is trusted.
- Reviewer: eque2-verifier, fresh context, batch RM15-RM19. State before: completed, trustLevel verified.

## What I read
- Guardrails and semantic-verify-scenario/SKILL.md.
- spec.md; tasks.md T1.3 (readiness rows) and T1.7.
- journal/scenario/RM15.md (the Layer 1+2 verifier's notes).
- packages/opencode/test/task/verify-spec-RM15.spec.ts (unchanged since dc3c63e00b).
- test/task/lib/machine.ts (loadPlan through Blend.load and TaskCommand.plan; fact builders; trustLeaf; unitState).
- src/task/engine-xstate/index.ts (apply, waitingOn), machine.ts work region (waiting/ready rows, stale rows),
  src/task/core/supervise/run.ts `supervised`.

## Gherkin step -> assertion
| Step | Assertion |
|------|-----------|
| Given the release-notes plan | Test 1: loaded plan's afterEffective and children equal the expected table; at run.started T1.1, T1.2 READY, T1.3 waits on T1.1, T1.4 on T1.2+T1.3, T1 on all five children. |
| When T1.1 is trusted and T1.2 is not | Test 2: T1.1 machine state `trusted`; T1.2 machine state checked in ready, building, proving, verifying. |
| Then T1.3 is ready and T1.4 is waiting | Test 2: in each case T1.3 equals READY (machine `ready`, `T1.3:ready` tag, supervised, waitingOn [], status waitingOn []); T1.4 waits on exactly [T1.2, T1.3]. One fact before T1.1's verdict, T1.3 still waits. Test 3: T1.4 ready only when both T1.2 and T1.3 trusted. |
| And the parent T1 is waiting until every child is trusted | Test 4: after each child, T1 waits on exactly the remaining untrusted children; READY in the step that trusts the last child; then trusted after review. |
| And a stale trusted dependency sends a ready dependant back to waiting | Test 5: obligation.stale T1.1.c1 -> T1.1 `proving`, obligation `stale`, T1.3 waits on T1.1 and is not supervised; re-trust -> READY. Same for parent T1 when T1.5.c1 goes stale. |

## Commands and results
- `state.mjs <spec> query scenario/RM15`: completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-RM15.spec.ts` (packages/opencode): 5 pass, 0 fail, 64 expect(), 78.5 s; load average 179.
- `state.mjs <spec> verdict RM15 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap.

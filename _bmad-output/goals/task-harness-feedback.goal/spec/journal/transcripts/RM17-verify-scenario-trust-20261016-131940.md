# RM17 verify-scenario-trust transcript

- Scenario: RM17 A task waiting on an untrusted outside precondition stays waiting and moves on its trust.
- Reviewer: eque2-verifier, fresh context, batch RM15-RM19. State before: completed, trustLevel verified.

## What I read
- journal/scenario/RM17.md; tasks.md T1.3, T1.7, T1.11 lines for RM17.
- packages/opencode/test/task/verify-spec-RM17.spec.ts (unchanged since dc3c63e00b).
- test/task/lib/machine.ts; src/task/engine-xstate/index.ts; RunSupervisor.supervised and untrustedOutside.

## Gherkin step -> assertion
| Step | Assertion |
|------|-----------|
| Given T1.1-T1.4 trusted, every scenario with trusted needs trusted, T9 untrusted | Test 1: plan facts asserted (T1.5 after [T1.3, T1.4, T9]; outside [T8, T9]); scenarios with needs in T1.1-T1.4 computed from the plan = S1-S4, S6-S12; status file shows them all trusted and T9 untrusted. |
| When the snapshot is read / Then T1.5 waiting, waitingOn names T9, run waiting not ended | Test 1: T1.5 machine `waiting`, no ready tag, tags [waiting], waitingOn [T9], status waitingOnOutside [T9]; outcome `waiting`, status `active`, ended false, run state `waiting`, no reason, nothing supervised. |
| And outside.trusted T9 -> T1.5 ready | Test 2: one apply: T9 `trusted`, T1.5 `ready`, ready tag, waitingOn [], outcome `running`, supervised {T1.5}, one log entry T9 -> trusted. |
| And a second trust of T9 changes nothing | Test 2: `apply` returns the identical snapshot (`toBe`), same log length, T1.5 still ready. |

## Commands and results
- `bun test --timeout=30000 ./test/task/verify-spec-RM17.spec.ts`: 3 pass, 0 fail, 44 expect(), 71.8 s.
- `state.mjs <spec> verdict RM17 trusted --reason ...`: exit 0, trustLevel trusted.

## Outcome
Trusted. No gap.

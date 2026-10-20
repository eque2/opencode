# VF4 verify-scenario-trust transcript

Reviewer: eque2-verifier, fresh context, dispatched by the orchestrator (batch VF1-VF5).

## What I read
- `packages/opencode/test/task/verify-spec-VF4.spec.ts` (committed in 3789623276; 2 tests, each title `[VF4]`).
- `packages/opencode/src/task/core/workers.ts` `staleCheck` (the only `record(... spec.checked ...)` in src/task).
- `packages/opencode/src/task/core/supervise/run.ts`: `checkStale`, the `stale` actor (`fromEffect(checkStale)`), the
  `staleCadence` region (waiting -> checking -> marking), `STALE_CADENCE`.
- The committed T1.3 VERIFY.md (the test's three replace patterns match it).
- spec.md (D12, defect 8), scenarios.gherkin VF4, tasks.md T3.3, journal/scenario/VF4.md (writer's note).
- `test/task/supervise-run.test.ts` names only: the T3.3 unit tests include "spec.checked [] comes before obligation.stale".

## Gherkin step -> assertion
| Step | Assertion | Verdict |
|---|---|---|
| Given a live run of a valid spec | real `/task` job; loader gives `[]` failures; decoded status.json live; no `warning`; no stored spec.checked | covered |
| When a VERIFY.md is edited so the spec no longer validates | T1.3 VERIFY.md in the root checkout: two unknown categories, c1 text changed; loader gives exactly two R3 failures at that path | covered |
| Then the run keeps working on the plan it loaded | supervisor snapshot spec equal before/after; c1 keeps old text; same task and obligation ids in status.json; lease kept; after `/task trust T9`: `outside.trusted` T9, `task.started` T1.1 and T1.2; no `run.ended`, `run.cancelled`, `obligation.stale` | covered |
| And the stale check records spec.checked with the failures, and a run history entry | exactly one stored spec.checked whose failures equal the two loader lines; exactly one run history entry "spec.checked: 2 failures"; run still live, no reason | covered (see note) |
| And the status run warning holds one line for each failure | `run.warning.split("\n")` equals the two loader lines in order | covered |

Note on the writer's flag: the test does not observe which actor records the fact. Only `TaskWorkers.staleCheck`
records `spec.checked` in src/task, and the test replaces no actor, so the fact the test sees can only come from the
stale check. I judge the step proven at the scenario level.

## Commands and results
- `node state.mjs <spec> query scenario/VF4`: completed, trustLevel verified.
- `grep -rn 'spec\.checked' src/task`: one record site, workers.ts:524.
- `bun test --timeout=30000 ./test/task/verify-spec-VF4.spec.ts` (packages/opencode): 2 pass, 0 fail, 31 expect() calls, 6.6 s.
- `node state.mjs <spec> verdict VF4 trusted --reason ...`: verdict trusted, trustLevel trusted.

## Outcome
Trusted. No gap.

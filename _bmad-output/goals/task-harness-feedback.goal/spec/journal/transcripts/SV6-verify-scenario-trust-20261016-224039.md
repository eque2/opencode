# SV6 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (semantic trust), batch SV6-SV10, OpenCode runtime.

## Read
- Dispatch prompt `journal/prompts/scenario-SV6-SV10-verify-scenario-trust.md`; `references/guardrails.md`;
  `semantic-verify-scenario/SKILL.md`; `journal/scenario/SV6.md`; spec.md; tasks.md T2.8, T2.9, T2.10.
- Test `packages/opencode/test/task/verify-spec-SV6.spec.ts` (unchanged since 6841bc0e5d).
- Code: `src/task/core/supervise/task.ts` (countFailure, failureLeft, retrying, failing), `supervise/scenario.ts`,
  `supervise/run.ts` (scenarios region: proving, retrying, failing), `workers.ts` (begin, scenarioProof,
  scenarioJudge), `test/task/lib/supervise.ts` (runOf, boundary).

## Gherkin step -> assertion
- Given a task supervisor whose worker fails -> test 1: real TaskSupervisor.machine for T1.1 (tag `ready` asserted);
  root directory without git, so the real `begin` fails (`context.error` contains "not a git repository").
- When the worker fails three times in a row -> `failures` 1 and 2 in `live.work.retrying`; no stored fact after each;
  no retry at 999 ms, retry at 1000 ms; third failure stores one fact.
- Then task.failed with a reason that starts "harness error:" -> exactly one stored fact `{type: task.failed, task:
  T1.1}`, `reason.startsWith("harness error:")`, reason contains the git error; T1.1 folds to `failed`; supervisor
  quiet with failures 3; no fourth try after 5 s.
- And a scenario batch whose worker fails three times records its scenario fact the same way -> test 2: real
  RunSupervisor, S1 ready; real `scenarioProof` fails (rev-parse, not a git repository); batchFailures 1, 2 with only
  `run.resumed` stored; then one `scenario.proved {id: S1, status: failed}` with reason starting "harness error:"; S1
  folds to `failed`; no fourth batch. Test 3 also covers the scenario supervisor's judge path (`scenario.verified`
  rejected, "harness error: the session index is closed", 3 claims, no prompt).

## Gaps
- None against the Gherkin.

## Commands
- `state.mjs <spec> query scenario/SV6` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-SV6.spec.ts` (packages/opencode) -> 3 pass, 0 fail, 6.9 s.
- `state.mjs <spec> verdict SV6 trusted --reason ...` -> exit 0, trustLevel trusted.

## Outcome
Trusted.

# SV10 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (semantic trust), batch SV6-SV10, OpenCode runtime.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; journal/scenario/SV10.md; tasks.md T2.7, T2.8.
- Test `packages/opencode/test/task/verify-spec-SV10.spec.ts` (unchanged since 6841bc0e5d).
- Code: `src/task/core/supervise/task.ts` (building.turn watching/tool/stalling), `src/task/core/sessions.ts:109`,
  `test/task/lib/supervise.ts` (boundary, deltaOf).

## Gherkin step -> assertion
- Given a building task whose model stream goes quiet with no tool running -> real RunSupervisor spawns the real
  TaskSupervisor of T1.1 (building, attempts 1); first prompt is the attempt message in ses_T1.1, claimed with watch;
  no `turn.tool` event; a real part delta at 1.5 s restarts the timer (no stall at 3 s).
- When the stream idle time passes -> 0.5 s more of quiet passes the 2 s scripted streamIdle.
- Then the turn is cancelled and task.stalled is recorded -> cancels == [ses_T1.1]; last stored fact is task.stalled
  T1.1 "stall: no stream activity for 2 s".
- And the builder is prompted again with the continue message in the same attempt -> second prompt equals {ses_T1.1,
  task-builder, the literal continue message}, from the real run supervisor's dispatch.
- And no nudge and no attempt is spent -> attempts 1, stored types exactly [run.resumed, task.stalled], supervisor
  nudges 0; repeated for a second quiet period.

## Gaps
- None against the Gherkin.

## Commands
- `state.mjs <spec> query scenario/SV10` -> completed, verified.
- `bun test --timeout=30000 ./test/task/verify-spec-SV10.spec.ts` (packages/opencode) -> 1 pass, 0 fail, 10.3 s.
- `state.mjs <spec> verdict SV10 trusted --reason ...` -> exit 0, trustLevel trusted.

## Outcome
Trusted.

# RM13 verify-scenario-trust transcript (2026-10-16 UTC)

Fresh-context semantic verifier, spawned directly by the orchestrator (batch RM10-RM14). Outcome: **trusted**.

## What I read
- Dispatch prompt: scratchpad/prompts/scenario-RM10-RM14-verify-scenario-trust.md.
- references/guardrails.md and semantic-verify-scenario/SKILL.md (eque2-code-develop-spec).
- journal/scenario/RM13.md (the earlier verify run: Layer 1+2 passed, state completed/verified).
- packages/opencode/test/task/verify-spec-RM13.spec.ts (committed in 14cbaffb08; no diff at HEAD).
- spec.md owner ruling 1 and defect 5; scenarios.gherkin RM13; tasks.md T1.3 (parked rows) and T1.4 (the
  "Empty / Null" row: `not run: S13 waits on T8`).
- Code under test (read only): src/task/engine-xstate/index.ts (`apply`, `unitState`, `view`, `waitingOn`,
  `ended`); src/task/core/status.ts `project`; src/task/core/supervise/run.ts `readyScenarios`;
  test/task/lib/machine.ts (`loadPlan`, fact builders, `trustLeaf`, `unitState` snapshot-value reader).

## Gherkin steps and the assertions that cover them
1. Given the release-notes plan with T9 trusted and T8 untrusted: S13 needs [T1.4, T8] in the loaded plan; after
   run.started and outside.trusted T9 the status file shows T8 {untrusted, [waiting]} and T9 {trusted, [ended]};
   S13 is still `waiting` (T1.4 not trusted yet).
2. When every task and every runnable scenario is trusted: all six tasks T1..T1.5 trusted; S13 is `parked` at once
   and `readyScenarios` is exactly S1-S12 (also checked against the plan's needs); S1-S12 proved and trusted.
3. Then S13 is parked and shows as waiting: machine state `parked`; status {waiting, [waiting], waitingOn [T8],
   waitingOnOutside [T8]}; `engine.unitState` and `view` show `waiting`; `waitingOn` is [T8].
4. And the run outcome is done with "not run: S13 waits on T8": `engine.ended` true; run `done`, tags [ended];
   reason exactly that one line; a T8 trust after the settle changes nothing.
5. And when T8 is trusted before the run settles, S13 moves from parked to ready: with S12 still `verifying` and the
   run not ended, outside.trusted T8 moves S13 `parked` -> `ready` in one fold step (status `pending`,
   `readyScenarios` [S13], `waitingOn` []); the S12 verdict no longer settles the run; S13 runs to `trusted` and the
   run ends `done` with no reason.

Gaps: none. Note: "shows as waiting" is the status file, not a task-ui render.

## Commands and results
- `state.mjs <spec> query scenario/RM13` -> completed, trustLevel verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad>/trust-runs/RM13/20261016T122520Z/junit.xml ./test/task/verify-spec-RM13.spec.ts`
  (cwd packages/opencode) -> exit 0, 2 pass, 0 fail, 34 expect() calls, 2.7 s.
- `state.mjs <spec> verdict RM13 trusted --reason "..."` -> {"verdict":"trusted","trustLevel":"trusted"}.
- `state.mjs <spec> query scenario/RM13` -> completed, trusted.

## Outcome
RM13 trusted. No source or test file changed. Nothing committed. No evidence or key file read.

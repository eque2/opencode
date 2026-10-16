# RM12 verify-scenario-trust transcript (2026-10-16 UTC)

Fresh-context semantic verifier, spawned directly by the orchestrator (batch RM10-RM14). Outcome: **trusted**.

## What I read
- Dispatch prompt: scratchpad/prompts/scenario-RM10-RM14-verify-scenario-trust.md.
- references/guardrails.md and semantic-verify-scenario/SKILL.md (eque2-code-develop-spec).
- journal/scenario/RM12.md (the earlier verify run: Layer 1+2 passed, state completed/verified).
- packages/opencode/test/task/verify-spec-RM12.spec.ts (committed in 14cbaffb08; no diff at HEAD).
- spec.md owner ruling 1 and defect 10 (rule order); scenarios.gherkin RM12; tasks.md T1.4 (Supports RM12).
- The live-check folder task-formats/blend/example-scenarios.spec (file list; committed in 474ecf4a01).
- Code under test (read only): src/task/engine-xstate/index.ts; src/task/core/status.ts `project`;
  src/task/core/supervise/run.ts `supervised`, `readyScenarios`; test/task/lib/machine.ts (`loadPlan`, fact builders,
  `trustLeaf`).

## Gherkin steps and the assertions that cover them
1. Given a run where every task is trusted: plan pinned as tasks [T1, T1.1] and S1 needs [T1.1]; after the T1.1
   leaf and the T1 review are trusted, the status file shows {T1 trusted, T1.1 trusted}; `readyScenarios` is
   exactly [S1] (runnable), S1 status `pending`; the run is `running` and not ended.
2. When a runnable scenario is rejected by its verifier: `scenario.proved` S1 passed puts S1 under supervision
   (`supervised` is exactly {S1: scenario}); `scenario.verified` with a rejected verdict gives S1 `rejected` with
   the verifier's reason; both tasks stay trusted.
3. Then the run outcome is failed: `engine.ended` true; run `failed` in the status projection and in `view`; tags
   [ended, stopped].
4. And the reason line: the reason is exactly ["acceptance not proved: S1 rejected"]; the last log entry is the run
   moving to `failed` with that reason, right after S1's `rejected` entry.
- Control: the same run with S1 trusted ends `done` with no reason.

Gaps: none. Note: the `failed` scenario variant is outside this Gherkin and is not tested here.

## Commands and results
- `state.mjs <spec> query scenario/RM12` -> completed, trustLevel verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad>/trust-runs/RM12/20261016T122433Z/junit.xml ./test/task/verify-spec-RM12.spec.ts`
  (cwd packages/opencode) -> exit 0, 2 pass, 0 fail, 24 expect() calls, 2.3 s.
- `state.mjs <spec> verdict RM12 trusted --reason "..."` -> {"verdict":"trusted","trustLevel":"trusted"}.
- `state.mjs <spec> query scenario/RM12` -> completed, trusted.

## Outcome
RM12 trusted. No source or test file changed. Nothing committed. No evidence or key file read.

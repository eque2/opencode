# RM10 verify-scenario-trust transcript (2026-10-16 12:23 UTC)

Fresh-context semantic verifier, spawned directly by the orchestrator (batch RM10-RM14). Outcome: **trusted**.

## What I read
- Dispatch prompt: scratchpad/prompts/scenario-RM10-RM14-verify-scenario-trust.md.
- references/guardrails.md and semantic-verify-scenario/SKILL.md (eque2-code-develop-spec).
- journal/scenario/RM10.md (the earlier verify run: Layer 1+2 passed, state completed/verified).
- packages/opencode/test/task/verify-spec-RM10.spec.ts (committed in 14cbaffb08; no diff at HEAD).
- spec.md (scope, owner rulings, defects 7 and 10); scenarios.gherkin RM10; tasks.md T1.4 and T1.11 (Supports RM10).
- Code under test (read only): src/task/engine-xstate/index.ts (`initial`, `apply`, `ended`, `unitState`,
  `blockedBy`, `view`); src/task/core/status.ts `project`; src/task/core/supervise/run.ts `supervised` and the
  `dispatch` action that uses it; test/task/lib/machine.ts (fact builders only).

## Gherkin steps and the assertions that cover them
1. Given a plan with two independent leaves T1.1 and T1.2, both building: the plan comes from a temp spec folder
   through `Blend.load` (failures []) and `TaskCommand.plan`; tasks pinned as T1 [T1.1, T1.2] and both leaves with
   `afterEffective` []; budget 3; `supervised` after run.started is exactly {T1.1, T1.2}; both `building`; the run
   is exactly {ended false, running, [active], no reason}.
2. When T1.1 is budget exhausted: after two failing proofs T1.1 is `proving` with attempts 3; the third failing
   proof gives `budget_exhausted`, and T1 is `blocked` by {T1.1, budget_exhausted}.
3. Then the run keeps running while T1.2 builds, proves and is verified: for each phase `building`, `proving`,
   `verifying` the run is exactly the running view and `supervised` is exactly {T1.2}; the run log has only the
   `running` entry while T1.2 is in hand.
4. And the run settles only when T1.2 reaches a final state: after the verdict T1.2 is `trusted` and the run is
   ended; the run outcome entry comes after T1.2's `trusted` entry; the run log is exactly [running,
   budget_exhausted]; `supervised` is {}; a later fact returns the identical snapshot. The third test shows the
   same settle when T1.2 ends `failed` or `needs_human`.
5. And the run outcome is then budget exhausted: state `budget_exhausted`, tags [ended, stopped], reason
   "T1.1 budget exhausted" + "T1 blocked by T1.1" (plus the T1.2 line in the third test).

Gaps: none. Note: "keeps running" is proved through the pure fold and the `supervised` selector that the run
supervisor's `dispatch` uses to spawn and stop workers; no live supervisor actor runs here.

## Commands and results
- `state.mjs <spec> query scenario/RM10` -> completed, trustLevel verified.
- `git diff --stat HEAD -- <RM10-RM14 test files, src/task, test/task/lib>` -> empty.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad>/trust-runs/RM10/20261016T122220Z/junit.xml ./test/task/verify-spec-RM10.spec.ts`
  (cwd packages/opencode) -> exit 0, 3 pass, 0 fail, 37 expect() calls, 3.3 s.
- `state.mjs <spec> verdict RM10 trusted --reason "..."` -> {"verdict":"trusted","trustLevel":"trusted"}.
- `state.mjs <spec> query scenario/RM10` -> completed, trusted.

## Outcome
RM10 trusted. No source or test file changed. Nothing committed. No evidence or key file read.

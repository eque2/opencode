# RM11 verify-scenario-trust transcript (2026-10-16 UTC)

Fresh-context semantic verifier, spawned directly by the orchestrator (batch RM10-RM14). Outcome: **trusted**.

## What I read
- Dispatch prompt: scratchpad/prompts/scenario-RM10-RM14-verify-scenario-trust.md.
- references/guardrails.md and semantic-verify-scenario/SKILL.md (eque2-code-develop-spec).
- journal/scenario/RM11.md (the earlier verify run: Layer 1+2 passed, state completed/verified).
- packages/opencode/test/task/verify-spec-RM11.spec.ts (committed in 14cbaffb08; no diff at HEAD).
- spec.md (defects 7 and 10, SD-18 rule order); scenarios.gherkin RM11; tasks.md T1.4 (Supports RM11, the
  "Error Propagation" row).
- Code under test (read only): src/task/engine-xstate/index.ts (`apply`, `ended`, `unitState`, `blockedBy`,
  `view`); src/task/core/status.ts `project`; test/task/lib/machine.ts (fact builders only).

## Gherkin steps and the assertions that cover them
1. Given T1.1 needs a human first, T1.2 fails later, T1.3 blocked by T1.1: the real loader gives T1, T1.1 and T1.2
   with no `after`, and T1.3 after [T1.1]. After `task.needs_human` on T1.1: T1.1 `needs_human`; T1.3 `blocked` with
   blockedBy {T1.1, needs_human} in the engine and in the status file (reason "blocked by T1.1: needs human");
   T1.2 still `building`; run `running`, not ended, no reason.
2. When every region is final: `task.failed` on T1.2; every task has the `ended` tag; `engine.ended` is true; the
   log puts T1.1's `needs_human` entry before T1.2's `failed` entry.
3. Then the run outcome is needs human: `run.state` is `needs_human` in the status projection and in `view`;
   tags [ended, stopped].
4. And the reason lines: one line "T1.1 needs human", one line "T1.2 failed", one line "T1.3 blocked by T1.1", in
   that order; the full reason is exactly [T1.1 needs human, T1.2 failed, T1 blocked by T1.1, T1.3 blocked by
   T1.1]; every dead or blocked task has exactly one line.
- Control: the same deaths in reverse order give outcome `failed`, so "died first" decides, not a fixed priority.

Gaps: none. Note: the R2 parent T1 adds the line "T1 blocked by T1.1" (spec defect 7); the Gherkin order holds.

## Commands and results
- `state.mjs <spec> query scenario/RM11` -> completed, trustLevel verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=<scratchpad>/trust-runs/RM11/20261016T122341Z/junit.xml ./test/task/verify-spec-RM11.spec.ts`
  (cwd packages/opencode) -> exit 0, 2 pass, 0 fail, 37 expect() calls, 6.7 s.
- `state.mjs <spec> verdict RM11 trusted --reason "..."` -> {"verdict":"trusted","trustLevel":"trusted"}.
- `state.mjs <spec> query scenario/RM11` -> completed, trusted.

## Outcome
RM11 trusted. No source or test file changed. Nothing committed. No evidence or key file read.

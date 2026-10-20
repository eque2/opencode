# RM24 — verify-scenario-trust transcript (2026-10-16 15:14)

Reviewer: eque2-verifier, fresh context, batch RM20, RM21, RM24. Outcome: **trusted**.

## What I read

- Dispatch prompt, `references/guardrails.md`, `semantic-verify-scenario/SKILL.md`.
- `spec.md`, `scenarios.gherkin` RM24, `tasks.md` T1.5, T1.12, T1.13.
- `journal/scenario/RM24.md`.
- `packages/opencode/test/task/verify-spec-RM24.spec.ts` (commit cd8205fbc0; working tree equal to HEAD).
- `git show a1fca940ca:packages/opencode/src/task/core/status.ts` (the pre-goal schema); `git diff a1fca940ca
  b517ebb3f3^ -- status.ts` is empty, so this is the status.ts that the goal's first change replaced.
- Current `src/task/core/status.ts` (`project(plan, snapshot)`, `write`, `blockedBy`) and `src/task/core/recorder.ts`
  (`make`; the default writer is `TaskStatus.write`).
- `packages/tui/test/task-ui/fixture-status.json`: unchanged since 753835377c (before the goal).

## Gherkin steps and assertions

| Step | Assertion | Verdict |
|------|-----------|---------|
| Given a phase-1 run that folds the observed facts | release-notes plan from `loadPlan`; `observed(plan)` (T1.1–T1.3 trusted, T1.4 fails its proof three times); (a) `engine.initial` + `engine.apply` fold; (b) the real `TaskRecorder.make` with the real event store records each fact | covered |
| When the status file is written | (a) `TaskStatus.write(dir, TaskStatus.project(plan, snapshot))`; (b) the Recorder's own writer; both read back from `<dir>/.opencode/task/status.json` on disk; (b) polls on a condition and dies after 3 000 tries | covered |
| Then T1.5 and T1 have the state blocked and the reason "blocked by T1.4: budget exhausted" | decoded with `TaskStatus.Status`: T1.5 and T1 match `{ state: "blocked", reason, blockedBy: { T1.4, budget_exhausted } }`; exactly one history entry `waiting -> blocked` with that reason each; T1.1–T1.3 trusted; T1.4 budget_exhausted, 3 attempts | covered |
| And the status file keeps every field it had before the change | `Before` = the a1fca940ca schema, widened only by `blocked` / `cancelled`; it decodes the old fixture with excess keys refused; it decodes both new files; optional old fields present (worktree T1.1–T1.4, T1.4 reason, T1.4.c7 failed + reason, S1 blocked + reason, history `from` and `reason`); task keys are all six tasks | covered |

## Commands and results

- `state.mjs <spec> query scenario/RM24` → completed, trust verified.
- `bun test --timeout=30000 --reporter=junit --reporter-outfile=/tmp/rm-trust-runs/RM24/junit.xml ./test/task/verify-spec-RM24.spec.ts`
  in packages/opencode → exit 0, 5 pass, 0 fail, 47 expect() calls, 9.76 s.
- `state.mjs <spec> verdict RM24 trusted --reason "..."` → exit 0, trustLevel trusted.

## Notes

- The phase-1 runner was removed in phase 2. The test drives the fold-project-write functions that the phase-1
  runner called (AD-20), and the run writer of today. I accept this as the faithful reading of "a phase-1 run".
- Minor, not gaps: the comment at line 190 says that every obligation and scenario record is checked, but only the
  task keys are; the header calls a1fca940ca the parent of b517ebb3f3, but it is the last status.ts change before it
  (same content).
- I did not run the adapter: the structural layer is complete, and a trust dispatch writes no evidence.

# RM26 verify-scenario-trust transcript

Verifier: fresh-context eque2-verifier (OpenCode), spawned by the develop-spec orchestrator. Batch RM25-RM29.

## Read
- Dispatch prompt; guardrails.md; semantic-verify-scenario/SKILL.md; `journal/scenario/RM26.md`.
- tasks.md (T1.12, T1.13 "Backwards Compatibility — RM26", T2.3 note); CONTEXT SD-2, SD-12.
- `packages/opencode/test/task/verify-spec-RM26.spec.ts`; `test/task/lib/delegate.ts` (nested `bun test`, JUnit
  report, fails on any failed case, on no passed case and on a non-zero exit).
- `git log -1 c30fc83bb0` (merge "phase 1, one run machine", contained in `dev`);
  `git show c30fc83bb0:packages/tui/src/task-ui/designs/3-board.tsx` (COLUMNS, STOPPED fallback, Card lines).

## Gherkin step -> assertion
1. Given the phase-1 status of the observed facts -> test 2: checkpoint `fixture-phase1.json` via `git show`;
   T1.5 and T1 `{state: blocked, reason: "blocked by T1.4: budget exhausted"}`, T1.4 budget_exhausted, T1.1-T1.3
   trusted; state and reason of every task equal `engine.view` of `observed(plan)` on the loaded release-notes plan.
   Test 1: the checkpoint's core-status test writes the file from `project(plan, observed(plan))`.
2. When the task-ui of the checkpoint renders it on the Board -> test 1: merge first-parent diff of
   packages/tui/src/task-ui is empty (unchanged task-ui); test 3: `git archive` of the checkpoint's packages/tui,
   board source and fixture equal the checkpoint's, a generated TUI test renders the real checkpoint `BoardView`
   (testRender 110x40) and the delegate runs it (exact title passed).
3. Then T1.5 and T1 sit in STOPPED with the label blocked -> headings `WAITING 0 .. TRUSTED 3, STOPPED 3`; each card
   in `board[5]`, `card[1] === "blocked"`, and no card for the id in the other five columns.
4. And each card shows "blocked by T1.4: budget exhausted" -> `card.join(" ")` contains the reason.
- Extra: test 4 runs today's TUI RM26 test on fixture-projected.json (T2.3).

## Commands
- `bun test --timeout=30000 ./test/task/verify-spec-RM26.spec.ts` (packages/opencode): 4 pass, 0 fail, 27 expect().
- `state.mjs <spec> verdict RM26 trusted --reason "..."` -> exit 0, `"trustLevel":"trusted"`.

## Outcome
Trusted. No gap. Note: at HEAD the Board card has no separate "blocked" label line (T4.6); the Gherkin names the
checkpoint's task-ui, which the test renders from git.

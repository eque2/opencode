---
goal_folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal
worktree: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
branch: goal/task-harness-feedback
written_at: 2026-10-20T02:20:00Z
gate_status: "active, iteration 33, last evaluation 42 met / 4 outstanding (2026-10-16); ACs.md now has 46 of 46 ticked, and the gate has not evaluated it because the OpenCode sessions have no Stop hook"
---

# Handover — task-harness-feedback

## Canonical work

- Charter: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/goal.md` (owner rulings 1–10)
- Acceptance contract: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/ACs.md`
- Defect log: `spec/journal/defects.md` (D1–D26); AC 29 logs `spec/journal/gate/ac29-*-20261020*`; live check
  `spec/journal/live/README.md`.

## Goal state

All 46 criteria are ticked with evidence (`validate-acs.sh`: 46 checked, 0 unchecked, 0 surrogate, 0 not
substantive). `state.mjs done` is true. `dev` holds the final merge dec8d34318 and is not pushed. No work is left in
the contract.

## Work completed (2026-10-19 → 2026-10-20)

- AC 27: live tmux runs, 3 of 4, $0.5944.
- AC 29: final runs pass (lint, typecheck, opencode 4,645 / 0 fail, tui 368 / 0 fail, o2 conformance H1–H16).
- Fixes on the way: D21 (acp EOF test), D23 (UI3, UI8 waits), D24 (load-bound test limits under ruling 10), D25
  (private TMPDIR for the suite: another process deleted temporary folders), D26 (shell tool dropped output still
  being read at exit — product fix with a red test first).
- BUILD-1/2/3/4/6 trusted by a fresh verifier; UI3, UI8 and RM19 re-verified and trusted after their test changes.
- AC 28 / AC 46: `dev` merged into the branch (0a30bdfa26), the goal record and `runaway-bfs-report.md` untracked
  (e16308fb09), `git merge --no-ff` in the main checkout (dec8d34318), both re-added on the branch (2fe359b4b7).

## Decisions and risks

- `runaway-bfs-report.md` is kept off `dev` by own judgment; it stays committed on the goal branch.
- The goal branch on `origin` is at 9aeae4921b (ruling 9); later commits are not pushed. `dev` is not pushed.
- Changes outside the harness need the owner's review: D3 (build stub), D4 (test preload env), D21, D24 (test time
  bounds, the opencode test script default timeout 60 s), D26 (`src/tool/shell.ts`).

## Continuity gaps

- The stop gate has not evaluated the ticked `ACs.md`. Its next evaluation (Claude Code Stop hook) should find 46 of 46
  met and end the loop.
- D22 is open: the TUI's `GET /command` fails when an MCP server offers prompts, so `/task` is sent to the model as text.
  Also on `dev`. Not part of this contract.

## Next action

Owner decisions only: push `dev` and the latest branch commits if wanted, and decide whether to fix D22.

## Resume

Open a fresh Claude Code context with the worktree as its working directory and refer to this file:

`/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/handover.md`

That invokes `eque2-code-handover-goal` resume mode (`cancel.sh adopt`); the gate's next evaluation reads 46 of 46.

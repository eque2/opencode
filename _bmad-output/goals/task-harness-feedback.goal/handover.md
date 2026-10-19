---
goal_folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal
worktree: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
branch: goal/task-harness-feedback
written_at: 2026-10-19T14:55:00Z
gate_status: "active, iteration 33, last evaluation 42 met / 4 outstanding (the gate has not evaluated since 2026-10-16; ACs.md now has 43 of 46 ticked); status names conversation 3878ca44-82a4-48b1-8281-9fa90483a400, because the OpenCode session that ran `adopt` has no Stop hook"
---

# Handover — task-harness-feedback

## Canonical work

- Charter: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/goal.md` (owner rulings 1–9)
- Acceptance contract: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/ACs.md`
- Spec folder (state CLI target): `.../task-harness-feedback.goal/spec`; defect log `spec/journal/defects.md` (D21–D23 new)
- Live-check record: `spec/journal/live/README.md`; AC 29 logs of 2026-10-18: `spec/journal/gate/ac29-*-20261018*.log`
- The charter and `ACs.md` override this document if they differ.

## Goal state

43 of 46 criteria are ticked. Outstanding, in order:

1. **AC 29 (CRITICAL).** Done at product HEAD `688450d923`: root `bun lint` exit 0, root `bun typecheck` exit 0,
   `packages/tui` `bun run test` 368 pass / 0 fail (logs in `$TMPDIR/opencode/ac29/`: `lint.log`, `typecheck2.log`,
   `tui.log`). Not done: an exit-0 `packages/opencode` `bun run test`, then
   `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1` passing H1–H16.
2. **AC 28 [D26]**, the final merge into `dev` (`git merge --no-ff` in the main checkout). Do not push `dev`.
3. **AC 46 [D26]**: after the merge, `dev` tracks no path under `_bmad-output/`.

Develop-spec: 54/54 tasks, 108/108 scenarios completed and trusted; BUILD-1, BUILD-2, BUILD-3, BUILD-4 and BUILD-6
are `verified`, not `trusted`, so `state.mjs done` is false.

## Work completed (2026-10-19, OpenCode session)

- Test-only fixes for AC 29, each re-verified where it is a scenario test:
  - `f8990aae96` acp "stdin EOF exits cleanly": the 5 s bound starts after the agent replies (D21; failed on dev too).
  - `162ce61dee` UI3: positive checks wait up to 100 settles (D23). Re-verified and trusted (`e085a5a91c`).
  - `688450d923` UI8: the wait reads the lease and the stored facts, then folds once; a fold every 20 ms slowed the run
    under test (D23). Re-verified and trusted (`09e0ef8454`). File time 32–36 s instead of 70–80 s.
- `packages/opencode` suite runs: run 3 (after D21) 4,643 pass / 1 fail (UI3); run 4 (after the UI3 fix) 4,643 pass /
  1 fail (UI8); run 5 (after the UI8 fix) stopped at 7 timing failures at load 80–170 (RM19, RM22, VF20 ×2, VF24, SV6
  worker reset — all timeouts).
- **AC 27 ticked** (`cc8c28e5ce`): 3 of 4 live runs, $0.5944, model `github-copilot/gpt-5.6-terra`. The scenarios
  folder ended done with S1 trusted; the cascade folder ended with T1.1 budget exhausted and T1, T1.2 blocked by T1.1,
  T1.3 trusted. Run 1 failed on D22.
- **D22 found, not fixed:** in a TUI whose MCP servers offer prompts, `GET /command` fails to encode an MCP prompt's
  promise `template`, so the TUI knows no server command and sends `/task …` to the model as text. Also on dev.
  Workaround: disable the MCP servers (`OPENCODE_CONFIG_CONTENT`).

## Decisions and risks

- Owner rulings 1–9 bind the work. Ruling 8 raised only RM19's bound; do not raise other bounds without the owner.
- The host is shared. Other sessions (a jamcode lint loop, WebStorm, a camera-videos OpenCode) held the load at 70–186
  from 13:00 to 16:00 on 2026-10-19. Timing tests fail above about 40.
- A background waiter, `$TMPDIR/opencode/ac29/chain.sh` (`$TMPDIR` = `/var/folders/x_/mlr9mcxd5gq0csqytn1dlr1c0000gn/T`),
  starts the opencode suite when the 1-minute load is under 30 and the 5-minute load under 35, and then o2
  conformance if the suite exits 0. It writes `chain.log`, `opencode-suite6.log` and `conformance.log` there.
- BUILD trust: only a fresh verifier calls `verdict BUILD-n trusted`, through
  `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .agents/skills/eque2-code-setup/scripts/state.mjs <spec> verdict ...`,
  citing the final logs. Do not self-certify.
- Integrity rules: never read evidence or key files; never hand-edit state; never edit the enforcement programs.
- Commits: plain imperative subject, Why / Source / Notes. Goal-folder files need `git add -f`, then unstage key files;
  `git ls-files | grep -E '(^|/)\.(signer|evidence)-key$'` must print nothing.
- Merge procedure (goal.md steps 2b–2d and 4): merge `dev` into the branch (dev is `c30fc83bb0`); untrack the goal
  folder and commit; merge from the main checkout (on `dev`, clean); re-add the folder with the add-then-unstage form.
- The branch is on `origin` at `9aeae4921b` (owner ruling 9). Later commits are not pushed.

## Continuity gaps

- Read `chain.log` first: it says whether the suite and conformance ran and their exit codes.
- If the suite fails only on timeouts under high load, rerun it at a lower load; a failure at low load is a defect.
- Conformance waits up to 30 minutes for no other `bun test` and a load under 16, then runs anyway.
- The goal gate has not evaluated the new ticks; it runs only from Claude Code.

## Next action

Read `$TMPDIR/opencode/ac29/chain.log`. If the suite and conformance both exited 0, dispatch a fresh verifier for
BUILD-1/2/3/4/6, tick AC 29 with the logs, then merge (AC 28, AC 46). Developer input: pause the other heavy sessions
so the load falls under 30.

## Resume

Open a fresh context with the worktree as its working directory and refer to this file:

`/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/handover.md`

That invokes `eque2-code-handover-goal` resume mode, which runs `cancel.sh adopt` for the active loop. Do not call
`pursue-goal.sh` and do not start a second loop.

---
goal_folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal
worktree: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
branch: goal/task-harness-feedback
written_at: 2026-10-19T09:05:00Z
gate_status: "active, iteration 33, last evaluation 42 met / 4 outstanding; status still names conversation 3878ca44-82a4-48b1-8281-9fa90483a400 as the claimant after an `adopt` on 2026-10-18, because the OpenCode session that ran `adopt` has no Stop hook"
---

# Handover — task-harness-feedback

## Canonical work

- Charter: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/goal.md` (owner rulings 1–9)
- Acceptance contract: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/ACs.md`
- Spec folder (state CLI target): `.../task-harness-feedback.goal/spec`
- Defect log: `.../task-harness-feedback.goal/spec/journal/defects.md`
- Short state: `.../task-harness-feedback.goal/STATE.md`
- AC 29 logs of 2026-10-18: `.../task-harness-feedback.goal/spec/journal/gate/ac29-*-20261018*.log`
- The charter and `ACs.md` override this document if they differ.

## Goal state

Objective: one generated xstate run machine for the `/task` harness, live supervision as actors, validation and fault
folders, and the task UI changes (D1–D27), merged into `dev`.

Gate: 42 of 46 criteria met. No criterion is blocked. Outstanding, in the order to do them:

1. **AC 29 (CRITICAL), the final quality gate.** Root `bun lint` exit 0, root `bun typecheck` exit 0,
   `bun run test` exit 0 in `packages/opencode` and in `packages/tui`, and
   `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1` passing H1–H16.
2. **AC 27 [D25], the live tmux check.** At most 4 live runs and $5 in total.
3. **AC 28 [D26], the final merge** into `dev` with `git merge --no-ff` in the main checkout. Do not push `dev`.
4. **AC 46 [D26].** After the merge, `dev` tracks no path under `_bmad-output/`.

Develop-spec state (`state.mjs <spec> done`): 54/54 tasks, 108/108 scenarios completed and trusted, 5/5 build checks
completed. `done` is false only because BUILD-1, BUILD-2, BUILD-3, BUILD-4 and BUILD-6 have trustLevel `verified`.

## Work completed (2026-10-18 → 2026-10-19, OpenCode session)

- `cancel.sh adopt` released the gate from the old Claude Code conversation (exit 0).
- **Owner ruling 8** (`9a1039d1f8`): the owner refused to wait for a quiet host ("Just get on with it") and said
  "Increase the timeout". RM19's wall-clock bound went from 60 s to 180 s (`6c46ed46f0`); the edge limit (5,000) did
  not change. Fresh verifier subagents re-ran the adapter (run `20261018T094942Z-44c1b9`), `verify` and one
  semantic `verdict`: RM19 is completed and trusted again (`f295339fbc`).
- Defect statuses corrected (`1fa837e23b`): D6 and D7 resolved (RM23 and SV6–SV10 are trusted); D2 stays open.
- **Owner ruling 9** (this commit set): push the goal branch to `origin`. `dev` is not pushed.
- Owner permission: `~/.config/opencode/opencode.jsonc` now allows `external_directory` access to
  `~/.config/opencode/*`, `~/.local/share/opencode/*` and `~/.local/state/opencode/*`. It is outside the repository.
  It loads only after an OpenCode restart.
- AC 29 results at HEAD `1fa837e23b` (no product code changed after that commit):
  - Root `bun typecheck`: exit 0 (30 tasks, 2026-10-18 10:57).
  - `packages/opencode` `bun run test`, run 1 (load 40–60): 4,643 pass, 42 skip, 1 todo, **1 fail**: UI8 "the run
    is cancelled while a root turn is in flight" — the summary was logged as dropped, because the product's 5 s live
    cancel deadline ran out under load. UI8 alone passed 3/3 at load 107.
  - Run 2 (14:14–15:21, load 50–100): 4,641 pass, 42 skip, **3 fail**: `tool.shell > basic [zsh]` (output
    "(no output)"), `loop continues when finish is unknown` (30 s test timeout), and
    `opencode acp lifecycle subprocess > stdin EOF exits cleanly` (5 s timeout). RM19 and UI8 passed. All three are
    subprocess or timing tests outside the task harness; D2 already lists the last two as load failures.
  - Not run at the final HEAD: root `bun lint` (last exit 0 on 2026-10-17), `packages/tui` `bun run test` (last
    368 pass, 0 fail on 2026-10-17), o2 conformance (not run since the D8–D11 fixes).
- Commit set "everything" (owner, 2026-10-19): the gate's `run-log.jsonl`, the untracked `runaway-bfs-report.md`
  (a 2026-10-16 report on runaway `bfs` processes, not from this goal) and `.eque2-tests/state/.gitignore` (written
  by the verification runner; it ignores `.verifier-marker.json` and `policy-denials.log`).

## Decisions and risks

- Owner rulings 1–9 in `goal.md` bind the work.
- The host is shared. At 10:00 on 2026-10-19 the load was 26 / 17 / 14 (1 / 5 / 15 min). The full opencode suite takes
  68–79 min. Timing-bound tests fail at load 50 and above.
- Ruling 8 covers RM19 only. Do not raise other test bounds without the owner. Do not edit the product's
  `cancelDeadline` to pass a test.
- BUILD trust: only a fresh verifier calls `verdict`, through
  `python3 .agents/skills/eque2-code-setup/scripts/verification-runner.py -- node .agents/skills/eque2-code-setup/scripts/state.mjs <spec> verdict BUILD-n trusted --reason "..."`.
  It must cite the final AC 29 logs. Do not self-certify.
- Integrity rules: never read evidence files, `state/integrity-key.json`, `.signer-key` or `.evidence-key`; never
  hand-edit state; never edit `state.mjs`, the reporter or the gate scripts.
- Commits: plain imperative subject, Why / Source / Notes body (`spec/journal/commit-convention.md`). Goal-folder
  files need `git add -f`, then unstage key files; `git ls-files | grep -E '(^|/)\.(signer|evidence)-key$'` must print
  nothing. `spec/journal/tools/commit-batch.sh tests|records <IDs>` commits a verify batch.
- Merge procedure (goal.md steps 2b–2d and 4): merge `dev` into the branch first (dev is `c30fc83bb0`, the phase-1
  merge, no new commits); untrack the goal folder (`git rm -r -q --cached _bmad-output/goals/task-harness-feedback.goal`
  and commit); merge from the main checkout (on `dev`, clean on 2026-10-19); re-add the folder with the
  add-then-unstage form. Do not push `dev`.

## Continuity gaps

- **AC 29 has no exit-0 opencode suite yet.** Run the three failed tests alone first:
  `bun test --timeout 30000 test/tool/shell.test.ts -t "basic"`, `test/session/prompt.test.ts -t "finish is unknown"`,
  `test/cli/acp/lifecycle.test.ts -t "stdin EOF"`, each from `packages/opencode`. If they pass alone, rerun the
  full suite at the lowest load you can get. If one fails alone, it is a real defect: fix it test-first.
- **The gate claim is unresolved.** OpenCode has no goal-gate Stop hook; only Claude Code loads it
  (`.claude/settings.json` "Stop") and the raised turn bound (`.claude/settings.local.json`). Resume in Claude Code.
- **Build-check evidence is old** (2026-10-15/16). Whether a completed build check takes fresh evidence is unverified.
  Read `.agents/skills/eque2-code-develop-spec/references/state-cli-reference.md` and `state.mjs --help`; never probe
  privileged verbs.
- **The live check (AC 27) has not started.** `spec/journal/tools/live-check.sh` supports
  `new|send|capture|spend|stop`. Its spend query reads `~/.local/share/opencode/opencode-local.db` (present, 6.1 GB;
  table `session` has `directory` and `cost`). The TUI uses its most recent model, which was
  `anthropic/claude-opus-5-5-fast` on 2026-10-18; check its price against the $5 cap before the first run.
- No background job of this goal was running at handover time.

## Next action

In Claude Code, from the worktree, run the three failed opencode tests alone (commands above). Developer input:
none needed unless one fails alone or the owner wants ruling 8 extended to these tests.

## Resume

Open a fresh Claude Code context with the worktree as its working directory and refer to this file:

`/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/handover.md`

That invokes `eque2-code-handover-goal` resume mode, which runs `cancel.sh adopt` for the active loop. Do not call
`pursue-goal.sh` and do not start a second loop.

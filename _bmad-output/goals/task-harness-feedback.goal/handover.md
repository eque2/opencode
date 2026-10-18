---
goal_folder: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal
worktree: /Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback
branch: goal/task-harness-feedback
head_at_handover: 77fa6b740e
written_at: 2026-10-18T08:41:31Z
gate_status: "active, iteration 33, last evaluation 42 met / 4 outstanding, claimed by conversation 3878ca44-82a4-48b1-8281-9fa90483a400 (an old Claude Code session that hit its weekly limit on 2026-10-16 17:42)"
---

# Handover — task-harness-feedback

## Canonical work

- Charter: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/goal.md`
- Acceptance contract: `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/ACs.md`
- Spec folder (state CLI target): `.../task-harness-feedback.goal/spec`
- Defect log: `.../task-harness-feedback.goal/spec/journal/defects.md`
- Short state summary: `.../task-harness-feedback.goal/STATE.md` (updated in 77fa6b740e)
- The charter and `ACs.md` override this document if they differ.

## Goal state

Objective: one generated xstate run machine for the `/task` harness, live supervision as actors, validation and
fault folders, and the task UI changes (D1–D27 in `decisions.md`), merged into `dev` without a push.

Gate: 42 of 46 criteria met. No criterion is blocked.

Outstanding (unchecked in `ACs.md`):

1. **AC 29 (CRITICAL) — final quality gate.** Needs: root `bun lint` exit 0, root `bun typecheck` exit 0, `bun run test`
   exit 0 in `packages/opencode` and in `packages/tui`, and `cd packages/opencode && bun run script/task-conformance.ts
   --arm o2 --runs 1` passing H1–H16 (no `--live`).
2. **AC 27 [D25] — live tmux check.** Scenario folder ends done with S1 trusted; cascade folder ends with T1.1
   exhausted, T1.2 blocked by T1.1, T1.3 trusted; captured panes show the bold title, scenario row, durations,
   non-zero cost, blocked card with cause, and closing summary. At most 4 live runs and $5 in total.
3. **AC 28 [D26] — final merge** into `dev` with `git merge --no-ff` in the main checkout. No push.
4. **AC 46 [D26] — after the merge,** `dev` tracks no path under `_bmad-output/`; the goal folder stays on disk here.

Develop-spec state (`state.mjs <spec> done`): 54/54 tasks done, 5/5 build checks completed, 108/108 scenarios
completed **and trusted**. `done` is still false only because BUILD-1, BUILD-2, BUILD-3, BUILD-4 and BUILD-6 have
trustLevel `verified`, not `trusted`. `state.mjs next` gives no recommendation for them.

## Work completed (2026-10-16 17:45 → 2026-10-17 23:40, OpenCode session)

- Verified and trusted every scenario through fresh sibling `general` subagents (the OpenCode stand-in for
  `eque2-verifier`), using `spec/journal/tools/scenario-prompt.py` and the Bun JUnit adapter
  (`spec/journal/adapter/bun-junit-scenario-adapter.mjs`). Each change of a test file got a fresh adapter run and
  `verify`, then a separate semantic `verdict`.
- Product fixes, each test-first:
  - D8 `077320f8e4` — a failed unit stays unsupervised until its failure folds (`core/supervise/run.ts`).
  - D9 `c8ffccfee1` — the harness root stays active when a run supervisor errors (`core/harness.ts`).
  - D10 `e63744e21b` — the closing summary runs inside the run's instance (`core/workers.ts`).
  - D11 `e2cb2bb1f0` — `SessionRunState.cancel` stops the root turn before it cancels the session's jobs
    (`src/session/run-state.ts`).
- Test-only strengthening after semantic rejections: RM22 isolation (`65ef58b390`), UI2 (`f0027830d7`), UI6
  (`e39c031e31`), UI15 (`c82eb09d2e`), UI22 (`26603ccd79`), UI24 (`ef9e8a93a5`), UI25 (`7ea93d08e0`); lint fixes
  RM18 (`74177dd52c`), SV6 (`f422e0a91a`), SV25/SV27 (`6871c53905`).
- RM22: full signed seven-test run `20261017T113011Z-05ff6f` passed (stale walk 33,944 keys, 331,133 edges, 99 min).
  Owner ruling 7 (`dc101d3d50`, in `goal.md`): "same set of stuck states" means the same stuck unit configurations.
- Latest check results on this branch:
  - Root `bun lint`: exit 0 (2026-10-17 ~22:50, after `74177dd52c` and `f422e0a91a`).
  - Root `bun typecheck`: exit 0 (2026-10-17 20:16; package typechecks passed after later test edits).
  - `bun run --cwd packages/opencode build --single --skip-install --skip-embed-web-ui`: exit 0, smoke test passed.
  - `packages/tui` `bun run test`: 368 pass, 1 skip, 0 fail (2026-10-17 22:52).
  - `packages/opencode` `bun run test` (2026-10-17 09:27–10:16 BST, after the D10/D11 fixes, before the later test
    edits): 4,638 pass, 42 skip, 1 todo, **1 fail** — RM19's 60 s timing assertion at 68.8 s under load. RM19 alone
    passed in 28.4 s.
  - o2 conformance: **not run** since the D8–D11 fixes.

## Decisions and risks

- Owner rulings 1–7 in `goal.md` bind the work. Ruling 7 (RM22) was added on 2026-10-17 by the owner's answer
  "Same unit configurations (Recommended)".
- The host is shared. Other sessions push load to 100–170 on 20 cores. Timing-bound tests (RM19 60 s, run-process
  bounds, preload hook 30 s) fail under that load (D2). A failure under high load is not a product verdict, but AC 29
  needs a real exit-0 run. Wait for a 1-minute load under 15 and a 5-minute load under 20 before the full suites.
- BUILD check trust: the state CLI `verdict` verb accepts build checks (`cmdVerdict` looks up `buildChecks`), but
  only a fresh verifier role may call it. Do not self-certify.
- Integrity rules: never read evidence files, `state/integrity-key.json`, `.signer-key`, or `.evidence-key`; never
  hand-edit state files; never edit `state.mjs`, the reporter or gate scripts.
- Commits: plain imperative subject, body with Why / Source / Notes (`spec/journal/commit-convention.md`). Goal-folder
  files need `git add -f`, then unstage key files; check `git ls-files | grep -E '(^|/)\.(signer|evidence)-key$'`
  prints nothing. `spec/journal/tools/commit-batch.sh tests|records <IDs>` does both kinds of batch commit.
- Merge procedure (goal.md "Ready-to-execute commands", steps 2b–2d and 4): merge `dev` into the branch first; untrack
  the goal folder (`git rm -r -q --cached _bmad-output/goals/task-harness-feedback.goal` + commit); merge from the main
  checkout `/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode` (on `dev`, clean as of
  2026-10-18 08:41); then re-add the folder with the add-then-unstage form. Nothing is pushed. 372 commits are ahead
  of `dev`; merge base `e90cddeff4`.

## Continuity gaps

- **The full `packages/opencode` suite has not passed at current HEAD.** The last full run had one load-induced
  failure, and test files changed after it (UI2/6/15/22/24/25, RM18, RM22, SV6). Rerun it.
- **o2 conformance has not run since the D8–D11 source fixes.** The conformance guard requires a clean,
  committed fingerprint (spec trees, seed, suite, scripts, arms) and no other `bun test` process.
- **Build-check evidence is old.** BUILD-1..6 completed on 2026-10-15/16 at older commits; their evidence carries no
  commit SHA. Whether a completed build check can take fresh evidence is unverified. Read
  `.agents/skills/eque2-code-develop-spec/references/state-cli-reference.md` and `state.mjs --help` first; never probe
  privileged verbs. A trust verifier should cite the fresh AC 29 logs.
- Stale defect statuses: D6 (RM23) and D7 (SV6–SV10) still say `open`, although RM23 and SV6–SV10 are now trusted. D2
  remains open (environment load). Correct D6/D7 in a small journal commit.
- The live check (AC 27) has not started. `spec/journal/tools/live-check.sh` supports `new|send|capture|spend|stop`;
  its spend query reads `~/.local/share/opencode/opencode-local.db`. Confirm that database path before relying on it.
- The gate is claimed by the old Claude Code conversation `3878ca44…`. Its weekly limit reset on 2026-10-18 07:00
  (Europe/London). Do not resume that conversation; adopt the loop from the fresh context instead.
- Untracked files not created by this goal: `runaway-bfs-report.md`, `.eque2-tests/state/.gitignore`. Leave them.
  `run-log.jsonl` is written by the gate; do not edit it.

## Next action

When the host load is low (1-minute under 15, 5-minute under 20), run `bun run test` in `packages/opencode` from the
worktree (about 50 minutes, foreground with a long timeout or a polled log). If it exits 0, run the o2 conformance
command from AC 29. Developer input needed: pause the other heavy test sessions for about 90 minutes so the timing
tests can pass.

## Resume

Open a fresh context with the worktree as its working directory and refer to this file:

`/Users/marknorgate/Projects/eque2/repos/eque2-opencode-workspace/opencode/.claude/worktrees/task-harness-feedback/_bmad-output/goals/task-harness-feedback.goal/handover.md`

That invokes `eque2-code-handover-goal` resume mode, which runs `cancel.sh adopt` for the active loop. Do not call
`pursue-goal.sh` and do not start a second loop.

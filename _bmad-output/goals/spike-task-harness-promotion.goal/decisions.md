# Decisions — promote the spike-task-harness winner (O2) to production

## Code transfer

### D1: how the winning code reaches the promotion branch

**Choice** — Cherry-pick the product diff from `goal/spike-task-harness` onto `goal/spike-task-harness-promotion` (branched from `dev`): the winner diff `3ffee602cd..dbf57fe844` under `packages/`, `task-formats/blend/` and the root `package.json` catalog, plus the post-spike product commits the brief lists (`e67bb456ac`, `7bb1382b2d`, `d40b22c61e`, the task-ui commits, `71432056d4`, `456604ef33`, `888b4f4169`). Then harden it with `bmad-build`, whose spec and review triage log record the work.

**Justification** — The spike code already passes the full suite and every scripted conformance check; a rebuild would re-earn that evidence for nothing. The developer asked to "align the functionality in the best way". Drift is zero: `dev`'s three new commits touch no spike file.

**Alternatives** — Re-implement from the outline: slower, and it throws away tested code. Merge the whole spike branch: it would bring 188 force-added evidence files, the demo tooling and the spike's planning artefacts into `dev`, which the developer chose to leave behind.

**Verified by** — AC 7, AC 8.

### D2: the engine and what is removed

**Choice** — Keep O2 alone: `packages/opencode/src/task/core/` with `packages/opencode/src/task/engine-xstate/` on `@jambudipa/xstate-effect`, pinned exactly at `0.1.0` in the root catalog. Remove O1's `src/task/engine-table/`, the O3 `src/task/harness-plugin/`, `src/task/core/selector.ts` and every read of `OPENCODE_TASK_HARNESS`, with their tests and conformance arms. `/task` is the code-backed harness for every user, with no switch.

**Justification** — The verdict rule (D7 of the spike) picked O2, and the developer confirmed O2 on 2026-10-13 after the findings asked whether to take O1. The spike plan's D14 requires the other options and the selector to be removed.

**Alternatives** — O1, the plain table: identical behaviour and no dependency, but it reopens the approved verdict; the developer declined it. Keep O1 as a fallback engine: a second engine is the selector by another name.

**Verified by** — AC 1, AC 9.

## Product scope

### D3: the task-ui ships with all seven designs

**Choice** — Ship the task-ui TUI plugin with all seven designs as options, chosen with `/task-design`, together with the `ctrl+x o` expand, the shortcut bar, the watch view (`ctrl+x w`), Tab task selection, the double `esc` stop and the core TUI support they need (the `watch` route param, the `session_watch` slot, the reachable-shortcut hint). Leave the demo launch mode, `launch.sh` and `task-seed.sh` on the spike branch.

**Justification** — The developer: "We want all the task designs! As options." The designs meet the deferred criterion that the TUI shows the tree, each task's state and each obligation's verdict as they change. The demo tooling exists for presenting the spike, not for users.

**Alternatives** — Ship one design: the developer declined it. Ship the demo launcher too: the developer chose to leave it on the spike branch.

**Verified by** — AC 4, AC 10.

### D4: the eque2-code module version

**Choice** — The latest eque2-code module, 0.67.1, reaches `dev` as its own commit of the main checkout's uncommitted 0.67.1 upgrade, made on the developer's word before `prepare-goal`, so the promotion worktree inherits it. The spike branch's copy (`19ca8d4768`) is not cherry-picked.

**Justification** — The developer: "Keep latest eque2-code". The main checkout already holds the same 0.67.1 files uncommitted, and `prepare-goal` asks about a dirty checkout; one commit there settles both, and keeps tooling apart from the product change.

**Alternatives** — Cherry-pick `19ca8d4768` into the promotion: it would collide with the uncommitted copy in the main checkout at merge time.

**Verified by** — AC 11.

## Validator

### D5: byte parity of the blend validator

**Choice** — Bring the validator in `packages/opencode/src/task/blend/` to byte parity with `task-formats/blend/golden/`: the 94 unit hashes and the exact message text of all 38 negative cases, checked by `packages/opencode/test/task/blend.test.ts` comparing each message byte for byte with its `expected.txt`.

**Justification** — The spike reached the golden model and the hashes but deferred message parity; the spike plan's D14 makes it a promotion criterion.

**Alternatives** — None credible: the golden model is the format's reference.

**Verified by** — AC 3.

## Regression guard

### D6: the same-run guard without a selector

**Choice** — Keep the conformance suite, runner and fixture in the test tree (spike D13), reduced to two arms: `o2`, the promotion build, and `baseline`, the code without the change, which the runner starts from a clean export of the `dev` commit the promotion branched from. The guard is one run of `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1`, without `--live`, so it spends no model tokens.

**Justification** — The guard must compare against the code without the change in the same run, and the selector that used to switch the baseline on is removed (D2). Exporting the branch point gives a real baseline with no product switch.

**Alternatives** — A test-only switch that turns the harness off: a selector by another name, which D14 removes. A stored `baseline.json`: not a same-run comparison, so it does not travel to CI.

**Verified by** — AC 2.

## The paused goal

### D7: re-plan the paused task-harness goal

**Choice** — Revise the paused goal at `.claude/worktrees/task-harness/_bmad-output/goals/task-harness.goal/` so its decisions D1, D7, D8, D9 and D17 follow the promoted O2 design, and its remaining scope is what the promotion did not deliver. Remove its `.approved` marker, so it cannot start until the developer approves the revised set. It does not run.

**Justification** — The spike plan's D14 requires the re-plan; its decisions predate the verdict (for example D7 "two machines, not two parallel regions"). Approval is the developer's word, which a goal loop cannot give.

**Alternatives** — Retire the paused goal: that is the developer's decision, and the re-plan shows whether anything is left.

**Verified by** — AC 5.

## Rollout

### D8: merge into dev

**Choice** — Bring `dev` into the promotion branch, verify there, then merge with `git merge --no-ff goal/spike-task-harness-promotion` in the main checkout. Do not push. When the merge would touch a file the developer has uncommitted, mark the criterion blocked with the file names instead of stashing or overwriting.

**Justification** — The developer: "Merge it in". The developer's standing rule is never to push. The stash stack is shared across worktrees and sessions, so stashing is unsafe; a blocked criterion leaves the decision with the developer.

**Alternatives** — A pull request with `eque2-code-create-pr`: the developer asked for a merge, and a pull request needs a push.

**Verified by** — AC 12.

### D9: rollback is a revert

**Choice** — Rollback is `git revert -m 1` of the promotion merge on `dev`. Before the merge, show that a build without the harness starts and lists sessions on a database that holds task events written by the promotion build.

**Justification** — There is no flag and no migration. Task state lives as events in the existing session store, so the one risk of a revert is that the older build fails on those events.

**Alternatives** — A feature flag: it brings back the removed selector.

**Verified by** — AC 13.

## Research

No research needed: the spike measured the design on 2026-10-12 and 2026-10-13 (`findings.md` on `goal/spike-task-harness`), and the codebase answers the remaining questions.

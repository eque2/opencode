> **START NOW — do not wait to be asked.** This is a prepared goal folder.
> Invoke `eque2-code-pursue-goal` on the directory containing this file,
> as the first thing you do. Being pointed at this charter IS the request
> to execute it; there is nothing else one does with a `.goal` folder.
> Do not summarise this charter back, do not ask whether to proceed, and
> do not begin the work with no gate bound. If the starter refuses,
> report the refusal and stop.

# Acceptance criteria

Goal: the spike's winner (O2, the in-core `/task` harness on xstate-effect) and its task-ui are on `dev` at production quality, guarded by the same-run conformance check, with the other options, the selector and the spike's evidence left behind.

## Done when

- [ ] [D2] The winning option at production quality: in `packages/opencode/src/task/` for O1 or O2, or as a built-in plugin under `packages/opencode/src/task/` for O3. The other options and the `OPENCODE_TASK_HARNESS` selector are removed.
      - explanation: not built yet; the promotion branch does not exist.
- [ ] **CRITICAL** [D6] The regression guard: in one run of `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1` against packages/opencode/test/task-harness/conformance.test.ts, every scripted check (H1–H16) passes, and o2 beats the baseline arm — the code without the change, measured in the same run — by at least 50 percentage points of conformance score.
      - explanation: not run yet; the two-arm runner does not exist.
- [ ] [D5] The blend validator reaches byte parity with the golden model: 94 unit hashes, and the messages of all 38 negative cases — `packages/opencode/test/task/blend.test.ts`
      - explanation: not built yet; the spike deferred message parity.
- [ ] [D3] The TUI shows the task tree, each task's state and each obligation's verdict as they change (seed decision 2, "Done when" 5) — `packages/tui/src/task-ui/`
      - explanation: not on the promotion branch yet.
- [ ] [D7] The paused task-harness goal (`.claude/worktrees/task-harness/_bmad-output/goals/task-harness.goal/`) is re-planned from the verdict. Its decisions D1, D7, D8, D9 and D17 follow the winner, and it does not run beside the promotion.
      - explanation: not re-planned yet.
- [ ] **CRITICAL** The repository's real lint, type-check, and test commands pass: the root `package.json` scripts `bun lint` and `bun typecheck`, then `GITHUB_ACTIONS=false bun turbo test`, and `cd packages/opencode && bun run test:httpapi`.
      - explanation: not run yet.
- [ ] [D1] The promotion carries the product code and none of the spike's record: `git diff --name-only dev...goal/spike-task-harness-promotion` lists no path under _bmad-output/, and not launch.sh, task-seed.sh or task-ui.md.
      - explanation: not built yet.
- [ ] [D1] The hardening is recorded: the bmad-build spec `_bmad-output/implementation-artifacts/spec-spike-task-harness-promotion.md` has status done, and its review triage log records every finding as fixed or deferred with a reason.
      - explanation: not started.
- [ ] [D2] Only O2 remains: `packages/opencode/src/task/engine-xstate/` exists, while src/task/engine-table/, src/task/harness-plugin/ and src/task/core/selector.ts do not; a search for OPENCODE_TASK_HARNESS in packages/ finds nothing; the root catalog pins @jambudipa/xstate-effect at exactly 0.1.0.
      - explanation: not built yet.
- [ ] [D3] All seven task-ui designs are selectable with /task-design, and the watch view, Tab task selection and the double esc stop work, with no demo launch mode left — `packages/tui/test/task-ui/task-ui.test.tsx`
      - explanation: not on the promotion branch yet.
- [ ] [D4] The promotion branch carries the latest eque2-code module: `_bmad/eque2-code/.version` reads 0.67.1 on goal/spike-task-harness-promotion, from a dev commit of its own.
      - explanation: the 0.67.1 upgrade is uncommitted in the main checkout.
- [ ] [D8] `goal/spike-task-harness-promotion` is merged into dev with git merge --no-ff in the main checkout, after dev was brought into the branch and the guard and quality gate passed there; nothing is pushed.
      - explanation: not merged yet.
- [ ] [D9] Rollback is safe: a build of the pre-promotion dev commit, run through `packages/opencode/src/index.ts`, starts and lists sessions on a database that holds task events written by the promotion build.
      - explanation: not checked yet.
- [ ] [D1] The promotion also carries the spike apparatus committed before the baseline: the product changes of `d69f2f5ab0..3ffee602cd` (the blend validator, the proof runner, the limits, the conformance suite and runner, both fixture trees, the TestLLMServer change in packages/opencode/test/lib/, and task-formats/blend/), plus the root files the product needs (eslint.config.mjs, bun.lock, .gitignore); the dbf57fe844 i18n fix and every other non-harness commit taken is listed by SHA in the bmad-build spec.
      - explanation: appended in Phase R; the D1 range starts after the apparatus, which is not on dev.
- [ ] [D1] The record stays off dev: before the merge, `_bmad-output/goals/spike-task-harness-promotion.goal/` and the bmad-build spec are untracked from the branch with git rm --cached (they stay on disk, ignored, and in the branch history), so the merged tree gains no _bmad-output/ path; AC 7 is measured on the branch tip before the merge.
      - explanation: appended in Phase R; stage 2 committed this folder on the branch, so AC 7 needs it untracked first.
- [ ] [D2] No spike leftovers ship: `git grep -nE "spike|_bmad-output|\bO[123]\b" -- packages/opencode/src packages/tui/src/task-ui` finds nothing outside an allowlist the bmad-build spec records, and the conformance run folder is renamed from .spike-runs/ and gitignored.
      - explanation: appended in Phase R.
- [ ] [D2] O2 keeps its engine coverage and loads statically: every engine contract case runs against XStateEngine in `packages/opencode/test/task/engine-xstate.test.ts`, with no fewer cases than the spike's XStateEngine row; src/task/core/engines.ts imports the engine statically, and a missing engine is a build or test failure, not an engine-unavailable refusal.
      - explanation: appended in Phase R; deleting O1's tests would delete O2's only contract tests.
- [ ] [D2] The shipped binary has the harness: `cd packages/opencode && bun run build` succeeds, and the built binary answers /task on task-formats/blend/release-notes.spec with a started run or a named refusal, never engine-unavailable.
      - explanation: appended in Phase R; the guard and the gate run from source only.
- [ ] [D2] A user's own task command is not replaced silently: a test in `packages/opencode/test/task/` shows that, when the config defines a task command, /task stays the harness (D2) and opencode logs a warning that names the shadowed command.
      - explanation: appended in Phase R.
- [ ] **CRITICAL** [D2] The production safety items from the spike's deferred list, each with a test in `packages/opencode/test/task/`: proof commands run with an environment allowlist, so provider keys never reach model-written tests; the verifier cannot write files and builders cannot write outside their worktree; /task takes its base branch from the repository (the checked-out branch) instead of a hard-coded main, and refuses a dirty root, ignoring .opencode/task/.
      - explanation: appended in Phase R; with no selector, every user runs the harness, and the spike deferred these to the promotion (D14).
- [ ] [D3] The task-ui is reachable and live: a plain TUI start, without OPENCODE_TUI_CONFIG, registers it as a built-in in `packages/tui/src/feature-plugins/builtins.ts` with a default design; a test loads the plugin entry, runs /task-design for each of the 7 designs, and sees the view change after the status file changes; no shipped file under packages/ names launch.sh, task-seed, _bmad-output or "Delete the folder".
      - explanation: appended in Phase R; only the left-behind launch.sh loaded the plugin.
- [ ] [D5] Parity is earned, not edited: `git diff --exit-code goal/spike-task-harness -- task-formats/blend/golden` shows no change; SCHEMA_MESSAGE_CASES is gone from blend.test.ts; the test compares each case's whole output with its expected.txt and asserts exactly 38 cases; no expected.txt line appears as a literal under packages/opencode/src/task/blend/.
      - explanation: appended in Phase R; six cases are exempt from message equality today.
- [ ] **CRITICAL** [D6] The guard is honest and repeatable: `packages/opencode/script/task-conformance.ts` with --arm o2 runs the baseline and o2 arms in the one invocation and exits non-zero when a scripted o2 check fails or the margin is under 50 points; the baseline is pinned to the pre-promotion commit 55ab6b3e56, not computed from dev, and runs from an export with its own install whose node_modules resolve inside the export; the guard fails if the baseline did not start or any baseline check is missing or skipped; the runner header says how to run the guard and that CI does not run it; the JSON of every guard attempt is kept in this folder's journal with quiet true, and none is discarded.
      - explanation: appended in Phase R; a baseline that never starts also scores 0.
- [ ] [D6] The suite is not weakened: the diff of packages/opencode/test/task-harness/ against `goal/spike-task-harness` changes only arm plumbing and the run folder name, and the bmad-build triage log records why.
      - explanation: appended in Phase R.
- [ ] [D7] The paused goal cannot start itself and matches the verdict: in `.claude/worktrees/task-harness/_bmad-output/goals/task-harness.goal/`, decisions.md, plan.md and ACs.md are reconciled with the O2 design; the START NOW banners in goal.md, ACs.md, CLAUDE.md and AGENTS.md are replaced by a PAUSED notice that names the re-plan and the approval it needs; .approved is removed; spec/ and its state are not hand-edited; the change is committed on goal/task-harness.
      - explanation: appended in Phase R; removing .approved alone leaves the folder starting itself.
- [ ] [D8] The merge of `goal/spike-task-harness-promotion` into dev is safe: in the main checkout git symbolic-ref --short HEAD prints dev and no merge or rebase is in progress; dev is an ancestor of the branch right before the merge; every other criterion, AC 13 included, is met first; after the merge, git diff --quiet goal/spike-task-harness-promotion dev succeeds; the merge message has a Why/Source/Notes body; the bun install that the new dependency needs in the main checkout is reported to the developer, not run. When the session cannot run git in the main checkout, this criterion is blocked with the exact commands for the developer.
      - explanation: appended in Phase R.
- [ ] [D9] The rollback check is real: the database comes from one full scripted o2 run of the conformance suite, with the task event types counted by SQL; the old build is the dev commit that becomes the merge's first parent, from an export with its own install, run through `packages/opencode/src/index.ts`; it lists sessions, then opens the root /task session and one builder child session with their messages, with the exit codes recorded. If the old build fails on the task events (core dies on an unknown durable event type), the promotion ships a tested rollback step that removes them, and the old build then passes the same check.
      - explanation: appended in Phase R; packages/core/src/event.ts dies on unknown durable event types.
- [ ] [D1] The hardening is real: in the bmad-build triage log `_bmad-output/implementation-artifacts/spec-spike-task-harness-promotion.md`, every finding of blocking or high severity, or about security, data loss or a CRITICAL criterion, is fixed; every deferral, and every spike deferred-work item this goal does not take on, is listed with its reason in _bmad-output/implementation-artifacts/deferred-work.md with a count.
      - explanation: appended in Phase R; "fixed or deferred" alone lets every finding be deferred.

## Notes

AC 1–13 are the approved set. AC 14–28 were appended in stage 2's contract review (Phase R, `reviews/2026-10-13-contract-review.md`); they add checks and never weaken an approved criterion.

The first six criteria come from the spike plan (experiment brief, "Promotion acceptance criteria, in advance", and the regression guard), copied verbatim. Two changes are formatting only: the guard names its command for the arm `o2`, and the paused-goal criterion quotes the goal's folder path instead of its slug, because the checker reads the first backticked span as the specified system.

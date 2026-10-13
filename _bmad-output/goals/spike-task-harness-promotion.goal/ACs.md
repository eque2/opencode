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

## Notes

The first six criteria come from the spike plan (experiment brief, "Promotion acceptance criteria, in advance", and the regression guard), copied verbatim. Two changes are formatting only: the guard names its command for the arm `o2`, and the paused-goal criterion quotes the goal's folder path instead of its slug, because the checker reads the first backticked span as the specified system.

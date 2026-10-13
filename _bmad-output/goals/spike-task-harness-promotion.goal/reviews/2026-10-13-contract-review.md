# Contract review — Phase R, 2026-10-13

Two lenses of `bmad-review` ran in parallel on `goal.md`, `ACs.md`, `decisions.md`, `plan.md` and `promotion-brief.md`, checked against `goal/spike-task-harness`: edge-case hunter (26 findings) and adversarial (19 findings). Many overlap; the overlap is signal. Every finding was applied in this run by appending criteria (AC 14–28) or charter rules. No approved criterion or decision was removed or reworded, so no re-approval was needed.

## Dispositions

| Finding (lens) | Applied as |
|---|---|
| The D1 range starts after the apparatus; 88 product commits in `d69f2f5ab0..3ffee602cd` hold the validator, proof runner, conformance suite, fixtures and golden model (both) | AC 14; goal.md task 1 |
| `eslint.config.mjs` exception, `bun.lock`, `.gitignore` (`.spike-runs/`) sit outside the D1 path scope (both) | AC 14, AC 16 |
| AC 7 cannot pass while this folder is committed on the branch, and passes vacuously after the merge (both) | AC 15 (untrack before the merge; measure AC 7 on the tip before it) |
| The task-ui loads only through the left-behind `launch.sh`; README and `index.tsx` name the demo tooling (both) | AC 21 |
| The task-ui test never loads the plugin entry or the picker (edge) | AC 21 |
| Deleting O1's tests deletes O2's only contract tests and the differential test (both) | AC 17 |
| O2 loads through a dynamic import and degrades to engine-unavailable (both) | AC 17, AC 18 |
| The baseline export has no install; the baseline can silently not start and still score 0 (both) | AC 23 |
| The baseline moves with `dev` and equals O2 after the merge (both) | AC 23 (pinned to `55ab6b3e56`) |
| The runner exits 0 and needs a hand-read JSON; one run can flake on a loaded machine (both) | AC 23; goal.md "never retried until green" |
| The guard is not wired into CI (adversarial) | AC 23 (the runner header states that it is manual) |
| Six negative cases are exempt from message parity; parity can be faked by fixture edits (both) | AC 22 |
| A user's own `task` command is replaced silently (both) | AC 19 |
| `MAIN = "main"` breaks repositories whose default branch is not main, including this one (both) | AC 20 |
| Deferred production safety items: environment allowlist for proof commands, read-only verifier, confined builders (adversarial) | AC 20 (CRITICAL) |
| Spike names and paths ship in product code (adversarial) | AC 16 |
| D7 via plan-goal conflicts with the paused folder's banners, tracked `.approved` and state folder (both) | AC 25; goal.md rule on the state CLI |
| D8 has unguarded failure modes in the developer's checkout; cross-worktree git may be refused (both) | AC 26; goal.md "Other worktrees" |
| AC 13 is underspecified; core dies on an unknown durable event type, so a revert may break (both) | AC 27 |
| "Fixed or deferred" lets every finding be deferred (adversarial) | AC 28 |
| The suite could be weakened while the arms are removed (adversarial) | AC 24 |
| `dbf57fe844` is an unrelated i18n fix inside the range (edge) | AC 14 (listed by SHA in the spec) |
| The gate may leave `opencode/*` branches and temporary worktrees (adversarial) | goal.md "Shared repository hygiene" (report, never bulk-delete) |
| `.approved`'s criteria hash differs from `ACs.md` (both) | No change: prepare-goal prepends the banner after approval by design, and `pursue-goal.sh` does not check the hash. The approved text is unchanged under the banner; AC 14–28 are appended below it. |
| `reviews/` did not exist (edge) | This file |
| AC 11 is already met, and a newer eque2-code on dev could make "reads 0.67.1" false (adversarial) | No change: the executor evidences it at merge time; a newer version on dev is a reason to report, not to revert |

---
promotes: spike-task-harness
spike-branch: goal/spike-task-harness
baseline-commit: 3ffee602cda3653a85dbf0d1e9ddd89eec782d36
spike-commit: dbf57fe8443799fcb38ddcb57db8cfbfd7502c9d
journal-workstream: task-harness
---

# Promotion brief — the in-core `/task` harness on xstate-effect (O2), with the task-ui

> **Input to `eque2-code-plan-goal`.** Spike wrote this brief from the spike
> goal's findings after an `adopt` verdict. It becomes the promotion plan the
> developer approves, then the promotion goal that takes the winning solution
> to production quality. The sections "Acceptance criteria agreed in the spike
> plan" and "Regression guard" are binding on the plan: each becomes a
> criterion, and none is dropped or weakened.

## What the spike proved

- **Question:** Which of three harness designs lets opencode itself — not the
  model — manage and correctly execute a blend-format task tree, from
  `/task <path>` to a trusted verdict, through stalls, failures and a crash?
- **Verdict:** adopt — **Adopt O2**, by the approved verdict rule (D7). O2 is
  the only option that meets all four conditions. The developer confirmed O2
  on 2026-10-13, after the findings asked whether to take O1 instead (same
  behaviour, no pre-1.0 dependency).
- **Numbers:** conformance score (share of 17 checks, H1–H16 scripted, L1
  live), median of 5 runs: O2 100 against a baseline of 0, a change of +100
  points. The noise floor is 0 points (baseline mean 0), and the smallest
  effect that counts is 50 points. O2 passed every scripted check in 5 of 5
  runs and L1 in 4 of 5. The closing baseline scored 0 (drift 0). Guard
  metrics: the full suite passed at `dbf57fe844` (typecheck 30 of 30, lint
  exit 0, turbo test 10 of 10 with 3,842 opencode tests, httpapi 208 of 208
  in each mode); O2 adds 3,289 product lines; live runs used 0.95–1.55 M
  tokens each.
- **Measured on:** the developer's local macOS machine (20 cores, shared load),
  inside the spike worktree, with isolated XDG folders and a `127.0.0.1`
  server. Not production.
- **Evidence:** `findings.md`, `baseline.md`, and `results.md` in
  `_bmad-output/goals/spike-task-harness.goal/` on the spike branch; journal
  entry `2026-10-13-spike-task-harness.md` in workstream `task-harness`.

## The winning solution

The O2 option as built on the spike branch (commit `dbf57fe844`):

- **`packages/opencode/src/task/core/`** — `/task` as a code-backed command
  that `SessionPrompt.command` dispatches before the template read, so a
  refusal and a trust need no model turn. Every fact is a durable EventV2
  event on its own aggregate, and a resume is the fold of the stored facts. A
  git worktree per leaf, merged into `main` at the verified commit. Builder and
  verifier child sessions with hidden agents in the worktree's own instance,
  each agent with only its role's tools. `task_ready` and `verdict` injected
  for one turn in the `StructuredOutput` pattern. A watchdog for stalls and
  spend caps, and a repetition stop before each model request. The run is a
  background job of the root session, so an abort cancels it.
- **`packages/opencode/src/task/engine-xstate/`** — the lifecycle as
  `@jambudipa/xstate-effect` machines (task with parallel `work` and
  `evidence` regions, plus obligation, scenario and run machines) with a
  named guard and action registry. Each fold step runs the pure `transition`
  synchronously.
- **The apparatus that ships as the regression guard (D13):** the blend
  validator `src/task/blend/`, the proof runner `src/task/proof/`, the limits
  `src/task/limits.ts`, and the conformance suite and runner
  `test/task-harness/`, `script/task-conformance.ts`.

It works because opencode, not the model, owns every state change: the model
can only report through the two injected tools, and the fold of stored events
decides the state, so a crash, a stall or a cancel lands in a named state that
agrees with the proofs.

## Bringing the code over

A spike on its own branch: the promotion goal branches from the main
checkout's `HEAD`, so the winning code is not on it. The winner is the diff
`3ffee602cda3653a85dbf0d1e9ddd89eec782d36..dbf57fe8443799fcb38ddcb57db8cfbfd7502c9d`
on `goal/spike-task-harness`, which also holds the benchmark harness and the
spike's evidence files.

After `dbf57fe844`, the spike branch gained product commits that the
developer wants in the promotion:

- **Harness fixes:** `e67bb456ac` (judge a parent review on its diff, not a
  tagged test — T1.e1), `7bb1382b2d` (a live per-task proof log at
  `.opencode/task/proofs/<task>.log`), and the fixture rewording `d40b22c61e`
  (T1.4.c8).
- **The task-ui TUI plugin, all seven designs kept as options** with the
  `/task-design` picker, the `ctrl+x o` expand, the shortcut bar and the
  click fix: `2e5a453990`, `42ac28fee7`, `ca1e4146e0`, `14fc1cfc88`,
  `20b997215c`, `d135a6454e`, `5f34298366`, `f432eaa2d3`.
- **The watch view and its core TUI support:** `71432056d4` (the core `watch`
  route param and `session_watch` slot), `456604ef33` (hide the "tab agents"
  hint while another layer takes its key), `888b4f4169` (the watch view, Tab
  task selection and esc stop).
- **The latest eque2-code module, 0.67.1** (`19ca8d4768`). The main
  checkout already holds the same 0.67.1 upgrade as uncommitted files; it
  reaches `dev` as its own commit, separate from the product change.

Main-line drift since then: none. `dev` has three commits since it split from
the spike branch (`c9a4820054`, `f1e6308fcf`, `97138fe9d0`, the eque2code
logo), and they touch no file the spike changed. The developer reports small
ongoing work on `dev`; the promotion re-checks the overlap before it merges.

- **Approach:** cherry-pick the product diff and harden it. Bring
  `packages/`, `task-formats/` and the product commits listed above onto the
  promotion branch, then remove O1's table engine
  (`src/task/engine-table/`), the O3 plugin (`src/task/harness-plugin/`), the
  `OPENCODE_TASK_HARNESS` selector and their tests and arms, and bring the
  rest to production quality. The developer's word: "Align the functionality
  in the best way."
- **Leave behind:** on the spike branch, as the record — the spike's evidence
  folder `_bmad-output/goals/spike-task-harness.goal/`, the demo tooling
  (`packages/tui/src/task-ui/launch.sh`,
  `packages/opencode/script/task-seed.sh`, the presenter launch mode), the
  task-ui brief `task-ui.md`, and the UX and implementation artefacts under
  `_bmad-output/`. The developer's word: "Keep latest eque2-code, everything
  else can stay in the worktree branch."

## Acceptance criteria agreed in the spike plan

The developer approved these as the expected finish line in the spike plan,
copied verbatim from the experiment brief's "Promotion acceptance criteria, in
advance", leaving out the regression-guard criterion, which the next section
states once. The promotion plan is approved afresh, and each of these becomes
a criterion in it.

- The winning option at production quality: in `packages/opencode/src/task/`
  for O1 or O2, or as a built-in plugin under `packages/opencode/src/task/`
  for O3. The other options and the `OPENCODE_TASK_HARNESS` selector are
  removed.
- Three things deferred from the spike:
  - The blend validator reaches byte parity with the golden model: 94 unit
    hashes, and the messages of all 38 negative cases.
  - The TUI shows the task tree, each task's state and each obligation's
    verdict as they change (seed decision 2, "Done when" 5).
  - The paused `task-harness` goal is re-planned from the verdict. Its
    decisions D1, D7, D8, D9 and D17 follow the winner, and it does not run
    beside the promotion.
- The repository's real lint, type-check, and test commands pass.

## Regression guard

- **Guard:** in one run of
  `cd packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1`
  against `packages/opencode/test/task-harness/conformance.test.ts`, every
  scripted check (H1–H16) passes, and the change beats the baseline arm — the
  code without the change, measured in the same run — by at least 50
  percentage points of conformance score. A same-run comparison holds on CI
  and other hardware; the spike's absolute number (a median of 100 on the
  developer's macOS machine) is context, not the threshold. The guard runs
  without `--live`, so it spends no model tokens; L1 stays a manual, paid
  check that needs the developer's word.
- **Harness placement:** ships with the promotion as the guard (D13): the
  conformance suite, the runner and the fixture live in the repository's own
  test tree. Once O1 and O3 are removed, the runner keeps only the `baseline`
  and the winner's arm.

## Rollout and rollback

Rollout: the promotion branch merges into `dev` as the outcome of the
promotion goal, once every criterion is met. There is no flag: removing the
selector makes `/task` the code-backed harness for every user of the build.
There is no database migration; task state is EventV2 events in the existing
session store.

Rollback: a revert of the promotion merge on `dev`. Task events already
stored stay in the session database; the promotion goal confirms that a build
without the harness ignores them. The eque2-code 0.67.1 commit is tooling and
reverts on its own.

## Out of scope

- The options the spike did not adopt (O1's table engine, the O3 plugin, the
  selector), and the spike's evidence files.
- The deferred hardening items in the spike's `builds/deferred-work.md`, and
  the task-ui items in
  `_bmad-output/implementation-artifacts/deferred-work.md` (a resumable stop,
  scenario verifiers in Tab, the run's own session in `status.json`, the note
  under the prompt), unless the plan takes one on by name.
- Changing the live spend cap (D11) or whether it counts cached prompt
  tokens. The guard is scripted and spends nothing.
- Running the paused `task-harness` goal: it is re-planned, not pursued.

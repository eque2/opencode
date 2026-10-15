# T1 — parent review (phase 1: one run machine)

- Action: review (develop-spec review-task skill, with the orchestrator's changes: no state CLI call for T1, one
  commit per fix, no prettier on files that were not prettier-clean).
- Date: 2026-10-14, base `3b1c11377d` (all 15 subtasks trusted).
- Scope: `packages/opencode/src/task/engine-xstate/` (machine.ts, index.ts, alphabet.ts), the phase-1 changes in
  `packages/opencode/src/task/core/` (runner.ts, status.ts, events.ts, model.ts, command.ts), `eslint.config.mjs`, and
  the phase-1 tests under `packages/opencode/test/task/` plus `test/task-harness/arms/status.ts`.
- Checked against: spec.md, tasks.md phase 1 (T1.1–T1.15), spine AD-1 to AD-7 and AD-20, the Consistency Conventions,
  the repository lint rules (oxlint, the Effect eslint rules) and `packages/opencode/AGENTS.md`.

Line numbers name the file at the base commit `3b1c11377d`.

## Issues

### 1. A run start folds the resumed slice twice — fixed

- Where: `packages/opencode/src/task/core/runner.ts:837` (`resumable`) and `:866` (`run`).
- Severity: medium (performance).
- Problem: `run` called `resumable`, which folds the latest slice to see whether it ended, and then folded the same
  facts again for `Ref.make`. With the run machine a fact costs about 1–10 ms (AD-6: a few hundred facts take about a
  second; D2 measured several seconds under load), so every resume paid the fold twice.
- Fix: `e8c3324ef5` "Fold the resumed slice once when a run starts". A private `openSlice` returns the facts and their
  fold; `resumable` keeps its contract; a new run starts from `engine.initial(plan)`.
- Tasks touched: T1.11.

### 2. The runner computes a `State` on every fact and drops it — fixed

- Where: `packages/opencode/src/task/core/runner.ts:111` (`view`).
- Severity: low (dead field, duplicated work inside the record lock).
- Problem: `view` returned `{ plan, snapshot, state: TaskEngineXState.view(snapshot) }`. Its callers (`writeStatus`,
  the builder message through `TaskStatus.trusted`) read only `plan` and `snapshot`; `TaskStatus.project` runs `view`
  again. So each recorded fact ran the full view twice.
- Fix: `45d3e883f8` "Drop the unused State from the runner's status input" (the helper now `satisfies
  TaskStatus.Input`).
- Tasks touched: T1.12 (it introduced the helper's `state`), in the T1.11 runner file.

### 3. `TaskStatus.waitingOn` has no caller — fixed

- Where: `packages/opencode/src/task/core/status.ts:94`.
- Severity: low (dead code).
- Problem: its callers were `project` (now the engine's `waitingOn` selector over the AD-3 `waits:` tags) and the
  runner's `checkDone` (removed by AD-20). A second way to compute a wait outside the machine invites a caller that
  disagrees with the tags.
- Fix: `5c75f5371c` "Remove the unused waitingOn helper from the status projection". `TaskStatus.trusted` stays (the
  builder message reads it).
- Tasks touched: T1.12.

### 4. The scenario state `verifying` is unreachable in `State` — fixed

- Where: `packages/opencode/src/task/core/model.ts:25` (`ScenarioState`) and `status.ts:128`.
- Severity: low (dead code, a misleading type).
- Problem: `view` reads a scenario's name from `CLASS.scenario[state].shows`, and the machine's `verifying` scenario
  shows `pending` (AD-2). `ScenarioState` still listed `verifying`, and `project` mapped `verifying` to `pending` in a
  branch that cannot run.
- Fix: `a1bc2c193b` "Remove the scenario state verifying that view never yields". The machine state, its `verifying`
  phase tag and the status schema are unchanged.
- Tasks touched: T1.6 (model.ts), T1.12 (status.ts).

### 5. Three copies of the natural id collator — fixed

- Where: `packages/opencode/src/task/engine-xstate/machine.ts:177`, `engine-xstate/index.ts:101`,
  `core/command.ts:71`.
- Severity: low (duplication against a spine convention).
- Problem: the spine's Consistency Conventions name one id order, "the byId collator", for regions, lists and
  reasons. Phase 1 built it three times (`byId` in the machine, `natural` in the `waitingOn` selector, `natural` for
  the plan's `external` list).
- Fix: `43a100c1c2` "Share one natural id order between the engine and the command". The machine exports `byId`, the
  engine re-exports it, and the command uses `TaskEngineXState.byId`. The task-ui keeps its own copy, because
  `packages/tui` never imports `packages/opencode`.
- Tasks touched: T1.2 (machine.ts, command.ts `external`), T1.6 (index.ts).

### 6. Two stale comments in the machine generator — fixed

- Where: `packages/opencode/src/task/engine-xstate/machine.ts:29` and `:362`.
- Severity: low (comments).
- Problem: the header said "Only this generator reads" `CLASS` and `DEAD`, but the engine's `view` reads `CLASS` and
  the walk key reads `isDead`. `EnterParams` had two JSDoc blocks; the first ("its status name") contradicted the
  second and the code (a `CLASS` key).
- Fix: `c4e961d2aa` "Correct two stale comments in the run machine generator".
- Tasks touched: T1.2, T1.5 (comments only).

### 7. The `block` action re-spells the `label` rule — fixed

- Where: `packages/opencode/src/task/engine-xstate/machine.ts:474`.
- Severity: low (duplication).
- Problem: the reason "blocked by <id>: <state with _ as space>" (AD-3) used `params.state.replaceAll("_", " ")`,
  while the file's `label` helper does exactly that and the outcome's dead lines use it.
- Fix: `3cb5a53fef` "Spell a blocked cause's state with the machine's label helper". The reason text is unchanged.
- Tasks touched: T1.3.

### 8. `schedule` shadows the module's `taskOf` — fixed

- Where: `packages/opencode/src/task/core/runner.ts:766`.
- Severity: low (naming).
- Problem: AD-20's `schedule` declared a local `taskOf(key)` that returns a plan `BlendModel.Task`, in a module whose
  top-level `taskOf(run, id)` is an Effect that returns the folded `TaskModel`.
- Fix: `547a0793fa` "Rename the scheduler's plan lookups so they no longer shadow taskOf" (`planTask`,
  `planScenario`).
- Tasks touched: T1.11.

### 9. The eslint exception names the old engine API — fixed

- Where: `eslint.config.mjs:34`.
- Severity: low (comment).
- Problem: the reason for turning off `effect/no-effect-runsync-unguarded` on the engine still read
  `apply(plan, state, fact) => State`; T1.6 replaced it with `apply(plan, snapshot, fact) => RunSnapshot` (AD-6).
- Fix: `c4fef295fa` "Name the snapshot engine API in the eslint runSync exception".
- Tasks touched: T1.6 (comment only).

## Observations not fixed

- **O1 — the external trust and the canonical walk (for T3.4 and T3.8).** `alphabet.ts:101` offers `outside.trusted`
  for an `external` region only while the log is empty, and the graph test's canonical interleaving takes only the
  first unit in context order that has a fact. Tasks come before external regions in that order. So in a subtree plan
  where one task is `ready` at start and another waits on an external region, the canonical walk starts the ready
  task first, the start-up step passes, and the external region is never trusted: the walk reports a stuck state that
  the real harness (which trusts external regions at start, T3.4) never reaches. No phase-1 walk has an external
  region, so nothing fails today. T3.8 must apply the start-up trusts before the canonical choice (or put external
  facts first at start-up). The failure is loud (a stuck state), not a silent pass.
- **O2 — `defect` is defined twice** (`machine.ts:1089`, `index.ts:56`). Left: sharing it means exporting a one-line
  private helper into the `TaskMachine` namespace.
- **O3 — `Run.state` holds a `RunSnapshot`.** The field keeps the name `state`, and `stateOf(run)` returns a `State`.
  A rename touches most of the runner, which phase 2 removes (T2.12). Left.
- **O4 — `Engine` moved from `core/model.ts` to `engine-xstate/index.ts`.** T1.6's notes said "`Engine` over
  `RunSnapshot`" in model.ts; keeping it there would make model.ts import the engine's snapshot type (a type cycle
  with the engine, which imports model types). `core/events.ts` now imports the `Engine` and `RunSnapshot` types from
  the engine. Type-only; no runtime dependency. Left as built.

## Checks after the fixes (HEAD `c4fef295fa`)

- `cd packages/opencode && bun test --timeout 120000` on machine, engine-api, engine-xstate, alphabet, core-runner,
  core-status, port-conformance and delegate: 152 pass, 0 fail (run in four groups so that each command stays under
  three minutes: 48 + 42 + 57 + 5).
- `bun test --timeout 160000 test/task/engine-xstate-random.test.ts -t "seed 1:"`: 1 pass.
- `bun x tsgo --noEmit -p packages/opencode`: exit 0.
- `bunx oxlint --deny-warnings` on the 7 changed files: 0 warnings, 0 errors.
- `bunx eslint packages/opencode/src/task --max-warnings=0`: exit 0.
- `prettier --check` on the changed files that were prettier-clean before (machine.ts, index.ts, eslint.config.mjs):
  clean. runner.ts, status.ts, model.ts and command.ts were not prettier-clean at the base, so they were edited by
  hand in their own style.
- Not run (the orchestrator runs them): the conformance suite, the full package suites, the 40 random seeds, the
  graph walks and the opt-in stale walk.

## Re-verification

The fixes change the code or the tested behaviour of T1.2, T1.3, T1.5 (comments only), T1.6, T1.11 and T1.12. No
state CLI verb was called for T1.

# Tasks: task-harness-feedback

Binding inputs: `../decisions.md` (D1–D27), `../ACs.md` (29), `../plan.md`, `../architecture/ARCHITECTURE-SPINE.md`
(AD-1..AD-20 and the owner answers), `../ux/EXPERIENCE.md`. Context: `context.md` (files, line numbers, SD-1..SD-16,
test patterns, standards by phase). Scenarios: `scenarios.gherkin`. Owner rulings and defaults: `spec.md`.

Order (`../plan.md`): parent T1 is phase 1 (one run machine), T2 phase 2 (live supervision), T3 phase 3 (validation
and fault folders), T4 phase 4 (task UI). T1.15 (the two live-check folders) comes first in phase 1: it was added
after numbering, so AC 6 holds at the checkpoint. The goal loop merges into `dev` after T1 (AC 7), runs the paid live check
after T4 (AC 27) and merges again (AC 28); those are not tasks here. Within a phase, tasks are in dependency order.

Every task: EFX-09 (v4 combinator names), EFX-01 (`Effect.fn` names), the module shape of `packages/opencode/AGENTS.md`,
no `any`, no `else`, no Promise API in harness code. Test commands never run from the repository root: `cd
packages/opencode && bun test --timeout 30000 <path relative to the package>`; `cd packages/tui && bun test --timeout
30000 <path>`. Typecheck `bun typecheck` (root) or in the package; lint `bun lint` (root). Conformance: `cd
packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1` (commit fingerprinted paths first).
Scenario tests (`verify-spec-<ID>.spec.ts` in `packages/opencode/test/task/`) start every test title with the
scenario id and a space; UI scenario tests delegate through `test/task/lib/delegate.ts` (SD-2).

## Task List

| ID | Name | Supports | Depends On |
| --- | --- | --- | --- |
| T1.15 | Two live-check folders (built in phase 1) | VF15, RM20 | — |
| T1.1 | Port conformance test | RM23 | — |
| T1.2 | Machine generator skeleton | RM1, RM2 | T1.1 |
| T1.3 | Readiness and cascade rows | RM7, RM9, RM13, RM15, RM16, RM17, RM28 | T1.2 |
| T1.4 | Outcome region | RM10, RM11, RM12, RM13, RM14, RM27 | T1.3 |
| T1.5 | History, causes, times, spans | RM5, RM7, RM9, RM24, RM25 | T1.4, T1.15 |
| T1.6 | Engine API over snapshots | RM1, RM3, RM6, RM8, RM28 | T1.5 |
| T1.7 | Engine tests as fact sequences | RM4, RM7–RM17, RM25, RM27 | T1.6 |
| T1.8 | Random fold and AD-5 tests | RM5 | T1.6 |
| T1.9 | Progress alphabet and walk key | RM19, RM20, RM22 | T1.6 |
| T1.10 | Graph proof | RM19, RM20, RM21, RM22 | T1.9, T1.15 |
| T1.11 | Phase-1 runner seam | RM10, RM17, RM18 | T1.6 |
| T1.12 | Phase-1 status projection | RM24 | T1.6 |
| T1.13 | Delegate helper and phase-1 task-ui check | RM26 | T1.12 |
| T1.14 | Conformance on the phase-1 engine | BUILD-6, RM18, BUILD-1, BUILD-2, BUILD-3, BUILD-4 | T1.7, T1.8, T1.10, T1.11, T1.12, T1.13 |
| T2.1 | State audit with interim allowlist | SV18 | T1.14 |
| T2.2 | Fact members for phase 2 | SV3, SV12 | T2.1 |
| T2.3 | AD-13 status contract and shared fixture | SV15, SV17 | T2.2 |
| T2.4 | Recorder and status writer | SV7, SV16, SV21 | T2.3 |
| T2.5 | TaskHarness service | SV8, SV13, SV20 | T2.4 |
| T2.6 | HarnessHooks routing beside the maps | SV13 | T2.5 |
| T2.7 | Stateless workers and session events | SV2, SV10, SV11 | T2.6 |
| T2.8 | Task supervisor | SV6, SV9, SV10, SV11, SV12, SV13, SV22, SV23, SV24 | T2.7 |
| T2.9 | Scenario supervisor | SV2, SV6, SV9 | T2.7 |
| T2.10 | Run supervisor | SV2, SV3, SV4, SV5, SV9, SV20, SV24, SV25 | T2.8, T2.9 |
| T2.11 | Cut-over: command, hooks, SessionPrompt | SV3, SV4, SV8, SV13, SV20, SV21, SV25 | T2.10 |
| T2.12 | Remove the polled runner, maps and watch | SV1, SV14 | T2.11 |
| T2.13 | Final phase-2 allowlist | SV1, SV14, SV18, SV19 | T2.12 |
| T2.14 | Conformance on the actors | BUILD-6, BUILD-1, BUILD-2, BUILD-3, BUILD-4 | T2.13 |
| T3.1 | `ensures` required | VF3, VF13 | T2.14 |
| T3.2 | Every failure in the refusal | VF1, VF2, VF19 | T3.1 |
| T3.3 | `spec.checked` and the run warning | VF4, VF5 | T3.2 |
| T3.4 | External regions and the subtree refusal | VF6, VF7, VF8, VF14, VF19, VF20, VF21 | T3.3, T3.5 |
| T3.5 | Six fault folders | VF9–VF14 | T3.1 |
| T3.6 | Fault-folder command test | VF9–VF14 | T3.2, T3.4, T3.5 |
| T3.7 | Live-check folders still load after D11 | VF15 | T3.1 |
| T3.8 | Graph walks of the fault folders that load | RM20 | T3.4, T3.5 |
| T3.9 | Scripted live-check runs | VF17, VF18 | T3.7 |
| T3.10 | Demo seed copies the example folders | VF16 | T3.5, T3.7 |
| T3.11 | README Validation section | DOC1 | T3.4, T3.6, T3.7 |
| T4.1 | taskView machine and adapter | UI2, UI3 | T3.11 |
| T4.2 | Store on tags and AD-13 | UI1, UI11, UI18, SV17 | T4.1 |
| T4.3 | Plugin wiring on the actor | UI2, UI3, UI21 | T4.2 |
| T4.4 | Shared region | UI5, UI9, UI10, UI16, UI21, UI22 | T4.3 |
| T4.5 | Peek BUILDER heading | UI5, UI9, UI11, UI21 | T4.3 |
| T4.6 | Board and Matrix | UI1, UI5, UI11, UI18, UI22 | T4.4, T4.5 |
| T4.7 | Gantt and HUD | UI4, UI11, UI15, UI5 | T4.4, T4.5 |
| T4.8 | Ledger, Dock, Ticker, full screen | UI6, UI15, UI16, UI17, UI18, UI19, UI21, UI5 | T4.4, T4.5 |
| T4.9 | Shortcut bar and animated mark | UI12, UI13, UI14, UI16 | T4.3 |
| T4.10 | Run header | UI6, VF8 | T4.2 |
| T4.11 | Closing summary | UI7, UI8, UI20, UI23 | T4.10 |
| T4.12 | Run usage | UI15 | T4.5, T4.7, T4.8, T4.11 |
| T4.13 | Final audit and task-ui README | SV18, SV19 | T4.6, T4.7, T4.8, T4.9, T4.12 |
| T4.14 | Final quality gate | BUILD-1, BUILD-2, BUILD-3, BUILD-4, BUILD-6 | T4.13 |

## Task Details

## Phase 1 — one run machine (parent T1; D1–D5, AD-1..AD-7, AD-20)

### T1.15: Add the two live-check folders under task-formats/blend

**File:** `task-formats/blend/example-scenarios.spec` (NEW)
**Depends On:** —
**Supports:** VF15, RM20
**Tests:** packages/opencode/test/task/blend.test.ts live-check
**Test Cases:**
- Happy Path — `example-scenarios.spec` loads with zero failures: a parent T1 (review `e1`; R2 needs a top-level `T<n>`), one leaf T1.1 (a small pure function and its test), and scenario S1 whose proof is a test titled with `[S1]`.
- Happy Path — `example-cascade.spec` loads with zero failures: a parent T1 (review `e1`); T1.1 proved only by a gate whose command always exits 1, with a `budgets: { taskAttempts: 1 }` policy override; T1.2 after T1.1; T1.3 with no `after`.
- Boundary — every `VERIFY.md` of both folders has `ensures`, so both still load after T3.1 makes it required (VF15 checks this again in T3.7).
- Boundary — each folder targets the demo seed (`test/task-harness/release-notes-repo`): its touches and test paths exist there or are created by the builder.
- Invalid Input — the gate's command exits 1 on every run, with no model and no network (the test runs it twice).
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** D15, AC 6, AC 7. Two folders: `example-scenarios.spec`, `example-cascade.spec`; each `SPEC.md` has an H1 title (D17); no `.ts` file inside them. Built in phase 1 (prepare-goal ruling, from the AC 6 and AC 7 text) so that the graph proof walks the loaded plans before the checkpoint merge. The id is out of sequence because the task was added after numbering; it has no dependency, so it comes first in phase 1.

### T1.1: Write the port conformance test for the probes the spine relies on

**File:** `packages/opencode/test/task/port-conformance.test.ts` (NEW)
**Depends On:** —
**Supports:** RM23
**Tests:** packages/opencode/test/task/port-conformance.test.ts (full suite)
**Test Cases:**
- Happy Path — a machine with a state id `#T1_4/budget_exhausted` resolves; a target `#T1.4/x` (with a dot) is split on `.` and does not resolve the intended node.
- State Transitions — a final state inside a parallel region still takes an event (its row runs); an `onDone` with a target in a sibling region re-enters the parallel region and resets its children (the reason AD-4 raises `run.settled` instead).
- State Transitions — a pure `transition` on a snapshot whose status is `done` still runs a microstep (the reason `apply` returns its input when the status is not `active`).
- Boundary — a raised event and a done event carry no `at` field; `snapshot.tags` is an array, not a `Set`; `snapshot.hasTag` works.
- Resource Limits — an eventless oscillation with `maxIterations: 1000` fails with a `TransitionError`; `getAdjacencyMap` with `limit: N` fails with "Traversal limit exceeded" once N dequeued edges pass, not N keys.
- Error Propagation — a `stateIn` guard on an unknown id gives a snapshot with status `error`, not a failed Effect.
- Empty / Null — `getAdjacencyMap(logic, {})` is accepted; calling it with no options is a type error (documented in a comment, not run).
- Concurrency, Security Boundaries, Timing — N/A (pure port probes).
**Notes:** Spine "Stack": "A port conformance test in `packages/opencode/test/task/` re-runs the 2026-10-14 probes that this spine relies on, so a port upgrade fails in CI and not in a run." Probes come from AD-1 (dot split), AD-2 (final state takes events), AD-4 (onDone target re-enters), AD-6 (transition on done; unknown-id guard gives an error snapshot), AD-5 (raised/done events lack `at`), AD-13 (tags array), AD-3 (maxIterations), AD-7 (limit counts edges, port `src/graph/adjacency.ts:72`). Imports: root `@jambudipa/xstate-effect` (`setup`, `stateIn`, `transition`, `initialTransition`, `createActor`) and `@jambudipa/xstate-effect/graph` (`getAdjacencyMap`). `transition` returns an Effect of `[snapshot, actions]`: run it with `Effect.runSync` in the test or with `testEffect`. Standards: EFX-34 (assert failures by tag).

### T1.2: Create the machine generator with regions, ids, meta and tags

**File:** `packages/opencode/src/task/engine-xstate/machine.ts` (NEW)
**Depends On:** T1.1
**Supports:** RM1, RM2
**Tests:** packages/opencode/test/task/machine.test.ts (full suite)
**Test Cases:**
- Happy Path — `config(releaseNotesPlan)` has root `type: "parallel"` with exactly `active` and `outcome`; `active` regions in order T1, T1.1, T1.2, T1.3, T1.4, T1.5, then S1 … S13 in natural order (`S2` before `S10`), then T8, T9 (kind `outside`).
- Happy Path — each task region is parallel with `evidence` (one sub-region per obligation in plan order: T1.4 has c1–c8, p1, f1, f2) then `work`; every obligation state is final (AD-2).
- Boundary — ids replace `.` with `_` (`T1_4/budget_exhausted`, `T1_4_c7/rejected`); `meta.unit` keeps the dotted id; `meta.kind` is one of `task | obligation | scenario | outside | external | run`; `meta.state` is the status-contract name (`ready` has meta state `waiting`).
- Invalid Input — a plan whose ids collide after the `.`→`_` replacement (for example `T1.1` and a unit `T1_1`) makes `machine(plan)` die with a defect naming the id (the port keeps the last of two equal ids silently).
- State Transitions — tags of each unit state are `<unit>:<tag>` from the closed vocabulary (class `waiting active ended stopped blocked dead`; phase `ready building proving verifying`); a test lists every tag of the generated config and fails on any other.
- Security Boundaries — the config has no `after`, no `invoke`, no `spawn` and no custom action anywhere (a recursive scan of the plain-data config); only `assign` and `raise` with no delay; `options.maxIterations` is 1000.
- Empty / Null — a plan with no scenarios and no outside ids gives `active` with task regions only; a plan with one leaf and no obligations is refused by the loader (D11), so the generator may assume at least one obligation per leaf.
- Concurrency, Timing — N/A (pure data).
- Empty / Null — a task with no obligations (possible in phase 1, before D11 lands in T3.1) gets no `evidence` sub-region: its task region holds only `work`, and it can still reach `trusted` as today; a test pins it.
- Boundary — an `after` id of a run task that names a folder task outside the plan (a subtree run) gets one region of kind `external` (`untrusted`, `trusted`, both final), so every `stateIn` id names a node and `initial` never returns an `error` snapshot (SD-7).
**Notes:** AD-1, AD-2. `machine(plan)` builds the config as plain data, exports it (`config(plan)`), then calls `setup(...).createMachine(config)`. Export `DEAD = ["needs_human", "budget_exhausted", "failed", "blocked"]` and `CLASS` (state → class tags, the AD-13 class table); they are AD-17 allowlist entries. Region order and id order use the natural collator (`Intl.Collator(undefined, { numeric: true })`, the `byId` order of `task-ui/store.ts`). Work states: `waiting`, `ready`, `building`, `proving`, `verifying`, `judging` (transient), finals `trusted`, `needs_human`, `budget_exhausted`, `failed`, `cancelled`, `blocked` (AD-2 table); `trusted` keeps its `obligation.stale` row. Scenario states: `waiting`, `ready`, `parked`, `verifying`, finals `trusted`, `rejected`, `failed`, `cancelled`, `blocked`, `parked`. Outside/external: `untrusted`, `trusted` (both final). The existing obligation and task rows of `engine-xstate/index.ts` (`obligationMachine` 174-219, `taskMachine` 319-475) give the fact rows to carry over (results, verdicts, retries, budget, review of a parent). Standards: EFX-07 (synchronous), EFX-18 (die on a broken invariant). External regions land here, in phase 1, so that a subtree plan has a node for every dependency; the D13 refusal and the trust of an external region at start land in T3.4 (SD-7).

### T1.3: Add the readiness and cascade rows and the dependency tags

**File:** `packages/opencode/src/task/engine-xstate/machine.ts` (UPDATE)
**Depends On:** T1.2
**Supports:** RM7, RM9, RM13, RM15, RM16, RM17, RM28
**Tests:** packages/opencode/test/task/machine.test.ts (full suite)
**Test Cases:**
- Happy Path — with the observed facts, the macrostep of T1.4's third failing proof ends with T1.4 `budget_exhausted`, T1.5 `blocked` and T1 `blocked` in one returned snapshot (RM7).
- State Transitions — the rows of a task `waiting` are, in order: one `blocked` row per (dependency, dead state) pair in dependency order then `needs_human, budget_exhausted, failed, blocked` order, then `ready` when every dependency is trusted; `ready` has the blocked rows then `waiting` when a dependency leaves `trusted` (RM15).
- Boundary — T1 depends on T1.1–T1.5 (children, natural order) and T1.5 on T1.3, T1.4, T9 (after, plan order); a task with two dead dependencies names the first in dependency order (RM9).
- Happy Path — `run.started` makes T1.1 and T1.2 `ready` in the same snapshot (RM16); a leaf whose `after` includes an untrusted outside id stays `waiting` and carries `T1.5:waits:T9`; `outside.trusted` T9 then makes it `ready` when its tasks are trusted (RM17).
- State Transitions — scenario `waiting` → `ready` when all needs trusted; → `parked` when every task need is trusted and an outside need is not; `parked` → `ready` on that trust; `parked` → `waiting` when a task need leaves `trusted` (RM13).
- Invalid Input — no row targets its own source state (a config scan); an oscillation guard: a test config that would loop fails with `TransitionError` instead of hanging.
- Boundary — dependency tags `<U>:waits:<D>` are on every state of D other than `trusted`, for each dependant U; they never appear on a trusted D.
- Concurrency, Security Boundaries, Timing — N/A (pure machine).
- Invalid Input — T1.5 (after T1.3, T1.4, T9): the config has no blocked row that names `#T9/<dead state>`, because outside and external regions have no dead state; a config scan requires every `stateIn` id to name an existing node (RM28); folding the observed facts keeps the status `active`, never `error`.
- Invalid Input — `outside.trusted { id: "T1.4" }` (a task id) returns the identical snapshot: no task region has an `outside.trusted` row.
- State Transitions — a dependant U already `building` when its dependency D is reopened by `obligation.stale` and then ends `budget_exhausted` is not blocked (blocked rows exist only on `waiting`, `ready` and `parked`); U may still end trusted, and the outcome is `budget_exhausted`.
**Notes:** AD-3, AD-2. Guards are `stateIn("#<dep id>/<state>")` on explicit ids only, never tags (AD-1). A blocked row's action has static params `{ id, state }` and sets `blockedBy = { id, state }` and the reason slot `blocked by <id>: <state with _ as space>`; an action cannot read the configuration. An id that names an `outside` (or, from T3.4, `external`) region names that region's `trusted` state. External regions arrive in T3.4 (SD-7).

### T1.4: Add the outcome region driven by active.onDone

**File:** `packages/opencode/src/task/engine-xstate/machine.ts` (UPDATE)
**Depends On:** T1.3
**Supports:** RM10, RM11, RM12, RM13, RM14, RM27
**Tests:** packages/opencode/test/task/machine.test.ts (full suite)
**Test Cases:**
- Happy Path — every task trusted and every scenario trusted gives outcome `done` with no reason (rule 4).
- State Transitions — `outcome` moves `running` ↔ `waiting` by a generated `stateIn` guard: `waiting` when no task is `ready`/`building`/`proving`/`verifying` and no scenario is `ready`/`verifying`; the history records neither move.
- Error Propagation — T1.1 `needs_human` first, T1.2 `failed` later, T1.3 blocked by T1.1: outcome `needs_human`, reason lines `T1.1 needs human`, `T1.2 failed`, `T1.3 blocked by T1.1` (rule 2, RM11).
- Boundary — one dead task while an independent task is `building`: no settle until the independent task is final (RM10); the queued `run.settled` that no longer holds is ignored by the last targetless row.
- Invalid Input — owner ruling 1: all tasks trusted, scenario S2 `rejected`: outcome `failed`, reason `acceptance not proved: S2 rejected`; a `failed` scenario gives `acceptance not proved: S3 failed` (rule 3, RM12).
- Empty / Null — a parked scenario at settle with no history entry, or one whose last entry is `waiting`: line `not run: S13 waits on T8` (outside needs not trusted, natural order, `, ` joined); rule 4 gives `done` with that reason (RM13).
- State Transitions — default 4: `run.cancelled` moves each non-final unit (task `waiting`, `ready`, `building`, `proving`, `verifying`; scenario `waiting`, `ready`, `verifying`) to `cancelled` with the fact's reason, final units keep their state, outcome `cancelled` (rule 1); `run.ended { state: "failed" }` gives outcome `failed` with its reason (RM14).
- Security Boundaries — no ancestor (region, `active`, root) has a row for `run.cancelled` or `run.ended`; `active.onDone` has no target and only raises `run.settled` (a config scan).
- State Transitions — RM27: T1.1 `budget_exhausted`, T1.2 `building`, S1 `waiting`, then `run.cancelled "user stop"`: outcome `cancelled` with reason `user stop` (rule 1 outranks rule 2); T1.2 and S1 `cancelled`; T1.1 stays `budget_exhausted`.
- Boundary — T1.2 `failed`, then T1.1 `needs_human`, both with the same `at`: the outcome is `failed` (the earliest dead entry by log index, not by `at` or id); the reason lines are in natural id order: `T1.1 needs human`, then `T1.2 failed`.
- Invalid Input — rule 3 with a parked scenario: S2 rejected and S13 parked give `acceptance not proved: S2 rejected` then `not run: S13 waits on T8`; S13 needing T8 and T9, both untrusted, gives `waits on T8, T9`.
**Notes:** AD-4, owner ruling 1, default 4. `outcome` live states `running`, `waiting`; finals `done`, `failed`, `needs_human`, `budget_exhausted`, `cancelled`. Every outcome row is also guarded by "every unit region is final". The reason action computes from `context.log` (last entry of each unit, `blockedBy` of a blocked entry) and static plan data; reason lines joined with `\n`. A stored `run.ended { state: "done" }` folds as a stop (rule 1, AD-6) — RM8 checks it in T1.7. The machine never takes a refusal (the command writes it).

### T1.5: Add the history, cause, time and span actions

**File:** `packages/opencode/src/task/engine-xstate/machine.ts` (UPDATE)
**Depends On:** T1.4, T1.15
**Supports:** RM5, RM7, RM9, RM24, RM25
**Tests:** packages/opencode/test/task/machine.test.ts (full suite)
**Test Cases:**
- Happy Path — each unit move appends one `{ at, unit, from?, to, reason? }` with status state names; the blocked entries of T1.5 and T1 have reason `blocked by T1.4: budget exhausted` (RM7).
- State Transitions — `waiting` ↔ `ready` ↔ `parked` toggles and `judging` append no entry, but the primary move of the same macrostep does; targetless rows (`task.repeated`, `task.stalled`, a stop note) append in their transition action.
- Boundary — `at` comes from `event.at`, or from the last log entry for a raised or done event; the `run.settled` rows use the last log entry; moves in the initial macrostep append nothing; `at` never decreases along the log.
- Happy Path — `startedAt` is set on the first move from a `waiting`-class or `ended`-class state into an `active`-class state; `endedAt` on a move into an `ended`-class state and cleared on a move out; a stale reopen of a trusted task restarts its clock; a blocked task has no `startedAt`.
- Happy Path — `spans`: `run.started` opens one span per task in its state; each status-name change closes the open span and opens the next; a move into an ended-class state adds a zero-length final span; a retry shows `building`, `proving`, `verifying` spans again.
- Concurrency — entries are appended by the target state's entry action (document order), so a fold and an actor restored from a snapshot give the same log (the T1.8 tests prove it).
- Empty / Null — the run's `startedAt` is the `at` of the slice's `run.started`; its `endedAt` is the last entry's `at` when the outcome becomes final; neither exists before.
- Boundary — RM25: on the loaded `example-cascade.spec` plan with fixed `at`, T1.1 gets `startedAt` at `task.started`, `endedAt` at the failing `task.proved`, spans `waiting, building, proving, budget_exhausted` (the last zero-length); blocked T1.2 has `endedAt` and no `startedAt`; `obligation.stale` on trusted T1.3 clears `endedAt` and sets a new `startedAt`.
- Boundary — the outcome entry: the running ↔ waiting toggles are not logged, so the run's final entry has `from` equal to the run's last logged state (`running`, from `run.started` or `run.resumed`); `run:running>done` and `run:running>cancelled` therefore occur (SD-14).
**Notes:** AD-5. The transition action only fills a per-unit slot `{ from, reason }`; the target state's entry action writes the entry (port `src/stateUtils.ts:2699`, `src/StateMachine.ts:1798`). One `at` helper for every action. No module other than the machine writes these values. RM24 relies on the reason and the blocked state through `view` (T1.12).

### T1.6: Replace the four machines and the fold code with the snapshot engine API

**File:** `packages/opencode/src/task/engine-xstate/index.ts` (UPDATE)
**Depends On:** T1.5
**Supports:** RM1, RM3, RM6, RM8, RM28
**Tests:** packages/opencode/test/task/engine-api.test.ts (full suite)
**Test Cases:**
- Happy Path — `initial(plan)` returns a snapshot with status `active` (it asserts so and dies otherwise); `apply(plan, snapshot, fact)` returns the next snapshot; `view(snapshot)` returns the `State` shape the status projection reads.
- State Transitions — `apply` returns its input unchanged when the snapshot's status is not `active`, including a fact after `done` (RM6).
- Invalid Input — `apply` with a snapshot made by another plan's machine dies (memoised `machine(plan)` by plan identity in a `WeakMap`); an unknown task id in a fact returns the identical snapshot.
- Boundary — a fact that changes nothing returns the identical snapshot (reference equality), and the input is never mutated.
- Error Propagation — every stored fact type of `FactSchema` folds; a stored `run.started` without `path` and a stored `run.ended { state: "done" }` fold (RM8).
- Happy Path — selectors `unitState`, `tags`, `waitingOn`, `blockedBy`, `ended` read the snapshot through `snapshot.hasTag` and meta; `waitingOn(T1.5)` is the D of each `T1.5:waits:*` tag while T1.5 carries `waiting`.
- Security Boundaries — the module no longer defines `obligationMachine`, `taskMachine`, `scenarioMachine`, `runMachine`, `stepTask`, `stepRun`, `cancel`, `staleAlone`, `follows`, `runSnapshot` or `settled` (a source test, RM3).
- Error Propagation — RM28: when the port returns a snapshot with status `error` (a guard on an unknown id reachable after `task.started`), `apply` dies with a defect naming the error; `apply` given an `error` snapshot dies too (the pass-through for a non-`active` status applies to `done` only).
- Boundary — the module `core/events.ts` loses its `ENDED` list (82); `ended` reads the engine selector; no other caller keeps a list of ended state names.
- Error Propagation — between T1.6 and T1.7 the old stop-at-once expectations of `engine-xstate.test.ts` fail by design; T1.6 keeps the workspace typecheck green by routing every read of the old tests and of `runner.ts`, `status.ts` and `command.ts` through `view(snapshot)` (minimal compile fixes only; T1.7, T1.11 and T1.12 finish them).
**Notes:** AD-6, D1. Keep `XStateEngine` and `TaskEngineXState` names (`index.ts:890, 892`); members `initial`, `apply` over an opaque `RunSnapshot`. Update `core/model.ts`: `TaskState` gains `blocked`; `ScenarioState` gains `blocked`, `cancelled`; `Engine` over `RunSnapshot`; `State` is selector output only. Update `core/events.ts`: `fold` returns a snapshot; `ended` reads the engine selector. Callers to update: `command.ts:14, 192, 204`, `runner.ts:125, 796, 833-858`, `status.ts`. Rewrite the header comment (20-49). Cost targets from AD-6: about 1.4 ms for a no-op fact, about 62 ms for `initial`. Standards: EFX-18 (a foreign snapshot is a defect). `engine-api.test.ts` (NEW) holds the selector, purity, foreign-snapshot and error-snapshot tests; `engine-xstate.test.ts` is rewritten by T1.7, which follows directly. RM28 narrows the AD-6 pass-through ("not active → return the input") to `done`; an `error` snapshot dies (SD-16).

### T1.7: Update the engine tests into fact sequences with the classification list

**File:** `packages/opencode/test/task/engine-xstate.test.ts` (UPDATE)
**Depends On:** T1.6
**Supports:** RM4, RM7, RM8, RM9, RM10, RM11, RM12, RM13, RM14, RM15, RM16, RM17, RM25, RM27
**Tests:** packages/opencode/test/task/engine-xstate.test.ts (full suite)
**Test Cases:**
- Happy Path — the header list names each of the 27 old tests and the 2 base tests once, as ported, re-baselined or retired, with its reason (RM4).
- State Transitions — re-baselined: the stop-at-once tests (old 6, 9, 11, 12, 13, 17, 21, 23, 24) now expect the run to keep running until every region is final (D3), with the dead task's state as the outcome; the waiting-on-cancel test (old 14) now expects the waiting parent `cancelled` (default 4); each names D3 or "default 4" in its title.
- Invalid Input — retired: the hand-built `State` tests (old 25, 26, 27 via `altered`) each name the guard that replaces them ("a foreign snapshot dies", "an unknown id returns the identical snapshot").
- Happy Path — RM7: the observed facts give T1.5 and T1 blocked in the returned snapshot with the named cause; RM8: a stored old-shape slice folds and a resume records only `run.resumed`.
- Boundary — RM9 transitive cascade and first-dead-dependency; RM15 ready only when after and children trusted, back to waiting on stale; RM16 siblings ready in one step; RM17 the outside wait and a second trust ignored.
- Error Propagation — RM11, RM12 (owner ruling 1 in the title), RM13 parked `not run` line, RM14 cancel and wall-clock stop.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** Owner ruling 2 ("Rewrite, keep intent"): each test keeps its intent; an expected outcome changes only where D2 or D3 changes it; the AC 2 evidence cites the header list. Keep the fixture plan of the old file (`T1` with leaves T1.1, T1.2, review T1.e1, scenarios S1, S2, outside T9, budget 3) and add the release-notes plan from `Blend.load`. Keep the `unfinishedBase` cases (B1, B2) through `TaskRunner` or the module it moves to. Assert through `view` and the selectors only.

### T1.8: Update the random fold test and add the AD-5 fold tests

**File:** `packages/opencode/test/task/engine-xstate-random.test.ts` (UPDATE)
**Depends On:** T1.6
**Supports:** RM5
**Tests:** packages/opencode/test/task/engine-xstate-random.test.ts (full suite)
**Test Cases:**
- Happy Path — 40 seeds × 100 random facts over the release-notes plan fold without a throw, including facts after `done` and unknown ids (T7, T7.c1, S99).
- Concurrency — for every seed, `apply` over the sequence equals a live actor of `machine(plan)` sent the same facts (`createActor` in a scope, `send`, read the snapshot after the mailbox drains).
- State Transitions — fold a prefix, restore an actor from that snapshot, send the suffix: equal to the full fold, log included.
- Boundary — the log grows if and only if `snapshot.value` or a context field other than the log changed.
- Happy Path — the required moves list gains `task:waiting>blocked` and keeps `task:building>budget_exhausted`, `run:running>done`, `run:running>cancelled`.
- Timing, Security Boundaries — N/A.
**Notes:** AD-5 tests (1)–(3), AD-6. Keep the mulberry32 generator and the seed count. Run each actor inside `Effect.scoped` (EFX-26).

### T1.9: Add the progress alphabet and the walk key

**File:** `packages/opencode/src/task/engine-xstate/alphabet.ts` (NEW)
**Depends On:** T1.6
**Supports:** RM19, RM20, RM22
**Tests:** packages/opencode/test/task/alphabet.test.ts (full suite)
**Test Cases:**
- Happy Path — a `ready` leaf gets `task.started` and `task.failed`; a `ready` parent gets `task.proved` (its review) and `task.failed`; ready scenarios get one `scenario.proved` for the batch.
- State Transitions — an active task phase gets abstract outcome facts (results all passed or one failed; verdicts all trusted or one rejected; `task.repeated`, `task.needs_human`, `task.failed`); an active scenario gets only `scenario.proved` passed then `scenario.verified` trusted.
- Boundary — an untrusted `outside` region gets `outside.trusted`; the alphabet never contains `run.cancelled`, `run.ended`, `task.stalled` or `task.nudged`; every fact has the same fixed `at`.
- Invalid Input — the key lists units in plan order by machine state key (never `meta.state`), plus attempts of each task that has not ended; an ended task is keyed by its state alone in the main walk.
- Concurrency, Timing — N/A.
- Boundary — an `external` region gets `outside.trusted` only in the start-up step of the walk (AD-7).
**Notes:** AD-7. Export `alphabet(snapshot)` and `walkKey(plan)(snapshot)`. The walks use plans loaded with `Blend.load` and `TaskCommand.plan` (SD-4).

### T1.10: Write the graph proof with its negative control and reduction check

**File:** `packages/opencode/test/task/engine-xstate-graph.test.ts` (NEW)
**Depends On:** T1.9, T1.15
**Supports:** RM19, RM20, RM21, RM22
**Tests:** packages/opencode/test/task/engine-xstate-graph.test.ts (full suite)
**Test Cases:**
- Happy Path — the release-notes main walk (canonical interleaving: only the first unit in document order with a fact gets its facts) finds 0 states that are not `done` and that no alphabet event moves; every visited snapshot has status `active` or `done` (RM19).
- Happy Path — the plans of `example-scenarios.spec` and `example-cascade.spec`, loaded with `Blend.load` and planned with `TaskCommand.plan`, each walk with 0 stuck states (RM20, AC 6 at the checkpoint).
- Error Propagation — negative control: a copy of the plain-data config without the AD-3 `blocked` rows yields the observed stuck state (T1.1–T1.3 trusted, T1.4 `budget_exhausted`, T1.5 and T1 `waiting`) (RM21).
- Boundary — reduction check on a small plan: the canonical walk and the full walk, with and without the blocked rows, give the same set of stuck states (RM22).
- State Transitions — the stale walk of the loaded `example-cascade.spec` plan with full interleaving adds `obligation.stale` for obligations of trusted or in-progress tasks, keys dead and blocked tasks' obligations as `-`, and finds 0 stuck states.
- Resource Limits — the first run measures each walk's edge count; `limit` is set to about 3 times it; each test has an explicit 60 s timeout; a test lists the context paths that guards read and fails when one is missing from the key.
- Timing — the release-notes walk finishes inside its 60 s timeout (the spine measured about 336 keys and 1 000 edges, about 8 s, on a model).
**Notes:** AD-7, D5, `@ASSUMPTION:A1.a`. `getAdjacencyMap(machine(plan), { events: alphabet, serializeState: walkKey(plan), limit })` from `@jambudipa/xstate-effect/graph` (options are required). The walk checks that the chosen unit's facts include one that changes the key. T3.8 adds the plans of the fault folders that load: the whole `example-outside-run.spec` plan and its T1.2 subtree.

### T1.11: Update the runner to the phase-1 seam on the run snapshot

**File:** `packages/opencode/src/task/core/runner.ts` (UPDATE)
**Depends On:** T1.6
**Supports:** RM10, RM17, RM18
**Tests:** packages/opencode/test/task/core-runner.test.ts (full suite)
**Test Cases:**
- Happy Path — `record` folds each fact with `apply` into the held snapshot; `schedule` starts a leaf (`begin`) or a parent's review proof only when the task is tagged `ready`, and a scenario batch only when scenarios are tagged `ready`; build, prove and verify follow the phase tags.
- State Transitions — the loop ends when the snapshot status is `done`; the runner never records `run.ended { state: "done" }`; `checkDone`, `follows` and the readiness check at `runner.ts:768` are gone (source assertions).
- Boundary — with one task dead and an independent task building, the loop keeps the independent worker running until the snapshot is `done` (RM10).
- Empty / Null — the `outside` Ref (64) and the trusted-outside set (108, 126-128, 859, 868-872) are gone; outside trust is read from the snapshot; directory-recorded trusts are applied as `outside.trusted` facts at start (RM17).
- Error Propagation — the existing pure exports (`taskClockStart`, `results`, `scenarioOutcome`, `latestVerdicts`, `unfinishedBase`) keep their tests green.
- Concurrency, Security Boundaries, Timing — the remaining phase-1 `Ref`s are allowed until T2.1 (AD-20).
- State Transitions — the runner's `ACTIVE` (646) and `JUDGED` (684) lists go with `checkDone` and the readiness check; the runner reads tags instead.
**Notes:** AD-20. The polled loop, `TICK`, `STALE_EVERY`, `failures`, `stopping`, `children`, `active` stay until phase 2 removes them (T2.12). `run.ended { state: "failed" }` from the run wall clock stays (AD-10). Keep `unfinishedBase` (used by `command.ts:191`).

### T1.12: Update the status projection to read the snapshot through view

**File:** `packages/opencode/src/task/core/status.ts` (UPDATE)
**Depends On:** T1.6
**Supports:** RM24
**Tests:** packages/opencode/test/task/core-status.test.ts (full suite)
**Test Cases:**
- Happy Path — `project` takes the snapshot, reads `view(snapshot)`, and emits today's fields; the task literal set gains `blocked`, the scenario set gains `blocked` and `cancelled`.
- State Transitions — folding the observed facts writes T1.5 and T1 with state `blocked` and reason `blocked by T1.4: budget exhausted` (RM24).
- Boundary — the `toEqual` expectations of `core-status.test.ts` (lines 57-168) are re-baselined only where the machine changes a state: a parked scenario still shows `waiting`, a verifying scenario still shows `pending`.
- Empty / Null — a status file written before the change still decodes with `TaskStatus.Status` (no new required field in phase 1).
- Error Propagation — the atomic write test stays green; a write failure is still only logged.
- Concurrency, Security Boundaries, Timing — N/A.
- Happy Path — RM26 fixture: an opencode test writes `packages/tui/test/task-ui/fixture-phase1.json` from the phase-1 `project` of the observed facts (fixed clock; `UPDATE_FIXTURE=1` rewrites it) and requires byte equality otherwise.
- Boundary — the T1.3 subtree test (`core-status.test.ts:121-136`) is re-baselined: T1.1 is an external region, and `waitingOn` of T1.3 is still `["T1.1"]`.
**Notes:** AD-20 ("`status.ts` projects through `view(snapshot)` with today's fields and the new state names. AD-13 lands in phase 2."). The TUI decodes states as open strings, so a phase-1 `blocked` task renders with the fallback glyph and its reason (SD-12). Update `command.ts` call sites that pass the engine (`192`, `204`).

### T1.13: Add the delegate helper and the phase-1 task-ui check

**File:** `packages/opencode/test/task/lib/delegate.ts` (NEW)
**Depends On:** T1.12
**Supports:** RM26
**Tests:** packages/opencode/test/task/delegate.test.ts (full suite)
**Test Cases:**
- Happy Path — `delegate("packages/tui", "test/task-ui/task-ui.test.tsx", "<pattern>")` runs `bun test --timeout 30000 <file> -t <pattern> --reporter=junit --reporter-outfile=<tmp>` in `packages/tui` and passes when the exit code is 0 and at least one named test passed.
- Error Propagation — a pattern that matches no test fails ("no test matched"), and a failing named test fails with its message.
- Boundary — the JUnit report is read with `Junit` (`src/task/proof/junit.ts`); skipped tests do not count as passed.
- Resource Limits — the child process has a timeout and is killed on interruption.
- Backwards Compatibility — RM26: a test in `packages/tui/test/task-ui/task-ui.test.tsx` renders the phase-1 status of the observed facts (RM24) with the unchanged task-ui; the Board shows T1.5 and T1 in STOPPED with the label `blocked` and their reason `blocked by T1.4: budget exhausted`; the verify file runs it through the helper.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** SD-2, SD-12. Every UI scenario test (`verify-spec-UI<n>.spec.ts`, and RM26) calls this helper with the TUI test names that prove it. It lands in phase 1 because RM26 proves what the checkpoint merge puts on `dev`. The RM26 TUI test reads `packages/tui/test/task-ui/fixture-phase1.json` (written in T1.12). Delegated verify tests run a nested `bun test`, so each gets an outer timeout of at least 120 s.

### T1.14: Update the conformance harness for the phase-1 engine and pass H1–H16

**File:** `packages/opencode/test/task-harness/conformance.test.ts` (UPDATE)
**Depends On:** T1.7, T1.8, T1.10, T1.11, T1.12, T1.13
**Supports:** BUILD-6, RM18, BUILD-1, BUILD-2, BUILD-3, BUILD-4
**Tests:** packages/opencode/test/task-harness/conformance.test.ts (full suite)
**Test Cases:**
- Happy Path — `bun run script/task-conformance.ts --arm o2 --runs 1` passes H1–H16 on the phase-1 branch.
- State Transitions — H3 (happy path with T9 trusted) accepts the `done` run with the reason line `not run: S13 waits on T8` (S13 parked, T8 untrusted, AD-4 rule 4); H4 accepts T1.5 `waiting` and S13 shown as `waiting`.
- Boundary — H7 (every attempt fails) expects T1.1 and the run `budget_exhausted` on the T1.1 subtree, where no dependant exists; H16 (cancel) expects T1.1, T1.2 and the run `cancelled`.
- Invalid Input — `arms/status.ts` accepts the states `blocked` and `cancelled` for scenarios.
- Error Propagation — the conformance guard reports no dirty fingerprinted path (commit the spec and suite edits first).
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AC 29 at the AC 7 checkpoint. This is the last task of phase 1: after its review the goal loop runs the full quality gate (BUILD-1..4, BUILD-6) and merges into `dev` (AC 7). `test/task-harness/arms/status.ts` is the second file this task touches. The Tests line runs only with `TASK_HARNESS_ARM=o2` set (the file skips every check without it); the gate itself is BUILD-6 (`bun run script/task-conformance.ts --arm o2 --runs 1`, which also runs the baseline arm as a diagnostic).

## Phase 2 — live supervision as actors (parent T2; D6–D9, AD-8..AD-13, AD-17, AD-19)

### T2.1: Write the state audit with the AD-17 entries and the interim allowlist

**File:** `packages/opencode/test/task/state-audit.test.ts` (NEW)
**Depends On:** T1.14
**Supports:** SV18
**Tests:** packages/opencode/test/task/state-audit.test.ts (full suite)
**Test Cases:**
- Happy Path — the audit scans every `.ts`/`.tsx` file under `packages/opencode/src/task/` and `packages/tui/src/task-ui/` and passes on the current tree with the allowlist.
- Invalid Input — planted fixtures (strings fed to the scanner, not files in `src`) each fail with file and identifier: a `Ref.make`, a `MutableHashMap.empty`, a `SynchronizedRef.make`, a `setInterval`, a `while (true)`, an `Effect.repeat`, an `Effect.forever`, a `Schedule.spaced`, a `Schedule.fixed`, a `Stream.tick`, a module-level `let`, and an array literal of lifecycle state names (`["waiting", "building", …]`).
- Boundary — a function-local `let` is not flagged; an xstate `after` row, a `Queue`, a `Stream.scan` and a `Semaphore` are not flagged.
- Error Propagation — an allowlist entry without a reason fails; an entry whose identifier no longer exists in its file fails (no stale entries).
- State Transitions — interim entries each name the task that removes them: `core/runner.ts` (its Refs, MutableHashMaps, `FiberMap`, `active`, `ACTIVE`, `let tick`, `let text`, `let nudges`, `while (true)`) → T2.12; `core/sessions.ts` (`activity`, `outcome`, `busy`, `while (true)`) → T2.12; `core/hooks.ts` (`ready`, `verdicts`, `repeated`, `limits`) → T2.12; `core/status.ts` `ACTIVE` → T2.3; `task-ui/store.ts` (`poll`, the view signals, `ACTIVE`, `ENDED`, `TONES`, `GLYPHS`) → T4.2, T4.3, T4.8; `task-ui/index.tsx`, `watch.tsx`, `peek.tsx` (polls, `root`, `target`, `armed`, `Effect.sleep`) → T4.3; `designs/3-board.tsx` `COLUMNS` state arrays → T4.6; `designs/5-gantt.tsx` `ENDED` use → T4.7; `designs/7-ticker.tsx` `ENDED` use → T4.8.
- Concurrency, Timing — N/A.
- Invalid Input — the audit also flags `FiberMap`, and the lists `ACTIVE`, `ENDED` and `JUDGED` (AD-17); in `packages/tui/src/task-ui/` it also flags `Effect.sleep` and any `Schedule` use (AD-16).
- Invalid Input — planted `for (;;)`, `do {} while (true)`, a module-level `var`, a module-level `new Map()`, a self-re-arming `setTimeout`, `Effect.repeatN` and `Effect.schedule` each fail, or the rule list names the construct as allowed with its reason.
- Boundary — the lifecycle-list rule: an array literal (or a `Set`/record built from one) with two or more members of the status vocabulary (any unit kind) fails outside the allowlist; the AD-4 cancel rows and every other generated list derive from `CLASS` in `engine-xstate/machine.ts`.
**Notes:** D9, AD-17, SD-8. The AD-17 final entries: `fromActor` (`task-ui/actor.ts`), `DISPLAY` (`task-ui/store.ts`), the five `*StateSchema` names (`core/status.ts`), `DEAD` and `CLASS` (`engine-xstate/machine.ts`), the `FactSchema` literal members (`core/events.ts`), `appender` and `awaitGroupGone` (`proof/process.ts`), `mergeRetry` (`core/workers.ts`, only if the polled-loop rule matches `Schedule`). Lands first in phase 2 (plan.md).

### T2.2: Add task.nudged and the run path to the fact list

**File:** `packages/opencode/src/task/core/events.ts` (UPDATE)
**Depends On:** T2.1
**Supports:** SV3, SV12
**Tests:** packages/opencode/test/task/engine-xstate.test.ts nudged
**Test Cases:**
- Happy Path — `task.nudged { task, nudge: 1 | 2, reason }` decodes and folds as a targetless `building` → `building` history entry with its reason.
- Boundary — `run.started` and `run.resumed` accept an optional `path`; a stored fact without `path` decodes (a whole-spec slice).
- Invalid Input — `nudge: 3` fails to decode; `asFact`/`asStored` still agree with the `Fact` union of `core/model.ts`.
- Error Propagation — every stored fact of the release-notes fixtures still decodes (durable v1, no version bump).
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AD-10, SD-5. `spec.checked` lands in T3.3. Add the matching machine row in `engine-xstate/machine.ts` (targetless, appends an entry).

### T2.3: Implement the AD-13 status contract and the shared status fixture

**File:** `packages/opencode/src/task/core/status.ts` (UPDATE)
**Depends On:** T2.2
**Supports:** SV15, SV17
**Tests:** packages/opencode/test/task/status-fixture.test.ts (full suite)
**Test Cases:**
- Happy Path — `project(plan, snapshot)` of the observed facts emits run `{ state, tags, reason?, spec, specId, path, title, startedAt, endedAt? }`, tasks with `state, tags, attempts, waitingOn, waitingOnOutside, reason?, blockedBy?, startedAt?, endedAt?, spans`, obligations, scenarios with `title`, `outside`, `external`, `history` (SV15).
- State Transitions — class tags follow the AD-13 table (blocked task: `ended, stopped, blocked`; budget exhausted: `ended, stopped, dead`; parked scenario: state `waiting`, tag `waiting`); tags in the fixed AD-1 vocabulary order; no phase or `waits:` tag in the file.
- Boundary — `waitingOn` is `[]` unless the unit carries `waiting`; `waitingOnOutside` is the subset of `waitingOn` that are keys of `outside`; an absent optional value is an absent key, never `null`.
- Happy Path — `write(directory, status, aliveAt?)` stamps `run.aliveAt`; `project` never emits it; the encoder keeps it because `TaskStatus.Status` declares it optional.
- Integrity — `status-fixture.test.ts` builds the projection with a fixed clock and requires byte equality with the NEW shared fixture `packages/tui/test/task-ui/fixture-projected.json`; `UPDATE_FIXTURE=1` rewrites it; one TUI test decodes it with `parse` (SD-10) (SV17).
- Backwards Compatibility — the TUI schema (open strings, new fields optional) decodes both the new fixture and a file from before the change.
- Empty / Null — `refused(...)` writes run `{ state: "refused", tags: ["ended", "stopped"], reason, spec, specId, path, title }` with empty unit maps.
- Boundary — `core/status.ts` `ACTIVE` (73) goes; the five contract schemas exist, `OutsideStateSchema` (outside and external `untrusted | trusted`) among them; `run.task { id, title }` is emitted for a subtree run.
- Error Propagation — the polled runner's `writeStatus` call site follows the new `project(plan, snapshot)` signature, so phase-2 runs keep writing the file until T2.11 moves the writer into the Recorder.
- Backwards Compatibility — RM26: the TUI test moves from `fixture-phase1.json` to `fixture-projected.json` and still shows T1.5 and T1 in STOPPED with `blocked`; `fixture-phase1.json` and its writer test are retired.
**Notes:** AD-13, D8, D17 (status fields), D20 (scenario `title`, from the loader with no leading id). `runState` (97-105) and `waitingOn` (94-95) and `trusted()` (86-91) go. Re-baseline `core-status.test.ts`. `cost` is not in the file. The old `fixture-status.json` stays untouched in phase 2, so the TUI tests that pin it stay green until T4.2 moves them to the projected fixture.

### T2.4: Create the Recorder and the status writer

**File:** `packages/opencode/src/task/core/recorder.ts` (NEW)
**Depends On:** T2.3
**Supports:** SV7, SV16, SV21
**Tests:** packages/opencode/test/task/recorder.test.ts (full suite)
**Test Cases:**
- Happy Path — `record(fact)` stamps `at` from `Clock.currentTimeMillis`, publishes to the run aggregate, and sends to the run actor, in that order, under one permit.
- Concurrency — two fibers recording at once: the store order equals the actor's fold order, and `at` never decreases (TestClock).
- State Transitions — once the run actor's status is `done`, `record` stores nothing and returns.
- Error Propagation — interrupting a caller mid-`record` leaves the fact either stored and folded or neither (`Effect.uninterruptible` from first step to last).
- Happy Path — the status writer (`Stream.merge(runActor.changes, touches, { haltStrategy: "left" })` with `Stream.scan`) writes once per committed macrostep, the final one included; a touch rewrites exactly the last consumed snapshot; no write follows the `done` snapshot (SV16).
- Resource Limits — touches go through `Queue.sliding(1)`, so a burst of touches gives at most one pending write; a touch after the run scope closed returns `void`.
- Timing — each write stamps `run.aliveAt` from the clock.
- State Transitions — SV21: with a stub finalizer added first to the run scope (standing in for the lease release, which arrives in T2.5), the status writer has stopped before that finalizer runs; the real order test is in T2.11.
- Concurrency — fiber A records the fact that makes the run `done` while fiber B waits on the permit: B stores nothing, so no fact follows `done` in the store (A's send is processed before the permit is released).
- Error Propagation — the EventV2 publish fails: no send to the run actor, and `record` fails to its caller (a worker failure); a `record` after the run scope closed stores nothing.
- Empty / Null — a touch before the first `changes` emission writes the restored snapshot or nothing and never throws; one failed `TaskStatus.write` is logged and the next macrostep still writes (the writer fiber does not end).
- Timing — on a resume whose clock reads below the last stored `at` (a new process), `at` is stamped as the larger of the clock and the last stored `at`, so the log never decreases (AD-5).
**Notes:** AD-9. The Recorder creates the run actor with `createActor(machine(plan), { snapshot: fold })` in the run scope (a root actor, no `systemId`). `record` is never called from an action, guard, delayed transition or subscribe callback: a supervisor invokes a `record` worker. Standards: EFX-24, EFX-25, EFX-26, EFX-28.

### T2.5: Create the TaskHarness service with leases and the session index

**File:** `packages/opencode/src/task/core/harness.ts` (NEW)
**Depends On:** T2.4
**Supports:** SV8, SV13, SV20
**Tests:** packages/opencode/test/task/harness.test.ts (full suite)
**Test Cases:**
- Happy Path — `run.live { directory }` answers `none`; `run.claim` answers `claimed`; a second `run.claim` for the directory answers `busy { runID, spec, path }`; `run.release` frees it (SV8).
- Error Propagation — a claim whose `BackgroundJob.start` fails is released in the same `Effect.onExit`, so the next `/task` is not busy (the test claims, fails the start, claims again).
- Happy Path — `session.claim { session, owner, watch }` adds an index entry; the claimer waits until the index holds it; removing `run:<runID>` removes every entry of that run (SV13).
- Security Boundaries — a forwarded `/task trust <id>` reaches the run supervisor of that directory only; the supervisor records `outside.trusted` only for an untrusted region of kind `outside`, never `external`.
- Boundary — `running(runID)` is true exactly when `system.get("run:<runID>")` is `Some`; system ids follow `run:<runID>`, `task:<runID>:<taskId>`, `scenario:<runID>:<scenarioId>`.
- Concurrency — the lease holds the checkout and git `Semaphore`s; two merges in one directory serialise.
- Timing — N/A.
- Happy Path — SV20: the harness root forwards `/task trust T9` to the actor registered as `run:<runID>` for that directory (a stub actor in this test); the record rule is tested in T2.10.
- Invalid Input — `run.claim` for `/repo`, `/repo/` and a symlink to `/repo` refer to one lease (the second and third answer `busy`); `run.release` with a run id that does not hold the lease changes nothing.
**Notes:** AD-8, AD-11, AD-19, owner ruling 3. `TaskHarness.node` is a global node (`makeGlobalNode`) depending on `Session`, `SessionStatus`, `InstanceStore`, `EventV2Bridge`, `BackgroundJob`, `Database`; never on `SessionPrompt`. `SessionPrompt.node` (`prompt.ts:1782-1812`) depends on `TaskHarness.node`. The `active` registry of `runner.ts:90` is replaced by the actor system. Standards: EFX-12, EFX-13.

### T2.6: Add the HarnessHooks routing beside the hook maps

**File:** `packages/opencode/src/task/core/hooks.ts` (UPDATE)
**Depends On:** T2.5
**Supports:** SV13
**Tests:** packages/opencode/test/task/harness-wiring.test.ts (full suite)
**Test Cases:**
- Happy Path — `task_ready` in a claimed builder session sends `hook.ready { session, summary? }` to its owner; `verdict` in a claimed verifier session sends `hook.verdicts`; the tools answer as today.
- Security Boundaries — a tool call in a session with no owner records nothing and says so in its reply (SV13).
- Invalid Input — an invalid verdict records nothing (pinned by `harness-wiring.test.ts`).
- Boundary — the repetition stop (wired into `prompt.ts` by T2.11): for a session with `watch: true`, `prompt.ts` reads `limit` from the owner's snapshot (no send before the read), runs the pure `repetition(limit, calls)`, ends the turn on a match and sends `hook.repeated`; limit 3 and the reason text are unchanged.
- State Transitions — the maps, `take*`, `watch` and `unwatch` stay beside the new routing until the cut-over (T2.11) and their removal (T2.12), so the polled runner keeps working and the typecheck stays green.
- Concurrency — the tools' async `execute` callbacks run the hook Effect with the context that `createTaskHarnessTools(agent, sessionID, hooks)` captured (EFX-31).
- Timing — N/A.
- Security Boundaries — `task_ready` in a session whose owner supervisor has stopped (`system.get` is `None`) records nothing and says so, as for an unowned session; a re-claim by a respawned supervisor replaces the owner.
**Notes:** AD-11. `HarnessHooks = { ownerOf(session), send(event), limitOf(session) }`, built in `SessionPrompt` from `TaskHarness`. Update `prompt.ts:1215-1216` (repetition), `1288` and `1714-1758` (`createTaskHarnessTools`). Keep `BUILDER`, `VERIFIER`, `shellEnvironment` (`tool/shell.ts:491`, `agent/agent.ts:286, 322`). Drop the matching interim entries of the audit allowlist. `prompt.ts` call sites switch to `HarnessHooks` in the cut-over task T2.11, not here.

### T2.7: Create the stateless workers and the session-events actor

**File:** `packages/opencode/src/task/core/workers.ts` (NEW)
**Depends On:** T2.6
**Supports:** SV2, SV10, SV11
**Tests:** packages/opencode/test/task/workers.test.ts (full suite)
**Test Cases:**
- Happy Path — `begin`, `builderTurn`, `proof`, `verifierPrompt`, `merge`, `scenarioProof`, `scenarioJudge`, `staleCheck`, `record`, `touch` each run one Effect and return; none holds state between calls.
- State Transitions — `sessionEvents` (a `fromCallback` actor) relays the session's part events as `turn.activity`, running tools as `turn.tool { running }`, and `SessionStatus.Event.Status` as `turn.status { type, message? }` (not the deprecated `Event.Idle`).
- Error Propagation — interrupting a worker runs its finalizer, which cancels its session turn within `limits.cancelDeadline`; a `proof` interrupted mid-process kills the process group (conformance H13 still passes).
- Boundary — `merge` merges the proved head, not the branch tip (pinned by `core-workspace.test.ts`), retrying at most 3 times (`mergeRetry`).
- Happy Path — the `builderTurn` worker uses the message builders and session create/prompt/cancel of `sessions.ts`; `TaskSessions.builderTurn` with its Refs and loop stays for the polled runner until T2.12.
- Security Boundaries — `staleCheck` reads the spec only under the lease's checkout lock and returns `{ spec, stale[], failures }`; from T3.3 it also records `spec.checked` itself (D12).
- Timing — N/A here (timers live in the supervisors).
- Concurrency — two sibling `begin` calls at the same moment (RM16) both create worktrees, one after the other on the lease's git lock.
**Notes:** AD-8, AD-11, D7. Move the pure runner exports (`results`, `scenarioOutcome`, `latestVerdicts`, `taskClockStart`) here or to the supervisor that uses them, and update `core-runner.test.ts` imports in T2.12. `sessions.ts` does not change here; T2.12 removes its Refs and loop. Workers hold the checkout lock for every merge, base-branch proof, scenario proof and stale check (AD-19).

### T2.8: Create the task supervisor with the event-driven builder watch

**File:** `packages/opencode/src/task/core/supervise/task.ts` (NEW)
**Depends On:** T2.7
**Supports:** SV6, SV9, SV10, SV11, SV12, SV13, SV22, SV23, SV24
**Tests:** packages/opencode/test/task/supervise-task.test.ts (full suite)
**Test Cases:**
- Happy Path — on `unit.moved` with phase tag `ready` the leaf supervisor invokes `begin` and records `task.started`; `building` runs builder turns; `proving` runs `proof` and records `task.proved`; `verifying` runs the verifier round (`ask`, `collect`, `askMissing`, `collect`) and records `task.verified`; after recording it waits quietly until a new `entry` arrives.
- Timing — a stall: no `turn.activity` for `streamIdle` while no tool runs → cancel the turn, record `task.stalled`, prompt again with the continue message in the same attempt; `turn.activity` re-enters and restarts the timer; the timer is absent while a tool runs (SV10, TestClock).
- Error Propagation — a spend cap in a `retry` status message or in the turn's assistant error records `task.needs_human` with reason `spend cap: …` before any nudge (SV11; conformance H14).
- State Transitions — idle without `task_ready` records `task.nudged` 1 then 2; after the last nudge, `task.ready` (proof on the head) or a failed `task.proved` with `the builder ended without task_ready` (SV12).
- Boundary — 3 worker failures in a row record `task.failed` with reason `harness error: …`; a success resets the count (SV6).
- Security Boundaries — the supervisor claims its session before every turn (new or reused) and holds `ready`, `verdicts`, `repeated`, `limit` and the nudge count in its context (SV13); it records only facts the alphabet allows for its unit's state, plus stall and nudge (SV9).
- Concurrency — the task wall clock is a delayed transition; it records `task.failed` when it expires.
- Timing — SV22: the task wall clock of one task records `task.failed` with the wall-clock reason; an independent task keeps building.
- Timing — SV23: while `turn.tool { running: true }`, passing `streamIdle` records no `task.stalled`; the stall timer starts again when the tool ends.
- State Transitions — SV24: on resume, a new supervisor that reuses an existing builder session claims it and waits for the index entry before the prompt; `task_ready` from it reaches the new supervisor.
- Concurrency — after recording `task.stalled` or `task.nudged`, the `unit.moved` for that entry (tag `building`) sends exactly one continue or nudge prompt, and no second builder turn starts.
- State Transitions — a failed proof returns the task to `building` (attempt 2): the nudge count and the `ready` flag reset, the next idle records `nudge: 1`, and a `hook.ready` left from attempt 1 does not move attempt 2 to proving.
- Timing — a supervisor spawned on resume for a task that started 50 min ago, with a 60-min `taskWallClock`, records `task.failed` after 10 min (counted from `taskClockStart`), not after 60.
**Notes:** AD-8, AD-10, AD-11, D7. File `packages/opencode/src/task/core/supervise/task.ts` inside the NEW folder. The supervisor branches only on phase tags in `unit.moved { unit, entry, state, tags }`, never reads the run actor to choose its phase, and moves the lifecycle only by recording facts through a `record` worker. Delays come from `TaskLimits` (`streamIdle`, `taskWallClock`, `cancelDeadline`).

### T2.9: Create the scenario supervisor with its judge round

**File:** `packages/opencode/src/task/core/supervise/scenario.ts` (NEW)
**Depends On:** T2.7
**Supports:** SV2, SV6, SV9
**Tests:** packages/opencode/test/task/supervise-scenario.test.ts (full suite)
**Test Cases:**
- Happy Path — a scenario in `verifying` gets a judge round; the supervisor records `scenario.verified` with the verdict.
- Error Propagation — 3 judge worker failures in a row record `scenario.verified` with a rejected verdict whose reason starts `harness error:` (SV6).
- State Transitions — the supervisor stops when its scenario leaves `verifying`; it owns the judge session's hooks (`hook.verdicts`).
- Security Boundaries — it records only `scenario.verified` for a `verifying` scenario (SV9).
- Boundary — a missing verdict id triggers `askMissing` once, then the round ends.
- Concurrency, Timing — N/A beyond the run supervisor's batch.
**Notes:** AD-8. The `scenarioProof` batch for `ready` scenarios belongs to the run supervisor (T2.10).

### T2.10: Create the run supervisor with its parallel timer regions

**File:** `packages/opencode/src/task/core/supervise/run.ts` (NEW)
**Depends On:** T2.8, T2.9
**Supports:** SV2, SV3, SV4, SV5, SV9, SV20, SV24, SV25
**Tests:** packages/opencode/test/task/supervise-run.test.ts (full suite)
**Test Cases:**
- Happy Path — the first state records `run.started { path }` (or `run.resumed { path }`) through a `record` worker and defers every other event; it registers as `run:<runID>` before it reads the directory's trusts; then it records `outside.trusted` for each directory-recorded outside id.
- State Transitions — it spawns a task supervisor for each task tagged `ready` or `active` and a scenario supervisor for each scenario in `verifying`, at most one per unit, and stops it when the unit leaves those tags; it sends `unit.moved` once per new history entry of the unit (SV2).
- Concurrency — `heartbeat` (`beating` → `touching` after 5 s → `touch` → back), `wallClock` (one delayed `record` of `run.ended { state: "failed" }`) and `staleCadence` (`waiting` → `checking` after 1 s) are separate regions; with `staleCheck` held on the checkout lock, advancing the TestClock by 5 s gives one touch (SV5).
- Error Propagation — a failed `touch` is logged, never counts toward a failure rule, and records no fact.
- Happy Path — `staleCheck` results: a changed hash records `obligation.stale`; a valid reload assigns the new spec and sends `spec.reloaded` to unit supervisors (conformance H9).
- Boundary — when the run actor's status is `done` every timer region moves to `stopped` and `main` reaches `closed` (the summary step arrives in T4.11, SD-6).
- Timing — cancel: when the job is cancelled while the supervisor is in `staleCheck`, the cancel finalizer records `run.cancelled`, waits up to `limits.cancelDeadline` for the supervisor to be final, then stops it; the store and the file hold `run.cancelled` (SV4).
- Happy Path — SV20: trusts recorded on the directory aggregate before the run are applied once, directly after `run.started`; a forwarded trust during start-up is deferred, then applied once.
- State Transitions — T1.2 trusted makes T1.3 `ready` with no new T1.3 history entry (toggles append none): the run supervisor spawns the T1.3 supervisor with its current state and tags as input, and `begin` runs once; a `building` task on resume is spawned the same way.
- Concurrency — two T1.4 entries (`proving`, then `building`) commit before the run supervisor sees them: the task supervisor starts only the `building` work, and no proof starts for the replaced entry.
- Error Propagation — `staleCheck` failing 3 times in a row logs each failure, records no fact, and the cadence continues.
- Security Boundaries — the directory aggregate holds trusts for T9 (outside), T1.1 (an external region of this run) and T1.4 (a task): at start only `outside.trusted T9` is recorded.
- Integrity — SV25: the cancel finalizer of a job cancelled before `run.started` is stored waits until the supervisor stores `run.started` (or `run.resumed`) and records `run.cancelled` after it, so the cancel never lands in the previous slice.
**Notes:** AD-8, AD-12, D6. No transition in one region targets another region's state; no timer row uses `reenter`. The fold invokes nothing: invocation happens only in supervisors (D6). Scenario batch: `scenarioProof` for the `ready` scenarios records `scenario.proved`, 3 worker failures record its failure fact.

### T2.11: Wire the command, the hooks and SessionPrompt onto the harness in one cut-over

**File:** `packages/opencode/src/task/core/command.ts` (UPDATE)
**Depends On:** T2.10
**Supports:** SV3, SV4, SV8, SV13, SV20, SV21, SV25
**Tests:** packages/opencode/test/task/core-command.test.ts (full suite)
**Test Cases:**
- Happy Path — the checks run in the AD-19 order: usage, loader, task folder (R2), `run.live`, git readiness, unfinished base, the slot for the D13 check (filled by T3.4), `run.claim`, `BackgroundJob.start`.
- Permissions — with a run live in the directory, `/task` on a valid spec answers one busy line naming the live run's spec folder and `/task` path, writes no file and starts nothing (SV8; owner ruling 3; wording from EXPERIENCE "Busy reply").
- State Transitions — resume: the latest slice not ended and with the same path → fold, `run.resumed { path }`; a different path or an ended slice → a new slice with `run.started { path }`; a stored slice without `path` counts as a whole-spec slice (SV3).
- Error Propagation — a failed `BackgroundJob.start` releases the claim in the same `Effect.onExit`.
- Boundary — the job body opens the run scope; the lease release is its first finalizer (so it runs last), then the Recorder, then the cancel finalizer, then the spawn of the run supervisor; the job waits for `closed` (SV4).
- Security Boundaries — `/task` still makes no model request and takes no session run lock (`prompt.test.ts:2476`); the job id is the run id with `metadata.parentSessionId` (H16).
- Timing — N/A.
- Permissions — SV21: after a run ends done and after a cancel, the next `/task` in the directory is not busy; SV20: `/task trust <id>` records on the directory aggregate, then sends the trust to the harness root.
- Concurrency — two `/task` calls both pass `run.live`; the second `run.claim` answers `busy`, so the second call answers the busy line, writes no file, starts no job, and the first claim stays.
- Error Propagation — `BackgroundJob.start` answering "already running" releases the claim; a defect in the job body still runs the lease release; in both cases the next `/task` is not busy.
- Boundary — `/task task-formats/blend/release-notes.spec/` and `./task-formats/blend/release-notes.spec` resume the slice started with `task-formats/blend/release-notes.spec`: the path is normalised before it is compared and stored.
- Invalid Input — a resume after the spec dropped an id that the slice's facts name folds without a throw (facts for unknown ids leave the snapshot unchanged); one plan instance feeds both the fold and the Recorder's `createActor` (memoised by identity).
- Happy Path — the cut-over: `prompt.ts` passes a `HarnessHooks` value into `createTaskHarnessTools(agent, sessionID, hooks)` (`prompt.ts:1288, 1714-1758`) and into the repetition check (`1215-1216`); `SessionPrompt.node` depends on `TaskHarness.node`; `/task` starts every run on the harness, and the polled runner starts none.
**Notes:** AD-8, AD-19, AD-6. Replaces the per-run busy check (`command.ts:178-179`) with the directory lease. Fake `Ops` in `core-command.test.ts` stays three members until T4.11. This is the single cut-over point of phase 2: before it the polled runner runs every run; after it the supervisors do; T2.12 then deletes the old code.

### T2.12: Remove the polled runner, the hook maps and the polled builder watch

**File:** `packages/opencode/src/task/core/runner.ts` (DELETE)
**Depends On:** T2.11
**Supports:** SV1, SV14
**Tests:** packages/opencode/test/task/core-runner.test.ts (full suite)
**Test Cases:**
- Happy Path — the run proceeds through the supervisors only; no module defines `loop`, `tick`, `TICK`, `STALE_EVERY`, `checkDone`, `failures`, `MAX_FAILURES`, `stopping`, `children`, `active`, `trustActive` or the `FiberMap` of workers (a source test, SV1).
- Error Propagation — `core-runner.test.ts` keeps its pure tests (task wall clock start, proof results, scenario results, latest verdicts) against their new module.
- Boundary — `unfinishedBase` keeps its behaviour for `command.ts` (B1, B2 of the old engine tests).
- State Transitions — a live run is found by `system.get("run:<runID>")`.
- Concurrency, Security Boundaries, Timing — N/A.
- State Transitions — SV14: `core/hooks.ts` holds no `MutableHashMap` (`ready`, `verdicts`, `repeated`, `limits`, `take*`, `watch`, `unwatch` are gone); `TaskSessions.builderTurn` with its `activity`, `outcome`, `busy` Refs and `while (true)` loop (256-300) is gone; `harness-wiring.test.ts` round trips go through `HarnessHooks`.
**Notes:** D6, AD-8. If a thin `runner.ts` must remain for an export, it holds no state; otherwise delete the file and update `core/index.ts`. Drop the runner's interim audit entries. Other files: `core/hooks.ts`, `core/sessions.ts`, `test/task/harness-wiring.test.ts`.

### T2.13: Validate the final phase-2 allowlist of the state audit

**File:** `packages/opencode/test/task/state-audit.test.ts` (UPDATE)
**Depends On:** T2.12
**Supports:** SV1, SV14, SV18, SV19
**Tests:** packages/opencode/test/task/state-audit.test.ts (full suite)
**Test Cases:**
- Happy Path — SV19 (phase-2 half): the entries for `packages/opencode/src/task/` equal the AD-17 entries for that tree; the `task-ui` interim entries remain and each names its phase-4 task; T4.13 checks the whole list.
- Invalid Input — every planted construct still fails (SV18).
- Boundary — no interim entry for `core/runner.ts`, `core/sessions.ts` or `core/hooks.ts` remains; the `task-ui` interim entries remain until T4.13 and each names its task.
- Error Propagation — an entry that matches nothing fails.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AD-17, SD-8.

### T2.14: Update the conformance harness for the actors and pass H1–H16

**File:** `packages/opencode/test/task-harness/conformance.test.ts` (UPDATE)
**Depends On:** T2.13
**Supports:** BUILD-6, BUILD-1, BUILD-2, BUILD-3, BUILD-4
**Tests:** packages/opencode/test/task-harness/conformance.test.ts (full suite)
**Test Cases:**
- Happy Path — H1–H16 pass on the o2 arm with the supervisors.
- Error Propagation — H8 (crash and resume) resumes by the same path; H12 (stall) has a stall history entry and attempts 1; H13 (hung proof) is bounded; H14 (529 retried; spend cap gives `needs_human` with at most 2 requests); H15 (repetition) stops after the third identical call; H16 (cancel) cancels T1.1, T1.2 and the run with no late requests.
- Boundary — `arms/status.ts` reads the AD-13 fields (tags, `title`, `aliveAt`) as optional.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AC 29 at the end of phase 2. Commit the fingerprinted paths before the run. The Tests line runs only with `TASK_HARNESS_ARM=o2` set; the gate itself is BUILD-6.

## Phase 3 — validation and fault folders (parent T3; D10–D15, AC 1)

### T3.1: Update the VERIFY.md schema so that ensures is required

**File:** `packages/opencode/src/task/blend/schema.ts` (UPDATE)
**Depends On:** T2.14
**Supports:** VF3, VF13
**Tests:** packages/opencode/test/task/blend-messages.test.ts (full suite)
**Test Cases:**
- Invalid Input — a `VERIFY.md` front matter with no `ensures` gives R3 `(root): 'ensures' is a required property` (VF3).
- Happy Path — `release-notes.spec` and `provider-ordering-admin.spec` load with zero failures; the golden model and the 38 negative cases are unchanged.
- Boundary — `ensures: {}` still fails `minProperties 1` with today's message.
- Error Propagation — the seven existing `VerifyFrontMatter` message cases (lines 79, 122, 146, 152, 158, 164, 170) add `ensures` to their YAML so their expected messages are unchanged.
- Concurrency, Security Boundaries, Timing — N/A.
- Boundary — the JSON schema `task-formats/blend/schema/verify.schema.json` lists `ensures` in its top-level `required`; the schema drift check stays green.
**Notes:** D11. Also update `task-formats/blend/schema/verify.schema.json` with `required: ["ensures"]` for parity (the JSON schema drift check keeps them equal). Conformance fingerprints the spec trees: commit before the next conformance run.

### T3.2: Update the command to list every loader failure in the refusal

**File:** `packages/opencode/src/task/core/command.ts` (UPDATE)
**Depends On:** T3.1
**Supports:** VF1, VF2, VF19
**Tests:** packages/opencode/test/task/core-command.test.ts (full suite)
**Test Cases:**
- Happy Path — a spec with three loader failures: the session message is `Refused <path>: 3 failures. No work started.`, then each `R<n> <path>: <message>` in loader order, then `Fix each line, then type /task <path> again.`; `run.reason` is exactly the failure lines joined with `\n` (VF1).
- Boundary — one failure reads `1 failure`; the git readiness refusals read `Refused <path>. No work started.` then their one plain line and no hint.
- Permissions — with a run live in the directory, a faulty spec gets its refusal in the session only and `status.json` keeps the live run (VF2).
- Error Propagation — the fallback when no spec and no failure returns (`R1 .: the spec did not load`) stays one line.
- Invalid Input — the not-inside-a-spec-folder refusal keeps `spec = args`.
- Security Boundaries — no model request on any refusal (conformance H1, H2).
- Concurrency, Timing — N/A.
- Boundary — VF19: one failure reads `Refused <path>: 1 failure. No work started.`, its line, then `Fix each line, then type /task <path> again.`; a checkout refusal reads `Refused <path>. No work started.` and one plain line, with no hint.
**Notes:** D10, AD-14, AD-19, SD-9; texts from EXPERIENCE "Refusal". Re-baseline the two exact strings in `core-command.test.ts:70, 85` to the new header form. `TaskStatus.refused` holds the multi-line reason.

### T3.3: Add spec.checked and the run warning for a spec that stops validating

**File:** `packages/opencode/src/task/core/supervise/run.ts` (UPDATE)
**Depends On:** T3.2
**Supports:** VF4, VF5
**Tests:** packages/opencode/test/task/supervise-run.test.ts spec.checked
**Test Cases:**
- Happy Path — a reload that does not validate keeps the plan and the spec, and records `spec.checked { failures }` once; the machine sets the run warning and adds a run history entry; `status.json` `run.warning` holds one `R<n> <path>: <message>` line per failure (VF4).
- State Transitions — the next reload that validates records `spec.checked { failures: [] }`, which clears the warning (VF5).
- Boundary — a reload with the same failure list as the current warning records nothing; a valid reload that adds or removes an obligation id of the plan records a `spec.checked` failure and keeps the old text.
- Error Propagation — `staleCheck` reads under the checkout lock and records nothing itself; the run supervisor records in one transition after assigning the spec.
- Concurrency — obligation-stale and spec-checked facts from one reload are recorded by one `record` worker in a fixed order.
- Timing — N/A.
- State Transitions — a resumed slice whose last `spec.checked` had 2 failures, with the spec now valid: the first stale check records `failures: []`; a valid reload that changes a hash and adds an obligation id records only the `spec.checked` failure (the run keeps the old text), with no `obligation.stale`.
- Happy Path — D12 / AC 14: the stale-check worker itself records `spec.checked` through the Recorder (it receives the run's current warning as input and records only when the list differs); `obligation.stale` keeps the AD-12 path (the run supervisor assigns the new spec, then records).
- Invalid Input — SD-15: an added obligation id reads `R3 <task folder>/VERIFY.md: obligation <id> is not in the loaded plan; the run keeps the plan it loaded`; a removed one reads `R3 <task folder>/VERIFY.md: obligation <id> of the loaded plan is missing; the run keeps the plan it loaded`.
**Notes:** D12, AD-10, AD-12, AD-14, SD-5. Add `spec.checked { failures: { rule, path, message }[] }` to `FactSchema` (`core/events.ts`) and its row to `engine-xstate/machine.ts` (targetless; sets or clears the run warning). Project `run.warning` in `core/status.ts`. The summary's warning line (T4.11) reads the slice's `spec.checked` entries. Defect 8 in spec.md: AD-12 has the run supervisor record `spec.checked`; D12 and AC 14 say the stale-check actor records it, and the ACs outrank the spine, so the worker records it.

### T3.4: Add external regions and the subtree refusal

**File:** `packages/opencode/src/task/core/command.ts` (UPDATE)
**Depends On:** T3.3, T3.5
**Supports:** VF6, VF7, VF8, VF14, VF19, VF20, VF21
**Tests:** packages/opencode/test/task/core-command.test.ts subtree
**Test Cases:**
- Happy Path — `/task <spec>/T1-release-notes.task/T1.3-markdown-render.task` with no stored run is refused at the start with `R12 <T1.3 folder>: T1.3 is after T1.1, which is outside this run and not trusted` and the hint `Run the whole spec, or a folder that holds T1.1.` (VF6).
- State Transitions — with a stored slice in which T1.1 ended trusted, the same subtree run starts; the run supervisor records `outside.trusted` for the external region T1.1 directly after `run.started` (VF7).
- Security Boundaries — `/task trust T1.1` writes the directory aggregate but never moves an `external` region; only `outside` regions take a forwarded trust (VF7).
- Boundary — trust is read by folding each stored slice through its own plan's machine; the latest slice whose plan holds the task (as a task region or an external region) decides.
- Happy Path — a subtree run that leaves scenarios out names them in its start message and in `metadata.taskHarness.header.leftOut` (VF8; the header itself lands in T4.10, so this task writes `leftOut` into the start message text).
- Invalid Input — a subtree with two untrusted outside folder tasks gives one R12 line each, in natural id order.
- Error Propagation — `example-outside-run.spec` loads with zero failures as a whole spec and refuses as the T1.2 subtree (VF14).
- Boundary — VF20: a slice with T1.1 trusted followed by a later slice with T1.1 `budget_exhausted`: the later slice decides, so the T1.3 subtree is refused with the R12 line.
- Happy Path — VF19: the subtree refusal ends with the hint `Run the whole spec, or a folder that holds T1.1.`
- Security Boundaries — VF21: T1.1 trusted only through `/task trust T1.1` (the directory aggregate) and in no slice: the T1.3 subtree is still refused with R12.
- Boundary — VF21: slices [whole spec: T1.1 trusted] then [whole spec: T1.1 reopened and cancelled]: refused; [whole spec: T1.1 trusted] then [T1.4 subtree with no T1.1 region]: runs; an old slice with no path and T1.1 trusted: runs.
- Error Propagation — a stored slice whose `path` no longer loads never crashes the command: it refuses with one plain line that names the slice's path (SD-13).
- Boundary — the T1.5 subtree with T1.3 trusted and T1.4 and T9 untrusted gives one R12 line (T1.4) and T9 stays an outside wait; an `after` inherited through `afterEffective` also gets an external region; two R12 lines give the hint `Run the whole spec, or a folder that holds T1.1 and T1.2.`
**Notes:** D13, AD-6, AD-14, AD-15, SD-7, `@ASSUMPTION:A3.a`. `TaskCommand.plan` gains `external` ids (folder tasks outside the run that a run task is after) and reports the scenarios it leaves out (today they are dropped silently at `command.ts:106`). `engine-xstate/machine.ts` has had `external` regions since T1.2. Re-baseline the T1.3 subtree test of `core-status.test.ts:121-136` (T1.1 is now an external region). Conformance H5–H7 and H10–H15 use the T1.1 subtree, which has no folder dependency, so they are unaffected. Other files: `core/supervise/run.ts` (records `outside.trusted` for each trusted external region directly after `run.started`), `core/status.ts` (already projects `external`).

### T3.5: Add the six fault folders under task-formats/blend

**File:** `task-formats/blend/example-format-faults.spec` (NEW)
**Depends On:** T3.1
**Supports:** VF9, VF10, VF11, VF12, VF13, VF14
**Tests:** packages/opencode/test/task/blend.test.ts example
**Test Cases:**
- Invalid Input — `example-format-faults.spec`: a stray file (`notes.txt`) gives R1; a `TASK.md` with no H1 gives R4; an unknown front-matter key gives R3 — and nothing else.
- Invalid Input — `example-cycle.spec`: T1.1 after T1.2 and T1.2 after T1.1 gives only R7 `order has a cycle: …`.
- Invalid Input — `example-self-after.spec`: T1.1 after T1.1 gives R7 with the cycle `T1.1 → T1.1`.
- Invalid Input — `example-unknown-after.spec`: `after: [T7]` gives R6 `after names unknown task T7`.
- Invalid Input — `example-no-ensures.spec`: a leaf `VERIFY.md` with no `ensures` gives R3.
- Happy Path — `example-outside-run.spec` (T1.2 after T1.1) loads with zero failures.
- Boundary — apart from its planted faults, each folder is a small valid spec (one parent, two leaves, one gate) so the loader reports only the planted rules.
**Notes:** D14. Six folders: `example-format-faults.spec`, `example-cycle.spec`, `example-self-after.spec`, `example-unknown-after.spec`, `example-no-ensures.spec`, `example-outside-run.spec`. A spec folder cannot hold its own expected result (R1 refuses a stray file), so the expectations live in `fault-folders.test.ts`. No `.ts` file inside the folders. The conformance fingerprint covers only the two shipped specs.

### T3.6: Write the fault-folder test that runs the real /task command on each folder

**File:** `packages/opencode/test/task/fault-folders.test.ts` (NEW)
**Depends On:** T3.2, T3.4, T3.5
**Supports:** VF9, VF10, VF11, VF12, VF13, VF14
**Tests:** packages/opencode/test/task/fault-folders.test.ts (full suite)
**Test Cases:**
- Happy Path — for each fault folder, `TaskCommand.run` (fake `Ops`, committed copy in a git instance) refuses with the EXPERIENCE header and one line per planted rule; the refusal names every planted rule and no other (VF9–VF13).
- Boundary — `example-outside-run.spec` as the T1.2 subtree is refused at the start with the R12 line naming T1.2 and T1.1; as a whole spec it is not refused (VF14).
- Error Propagation — `status.json` `run` is `refused` with `reason` equal to the listed lines.
- Security Boundaries — no model request is made for any folder.
- Concurrency, Timing — N/A.
**Notes:** D14, AC 16 ("proved by a test that runs the command on each folder"). Pattern: `core-command.test.ts` (`seeded`, `runTask`, `refusalOf`).

### T3.7: Validate that both live-check folders still load once ensures is required

**File:** `packages/opencode/test/task/blend.test.ts` (UPDATE)
**Depends On:** T3.1
**Supports:** VF15
**Tests:** packages/opencode/test/task/blend.test.ts live-check
**Test Cases:**
- Happy Path — with `ensures` required (T3.1), `example-scenarios.spec` and `example-cascade.spec` (built in T1.15) still load with zero failures (VF15).
- Invalid Input — a copy of either folder with the `ensures` key of one leaf removed fails R3, which proves the check runs on the new schema.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** D11, D15. The folders themselves are built in phase 1 (T1.15); this task keeps the phase-3 guarantee that they load under the stricter schema.

### T3.8: Update the graph proof to walk the fault-folder plans that load

**File:** `packages/opencode/test/task/engine-xstate-graph.test.ts` (UPDATE)
**Depends On:** T3.4, T3.5
**Supports:** RM20
**Tests:** packages/opencode/test/task/engine-xstate-graph.test.ts (full suite)
**Test Cases:**
- Happy Path — the main walk now includes every `example-*.spec` plan that `Blend.load` accepts: the two live-check folders (since T1.10) and the whole `example-outside-run.spec` plan; each finds 0 stuck states (RM20).
- Happy Path — the T1.2 subtree plan of `example-outside-run.spec`, with its external region for T1.1, finds 0 stuck states.
- Boundary — the external region gets `outside.trusted` only in the start-up step of the alphabet (AD-7).
- Error Propagation — the five fault folders that the loader refuses are not walked; the test asserts that each is refused, so a folder that starts to load is walked, not skipped silently.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AD-7, AC 6. The external start-up step of the alphabet exists since T1.9.

### T3.9: Add scripted end-to-end runs of the two live-check folders

**File:** `packages/opencode/test/task/lib/scripted.ts` (NEW)
**Depends On:** T3.7
**Supports:** VF17, VF18
**Tests:** packages/opencode/test/task/live-check-runs.test.ts (full suite)
**Test Cases:**
- Happy Path — `example-scenarios.spec` with the scripted model: T1.1 trusted, S1 proved by its `[S1]` test and trusted, run `done` (VF18).
- Error Propagation — `example-cascade.spec` with the scripted model: T1.1 `budget_exhausted` after one attempt (the gate exits 1), T1.2 and the parent T1 `blocked` with `blocked by T1.1: budget exhausted`, T1.3 `trusted`; the run ends `budget_exhausted` only after T1.3 ends (VF17).
- Timing — T1.1 and T1.3 build in parallel; the run does not settle while T1.3 is active.
- Boundary — the run reason lists `T1.1 budget exhausted`, then `T1 blocked by T1.1` and `T1.2 blocked by T1.1`; in the scenarios run the scripted verifier also trusts T1's review `e1`.
- Concurrency, Security Boundaries — N/A.
**Notes:** SD-11. The helper copies the folder and the demo seed into a fresh git instance, merges the scripted provider config, and drives builder and verifier turns through `test/lib/llm-server.ts` (pattern of the conformance helpers `test/task-harness/scripts.ts`). No paid model. Seed the repository with the conformance `Workspace` helpers (`test/task-harness/arms/workspace.ts`): the seed's frozen lockfile is installed once, offline from the Bun cache, into the shared seed modules and linked into each repository. Each test sets an explicit 300 s timeout.

### T3.10: Update task-demo.sh to copy every example folder

**File:** `packages/opencode/script/task-demo.sh` (UPDATE)
**Depends On:** T3.5, T3.7
**Supports:** VF16
**Tests:** packages/opencode/test/task/task-demo.test.ts (full suite)
**Test Cases:**
- Happy Path — run on an empty temporary folder with a git identity set and the environment switch on (it skips both `bun install --frozen-lockfile` and the final `exec bun dev`), with an explicit 120 s timeout, the seed holds every `task-formats/blend/example-*.spec` folder beside `release-notes.spec` and `provider-ordering-admin.spec`.
- Boundary — the wipe guard still refuses a folder whose first commit is not `seed`.
- Happy Path — the printed instructions name `/task task-formats/blend/example-scenarios.spec` and `/task task-formats/blend/example-cascade.spec`.
- Error Propagation — the seed commit is clean (`git status` empty after the commit).
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** D15, AC 17. Keep `bun install --frozen-lockfile` and the release-notes instructions. A test switch such as `TASK_DEMO_NO_EXEC=1` skips the install and the TUI start, so the test needs no network.

### T3.11: Write the Validation section of the blend README

**File:** `task-formats/blend/README.md` (UPDATE)
**Depends On:** T3.4, T3.6, T3.7
**Supports:** DOC1
**Tests:** packages/opencode/test/task/readme-validation.test.ts (full suite)
**Test Cases:**
- Happy Path — the README has a `## Validation` section that says what runs before any work starts (`Blend.load` in `TaskCommand.run`, before the git check, the plan and the job), and how a refusal appears (header, one line per failure, hint; `run.reason`).
- Boundary — the section lists R1–R13 each with the file that enforces it (`blend/index.ts`, `blend/rules.ts`, `blend/schema.ts`, the command for R12), and states that R12 is a runtime check.
- Happy Path — it says how the run machine holds the order (readiness and the blocked cascade in the machine) and which graph faults are refused (cycles including self-after, unknown references, ancestor and descendant order, a subtree dependency outside the run).
- Happy Path — it names the six fault folders and the two live-check folders with their expected response; `VERIFY.md` documents `ensures` as required; the Layout tree lists the example folders.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AC 1 (answers questions 1, 3 and 4). Replaces `## Validating` (358-371). The test reads the file and checks the headings, every rule id, and every folder name.

## Phase 4 — task UI (parent T4; D16–D24, AD-16, AD-18, EXPERIENCE)

Every phase-4 task: colours only from theme tokens (`{theme.<token>}`), every glyph one cell wide, no timer of its
own in `task-ui` (AD-16).

### T4.1: Create the taskView machine and the fromActor adapter

**File:** `packages/tui/src/task-ui/machine.ts` (NEW)
**Depends On:** T3.11
**Supports:** UI2, UI3
**Tests:** packages/tui/test/task-ui/machine.test.ts (full suite)
**Test Cases:**
- Happy Path — context `design` (1–7), `chosen?`, `status?`, `mtime`, `logs`, `now`, `root`, `target`; events `design.set`, `design.cycle`, `select`, `select.next/previous`, `select.nextRunning/previousRunning`, `expand.toggle`, `expand.set`, `watch.toggle`, `watch.set`, `stop.key`, `sessions.changed`, `route.changed`, `watch.target` (UI2).
- Timing — `feed`: `reading` → `resting` → `reading` after 1 s; session list after 2 s, activity lines after 1.5 s, proof-log tail after 500 ms — each a delayed transition (TestClock or the port's simulated clock).
- State Transitions — `stopKey`: `stop.key` in `disarmed` runs the warn action and arms; in `armed` runs the stop action and disarms; `armed` disarms after 5 s.
- State Transitions — `liveness` eventless rows: `absent` (no status), `ended` (the `ended` tag), `live` (`now - run.aliveAt <= 15 s`), else `still` (UI3).
- Invalid Input — a status text that does not parse keeps the last status.
- Boundary — `watch.set { on: false }` resets `target` to `""`; `target` keeps its value while nothing runs; `design.cycle` wraps 7 → 1.
- Happy Path — `fromActor(actor)` subscribes to the snapshot stream and sets one Solid signal; it decides nothing.
- Boundary — `now - run.aliveAt` of 15 000 ms gives `live` and 15 001 gives `still`; a new-format status with no `aliveAt` and no `ended` tag gives `still`; a refused status gives `ended`.
- Error Propagation — a failed read (for example EACCES) goes to `resting` with the last status and reads again after 1 s; a file deleted after a good read gives `absent`; a parse failure keeps the last status.
- Invalid Input — `design.set { id: 8 }` keeps the current design; a `chosen` id missing from a new status falls back to the focus task; `select.nextRunning` with nothing running keeps `chosen`.
**Notes:** AD-16, D16. Add `"@jambudipa/xstate-effect": "catalog:"` to `packages/tui/package.json`. `actor.ts` (NEW) holds `fromActor`. No `Effect.repeat`, `Schedule`, `Effect.sleep` or `setInterval` in `task-ui`. After adding the dependency, run `bun install` at the root and commit `bun.lock` with the change.

### T4.2: Update the store to decode AD-13 and classify only from tags

**File:** `packages/tui/src/task-ui/store.ts` (UPDATE)
**Depends On:** T4.1
**Supports:** UI1, UI11, UI18, SV17
**Tests:** packages/tui/test/task-ui/task-ui.test.tsx store
**Test Cases:**
- Happy Path — the schema decodes the AD-13 fields as optional (tags, `title`, `specId`, `path`, `task`, `warning`, `startedAt`, `endedAt`, `aliveAt`, spans, scenario `title`, `outside`, `external`) and ignores an unknown tag; an older file still parses (SV17).
- State Transitions — Board column, counts, focus, next running task and severity order (`dead`, `blocked`, `stopped`, `active`, `waiting`, `ended`) come from tags; their old exports stay until T4.3, T4.7 and T4.8 remove them (UI1).
- Happy Path — `DISPLAY` maps a state to glyph, tone and Gantt block: `blocked` is `⊖` in `{theme.warning}`; `stalled` stays for an older file (UI18).
- Boundary — durations: under a minute `45s`, under an hour `3m 12s`, from an hour `1h 4m`; live = now − `startedAt` while live; still = `run.aliveAt` − `startedAt`; fixed = `endedAt` − `startedAt`; blank with no `startedAt` (UI11).
- Error Propagation — `parse` still refuses `{`, `{run:{}}` and `''`.
- Concurrency, Security Boundaries — N/A.
- Boundary — `poll`, `LIVE_WINDOW`, the view signals and the `ACTIVE`/`ENDED` exports stay in this task so every importer (`peek.tsx:7`, `5-gantt.tsx:4`, `7-ticker.tsx:5`, `index.tsx`) still links; internal classification already reads tags. T4.3 removes `poll`, `LIVE_WINDOW` and the signals; T4.7 and T4.8 remove the last `ENDED` uses and the list definitions.
**Notes:** D16, D21, AD-13, AD-16, EXPERIENCE "State vocabulary" and "Durations". The TUI tests move from the old `fixture-status.json` to `fixture-projected.json` (T1.5 and T1 blocked); the tests that pinned the old fixture (counts `{6,3,0,1}`, focus T1.4) are re-baselined with a header list in `task-ui.test.tsx` that classes each changed test as ported, re-baselined or retired, and the old fixture is deleted when no test reads it (SD-10).

### T4.3: Wire the plugin, the watch and the Peek polls onto the view actor

**File:** `packages/tui/src/task-ui/index.tsx` (UPDATE)
**Depends On:** T4.2
**Supports:** UI2, UI3, UI21
**Tests:** packages/tui/test/task-ui/plugin.test.tsx (full suite)
**Test Cases:**
- Happy Path — the plugin creates one `taskView` actor per instance, stops it with the reactive root, and follows a rewritten status within the feed cadence (plugin test "follows a new status").
- State Transitions — the `root` signal (`index.tsx:88-93`), the `target` signal (`watch.tsx:359-366`), `armed`/`disarm` (`watch.tsx:306-326`), the 500 ms tail (`watch.tsx:274-281`) and the Peek polls (`peek.tsx:73-82`) are machine state and delayed transitions.
- Permissions — Tab, `esc` twice and the watch keys act only while `liveness` is `live` and the root owns the run's harness sessions; with no status file Tab goes to the agent (UI3).
- Boundary — the kv design persistence and the invalid-value fallback still work; `/task-design` still switches all seven designs.
- Error Propagation — esc twice still aborts and toasts; the watch toggle still collapses the Board.
- Concurrency, Timing — N/A beyond the machine tests.
- Happy Path — UI21: with nothing running and the run waiting only on T9, the watch band reads `Nothing is running. The run is waiting on T9 (outside) — run /task trust T9.`; an external id never gets the command.
- Permissions — `stop.key` armed while `live`: if the run ends, or `route.changed` moves to another session, before the second esc, no stop action runs.
- State Transitions — `poll`, `LIVE_WINDOW` and the four view signals leave `store.ts`; `watch.tsx` (98, 462) reads tags instead of `ACTIVE`.
**Notes:** AD-16. `watch.tsx` and `peek.tsx` are the other files this task touches. `task-ui.test.tsx:341` (`WatchBand` expecting `◆ In the Flow watching…`) injects a still or ended liveness so the mark is static.

### T4.4: Create the shared region and mount it in every expanded view

**File:** `packages/tui/src/task-ui/shared.tsx` (NEW)
**Depends On:** T4.3
**Supports:** UI5, UI9, UI10, UI16, UI21, UI22
**Tests:** packages/tui/test/task-ui/shared.test.tsx (full suite)
**Test Cases:**
- Happy Path — order: run warning list, outside wait lines, STOPPED list, SCENARIOS list; empty sections hidden except the SCENARIOS heading (`SCENARIOS none in this run`).
- Happy Path — STOPPED: heading `STOPPED <n>`; groups dead, blocked, rest; one line per set of tasks with the same state and reason, ids in natural order (`⊖ T1, T1.5 blocked by T1.4: budget exhausted`); `+N` when ids do not fit; under 30 cells the reason goes (UI9).
- Happy Path — SCENARIOS: heading `SCENARIOS <n> · k/n trusted`; one entry per scenario in natural order with glyph, id, state label, ` · `, title; `waiting on …` with `(outside)`; `not run` after the run ends; a blocked scenario's reason; a rejected or failed reason under its entry, indented 4 cells, at most 2 lines (UI10).
- Boundary — two columns from 80 cells (column-first), one column below; the title keeps at least 12 cells; the release-notes status at 120 × 40 holds S1–S13 in the region of each of the seven designs.
- Happy Path — run warning: `! spec no longer validates · 2 failures`, each failure line, then `The run keeps the plan it loaded.` (UI16); outside wait lines `waiting on T9 (outside) — run /task trust T9` while the run lacks `ended` (UI5).
- Accessibility — the region is a scroll box; the mouse wheel scrolls it; `pageup`/`pagedown` scroll it in the full-screen views and the Ticker dialog; a click on a STOPPED line selects its first task.
- Empty / Null — UI21: a run with no scenarios shows `SCENARIOS none in this run`.
- Accessibility — UI22: at 120 × 24 with 13 scenarios and 5 stopped tasks, the region keeps at least 8 rows, the Peek activity lines shrink first, `pagedown` reaches every entry, and a click on a STOPPED line selects its first task.
**Notes:** D19, D20, D12, D4, EXPERIENCE "Shared region", "STOPPED list", "SCENARIOS list", "Run warning", "Outside wait line". Mount in the expanded view of all seven designs.

### T4.5: Update the Peek BUILDER heading with reasons, waits and durations

**File:** `packages/tui/src/task-ui/peek.tsx` (UPDATE)
**Depends On:** T4.3
**Supports:** UI5, UI9, UI11, UI21
**Tests:** packages/tui/test/task-ui/task-ui.test.tsx peek
**Test Cases:**
- Happy Path — a task with a reason and without `blocked`: line 1 `budget exhausted · attempt 3 · 6m 40s`, then the reason in `{theme.error}` (with `dead`) or `{theme.textMuted}` (UI9, UI11).
- State Transitions — a blocked task: line 1 starts `blocked by T1.4: budget exhausted` in `{theme.warning}`; a waiting task: the wait sentences (plan ids, `(outside) — run /task trust T9`, `(not in this run)`) (UI5).
- Boundary — a reason that does not fit wraps at word boundaries with a 9-cell hanging indent and no line limit; activity lines shrink first.
- Empty / Null — a task with `endedAt` and no `startedAt` reads `no builder session: the task did not start` and `no verifier session: the task did not start`.
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** D19, D21, EXPERIENCE "Peek BUILDER heading". `harnessOf` (`peek.tsx:38-56`) also carries each session's tokens and cost for T4.12. The old heading string `BUILDER  attempt 3 · budget exhausted` is re-baselined.

### T4.6: Update the Board and the Matrix to read tags, causes and durations

**File:** `packages/tui/src/task-ui/designs/3-board.tsx` (UPDATE)
**Depends On:** T4.4, T4.5
**Supports:** UI1, UI5, UI11, UI18, UI22
**Tests:** packages/tui/test/task-ui/designs.test.tsx board
**Test Cases:**
- Happy Path — columns from tags; STOPPED order is the STOPPED list order; a blocked card shows `⊖ T1.5` and `blocked by T1.4: budget exhausted` in `{theme.warning}` (UI1, UI18).
- Boundary — card line 3 `attempt N · <duration>`, the duration alone for a started task with no attempt, left out for neither; the duration moves to its own line when it does not fit and is never cut (UI11).
- State Transitions — a waiting card shows each wait sentence, plan ids first; the trust command is never cut (UI5).
- Happy Path — Matrix: a `time` column after the last proof cell with a 2-cell gap, 7 cells, right-aligned; the legend adds `⊖ blocked`; the old SCENARIOS block moves to the shared region.
- Error Propagation — a dead card's reason in `{theme.error}`, at most 3 lines, cut with `…`.
- Concurrency, Security Boundaries, Timing — N/A.
- Boundary — UI22: under 149 cells the Board's right pane moves below the board (side by side from 110 cells, else stacked); the STOPPED list shows on the Board too.
**Notes:** D16, D19, D21, EXPERIENCE "Board card", "Durations". `4-matrix.tsx` is the other file this task touches.

### T4.7: Update the Gantt and the HUD to draw spans and durations

**File:** `packages/tui/src/task-ui/designs/5-gantt.tsx` (UPDATE)
**Depends On:** T4.4, T4.5
**Supports:** UI4, UI11, UI15, UI5
**Tests:** packages/tui/test/task-ui/designs.test.tsx gantt
**Test Cases:**
- Happy Path — each lane cell shows the span holding its middle time, as the Gantt block of that span's state in its tone; cells before the first span and after the last are blank (UI4).
- Boundary — an open span runs to now while live and to `run.aliveAt` while still; a zero-length final span takes one cell; the run span keeps a 3% tail after `run.endedAt`; a blocked task is `░` then one `█` in `{theme.warning}`.
- Happy Path — right column: duration (7 cells), a space, state text (21 cells); the lane narrows first, down to 10 cells (UI11).
- Happy Path — HUD: the selected-task line `▸ ⊘ T1.4 budget exhausted · at… · 6m 40s` cuts the state text first, never the duration; `elapsed 24m 10s · 1.4M tokens · $2.31`, tokens dropped first (UI15).
- State Transitions — the old `lane()` test (`task-ui.test.tsx:105-111`) is re-baselined to spans.
- Concurrency, Security Boundaries, Timing — N/A.
- State Transitions — the Gantt no longer imports `ENDED`; the HUD's collapsed panel shows the outside wait line under the run warning line, naming the first id and ending with ` +N` for two or more ids (UI5).
**Notes:** D16, D21, AD-5, AD-16, EXPERIENCE "Gantt lane", "HUD selected-task line". `6-hud.tsx` is the other file; it no longer imports `span` from the Gantt. The legend reads `░ waiting ▓ building ▒ proving ▞ verifying █ ended, in its state's colour`.

### T4.8: Update the Ledger, Dock, Ticker and full-screen header

**File:** `packages/tui/src/task-ui/designs/1-ledger.tsx` (UPDATE)
**Depends On:** T4.4, T4.5
**Supports:** UI6, UI15, UI16, UI17, UI18, UI19, UI21, UI5
**Tests:** packages/tui/test/task-ui/designs.test.tsx ledger
**Test Cases:**
- Happy Path — the Ledger shows `run.title` on its own line (`{theme.textMuted}`, cut with `…`) where the spec folder name was; the full-screen header reads `<title> · run: <state>` (UI6).
- Error Propagation — a refused status: the Ledger shows `run: refused` and every `run.reason` line in `{theme.error}`; the full-screen body reads `No work started: the spec was refused.` with every line (UI17).
- Happy Path — the run reason line: the first `run.reason` line plus ` (+N more)`, `{theme.error}` with `stopped`, muted for `not run` lines on a done run (UI19); the stopped count `· 2 stopped` after every trusted count.
- State Transitions — Ticker: a task that gains `dead` or `blocked` shows its reason in the toast; a task comes before the tasks it blocks; at most three toasts per change; the end notification follows the `ended` tag (UI18).
- Happy Path — run warning one-line form in the collapsed views; a warning toast once when it first appears (UI16).
- Boundary — Dock strip: `$2.31` after the stopped count, dropped before the task chips; side-by-side expanded layout from 110 cells (UI15).
- Concurrency, Security Boundaries, Timing — N/A.
- State Transitions — UI19: a `done` run with a `not run: …` reason shows its run reason line in `{theme.textMuted}` and the Ticker raises no notification for it (AD-16 wins over the EXPERIENCE `{theme.warning}` text); a run with `stopped` uses `{theme.error}`.
- Boundary — UI21: every trusted count ends with `· 2 stopped` in `{theme.error}` when the count is above 0, and shows nothing at 0.
- Boundary — the collapsed outside wait line in the Ledger and the full-screen header (under the run warning line) and as a Dock segment; with two or more outside ids it names the first and ends with ` +N` (UI5).
- State Transitions — the Ticker no longer imports `ENDED`; the `ACTIVE` and `ENDED` definitions leave `store.ts`.
**Notes:** D17, D19, D24, D12, EXPERIENCE "Design placement", "Refusal", "Run warning". Other files: `2-dock.tsx`, `7-ticker.tsx`, `screen.tsx`.

### T4.9: Update the shortcut bar and animate the In the Flow mark

**File:** `packages/tui/src/task-ui/ui.tsx` (UPDATE)
**Depends On:** T4.3
**Supports:** UI12, UI13, UI14, UI16
**Tests:** packages/tui/test/task-ui/task-ui.test.tsx bar
**Test Cases:**
- Happy Path — the bar has no `/task-design switch` part in any design; `/task-design` still switches designs from the command list (UI13; re-baseline `task-ui.test.tsx:191, 195`).
- Happy Path — every `Brand` is a row: the `<spinner>` element with frames `· ⬩ ⬪ ⬥ ◆ ⬥ ⬪ ⬩` at about 120 ms in `{theme.accent}`, then ` In the Flow` bold (UI14).
- State Transitions — the mark is a static `◆` when `liveness` is `ended` or `still`, or when kv `animations_enabled` is false; the Peek border title and the toast title stay static (UI14, UI12 `@ASSUMPTION:A2.a`).
- Boundary — parts per design (EXPERIENCE "Shortcut bar" table): run warning `! spec`, outside wait `/task trust T9`, keys, trusted count, stopped count; a narrow bar drops parts from the end, keeping the run warning and the outside wait (UI16).
- Accessibility — every frame is one cell wide, so the text after the diamond never moves.
- Concurrency, Security Boundaries — N/A.
- Accessibility — the diamond is not bold in either form; the text after it does not change weight when it stops.
- Boundary — the select key label reads `tab select task` while `liveness` is `live`, else `ctrl+x j/k select task`.
**Notes:** D22, D23, AD-16, default 6. Use `registerOpencodeSpinner` (`component/register-spinner.ts`) and the `<spinner frames interval color>` pattern of `component/spinner.tsx`; the task-ui adds no timer of its own.

### T4.10: Add the run header with the spec title from structured metadata

**File:** `packages/opencode/src/task/core/command.ts` (UPDATE)
**Depends On:** T4.2
**Supports:** UI6, VF8
**Tests:** packages/opencode/test/task/core-command.test.ts header
**Test Cases:**
- Happy Path — a whole-spec run's first message is `Implementing spec **Release notes from conventional commits**` with `metadata.taskHarness = { header: { spec: { id, title }, leftOut: [] } }` on its text part (UI6).
- Happy Path — a subtree run reads `Implementing **T1.2 Compute the next version** from spec **<title>**` with `header.task` set; `leftOut` lists the scenarios the subtree leaves out (VF8).
- Empty / Null — an empty H1 falls back to the spec id in the same bold style; `status.json` `run.title` holds the spec id then.
- Happy Path — the TUI `UserMessage` (`routes/session/index.tsx:1563-1660`) draws `Implementing spec` in `{theme.textMuted}` and the title bold from the part metadata, wraps at word boundaries, never parses text; a non-empty `leftOut` adds `Left out: S1, S5 — they need tasks outside this run.`
- Boundary — an older header in scrollback keeps its own title when a later run starts (it reads its own metadata, not `status.json`).
- Security Boundaries — `Ops.PromptInput` text parts gain an optional `metadata`; `taskOps.prompt` forwards it (`prompt.ts:1396-1411`); no `SessionPrompt` import in `src/task/`.
- Concurrency, Timing — N/A.
- Happy Path — `status.json` `run.task` is `{ id: "T1.2", title: "Compute the next version" }` for the T1.2 subtree run and absent for a whole-spec run.
**Notes:** D17, AD-13, EXPERIENCE "Run header". Other files: `core/ops.ts`, `session/prompt.ts`, `packages/tui/src/routes/session/index.tsx`. Replaces the reply at `command.ts:224-226`.

### T4.11: Add Ops.say and the closing summary written by the run supervisor

**File:** `packages/opencode/src/task/core/ops.ts` (UPDATE)
**Depends On:** T4.10
**Supports:** UI7, UI8, UI20, UI23
**Tests:** packages/opencode/test/task/summary.test.ts (full suite)
**Test Cases:**
- Happy Path — when the run actor is `done`, the run supervisor invokes `summary` once, then enters `closed`; the root session gets one assistant-role markdown message with no model call (UI7).
- Happy Path — content per EXPERIENCE "Closing summary": outcome line by AD-4 rule (stop: `— <label>: <first reason line>`; dead task: `— <label>`; ruling 1: `— failed: acceptance not proved`; done: `— done`, plus ` · N scenarios not run`), counts line with duration, tokens and cost, **Stopped**, **Scenarios that did not pass**, **Not run**, the run-warning line, and the **Tasks** table with `—` for a task with no `startedAt`.
- Boundary — the run's sessions are the child sessions of the root; tokens and cost are summed from the session store; newlines in a reason become spaces; empty sections are left out.
- State Transitions — `say` writes a complete `SessionV1.Assistant` (`parentID` = the run header message, current model, zero cost and tokens, `time.completed`, `finish: "stop"`) and one text part; it waits behind a root turn in flight; it still writes after the user aborts the root session; on a cancel the summary is written while the task supervisors stop (UI8).
- Error Propagation — a later user prompt in the root session still runs a model turn (the run-loop exit rule at `prompt.ts:1154-1173` holds).
- Concurrency — the background job output no longer carries the end message (`command.ts:219-222`).
- Happy Path — UI20: outcome lines for a cancel (`— cancelled: <first reason line>`), a dead task (`— budget exhausted`), a rejected scenario with all tasks trusted (`— failed: acceptance not proved`), a done run with one parked scenario (`— done · 1 scenario not run`), and a subtree run (`**T1.2 <title>** from spec **<title>** — …`); a spec that stopped validating and validated again still gives the run-warning line.
- Timing — a cancel while a root turn runs past `limits.cancelDeadline`: the cancel finalizer stops the run supervisor at the deadline (AD-8), the summary is dropped and logged, and the lease is released.
- Error Propagation — UI23: a root session deleted before the run ends makes `say` fail; the failure is logged, the run supervisor reaches `closed`, the job ends, the lease is released, and the next `/task` is not busy.
- Boundary — rule 3 with a parked scenario gives `— failed: acceptance not proved · 1 scenario not run`.
**Notes:** D18, AD-18, SD-6. Other files: `session/prompt.ts` (`taskOps.say`), `core/workers.ts` (`summary`), `core/supervise/run.ts` (the summary step), `core-command.test.ts` fake `Ops` gains `say`. A summary lost on a crash between the final fact and `say` is accepted (spine Deferred).

### T4.12: Add the run usage to the prompt footer, the sidebar and the task-ui

**File:** `packages/tui/src/component/prompt/index.tsx` (UPDATE)
**Depends On:** T4.5, T4.7, T4.8, T4.11
**Supports:** UI15
**Tests:** packages/tui/test/task-ui/usage.test.tsx (full suite)
**Test Cases:**
- Happy Path — for a `/task` root session (one that owns harness sessions), the footer shows `run 1.4M tokens · $2.31` summed over the child sessions, live from the synced session data.
- Boundary — when the root also has its own assistant message with output tokens, the footer shows today's `12.3K (5%) · $0.02` first, then ` · run 1.4M tokens · $2.31`; narrow: drop the root's own figure, then the word `tokens`, then show the cost alone.
- Happy Path — the sidebar Context panel shows `1,402,331 tokens in the run` and `$2.31 spent in the run`; the root's own three lines show only when the root has an assistant message with output tokens above 0.
- Empty / Null — before any harness session reports tokens, the run usage is hidden everywhere; a session that is not a `/task` root is unchanged; a free model shows `$0.00` on purpose.
- Happy Path — the HUD, the full-screen header, the Dock and the Ticker dialog show the run usage per EXPERIENCE "Run usage".
- Concurrency, Security Boundaries, Timing — N/A.
- Boundary — run tokens are input plus output plus reasoning tokens of every assistant message of the run's sessions; cache reads and writes are not counted (EXPERIENCE Assumptions).
**Notes:** D24, AD-18 (one definition of the run's sessions), EXPERIENCE "Run usage". Other file: `packages/tui/src/feature-plugins/sidebar/context.tsx`. Tokens use `Locale.number`; cost uses the footer's USD format (`prompt/index.tsx:99-102`).

### T4.13: Validate the final state audit with task-ui in scope and update the task-ui README

**File:** `packages/opencode/test/task/state-audit.test.ts` (UPDATE)
**Depends On:** T4.6, T4.7, T4.8, T4.9, T4.12
**Supports:** SV18, SV19
**Tests:** packages/opencode/test/task/state-audit.test.ts (full suite)
**Test Cases:**
- Happy Path — the audit passes on `packages/opencode/src/task/` and `packages/tui/src/task-ui/` with exactly the AD-17 entries (`fromActor`, `DISPLAY` included) and no interim entry (SV19).
- Invalid Input — every planted construct still fails (SV18).
- Boundary — `task-ui` contains no `Effect.repeat`, `Schedule`, `Effect.sleep`, `setInterval` or `createSignal` for view state outside `fromActor`.
- Error Propagation — an allowlist entry without a reason fails.
- Concurrency, Security Boundaries, Timing — N/A.
- Invalid Input — a planted `Effect.sleep`, `Schedule.spaced` or view-state `createSignal` in `task-ui` fails the audit.
**Notes:** D9, AD-17, SD-8. Also update `packages/tui/src/task-ui/README.md`: tag classification, liveness from `run.aliveAt` (15 s), the `taskView` machine in the Files table, the animated mark, run usage, reasons, scenarios, durations, and that the bar no longer shows `/task-design`.

### T4.14: Validate the quality gate on the final branch

**File:** `packages/opencode/test/task-harness/arms/status.ts` (UPDATE)
**Depends On:** T4.13
**Supports:** BUILD-1, BUILD-2, BUILD-3, BUILD-4, BUILD-6
**Tests:** packages/opencode/test/task-harness/conformance.test.ts (full suite)
**Test Cases:**
- Happy Path — on the final branch `bun lint` and `bun typecheck` exit 0 at the root; `bun run --cwd packages/opencode test` and `bun run --cwd packages/tui test` exit 0; `bun run script/task-conformance.ts --arm o2 --runs 1` passes H1–H16 (AC 29).
- Boundary — the conformance reader `arms/status.ts` accepts the AD-13 fields (`tags`, `title`, `specId`, `task`, `warning`, `aliveAt`, `spans`) as optional, and H1 still finds `R7` in `run.reason` with the new refusal format.
- Error Propagation — the guard reports no dirty fingerprinted path (commit the spec, seed and suite edits first).
- Concurrency, Security Boundaries, Timing — N/A.
**Notes:** AC 29 on the final branch, after phases 3 and 4 changed the refusal text, the first message, the status contract and `Ops`. The Tests line runs only with `TASK_HARNESS_ARM=o2` set; the gate itself is BUILD-6. The goal loop then runs the paid live check (AC 27) and the final merge (AC 28).

# Context: task-harness-feedback

Binding inputs (all in the goal folder, one level up): `decisions.md` (D1–D27), `ACs.md` (29 criteria),
`plan.md` (phase order), `task-questions.md` (13 questions), `architecture/ARCHITECTURE-SPINE.md` (AD-1..AD-20 and
"Owner answers and defaults"), `ux/EXPERIENCE.md` (task-ui behaviour contract), `journal/2026-10-14-04-architecture.md`
(owner answers). Precedence on conflict: owner answers > decisions.md / ACs.md > spine > EXPERIENCE.md.

Investigated on the branch `goal/task-harness-feedback` at `ac870df79a` (2026-10-14). Line numbers below are from
that commit. Four read-only subagents analysed the files; this file keeps their structured results.

## Tech Stack

| Name | Version in the repo | Note |
| --- | --- | --- |
| Bun | 1.3.14 | Test runner (`bun test`) and package manager; root `bunfig.toml` sets `[test] root = "./do-not-run-tests-from-root"` |
| TypeScript | 5.9.3, type checker `tsgo` (`@typescript/native-preview` 7.0.0-dev.20251207.1) | `bun typecheck` = `bun turbo typecheck` at the root; `tsgo --noEmit` in a package |
| effect | 4.0.3 (catalog) | Effect v4; keep the repository's major (user guidance) |
| @effect/platform-node | 4.0.3 (catalog) | `NodeServices.layer` in tests |
| @jambudipa/xstate-effect | 0.2.0 (catalog, exact) | The xstate port (XState 5.33.2 behaviour, peer `effect ^4.0.0`). In `packages/opencode/package.json:83`; ABSENT from `packages/tui/package.json` (D16 adds it as `catalog:`) |
| solid-js | 1.9.10 | TUI rendering |
| @opentui/core, @opentui/solid | 0.4.5 | TUI renderer and the test renderer (`testRender`) |
| opentui-spinner | 0.0.7 | The `<spinner>` element (D23); registered once by `packages/tui/src/component/register-spinner.ts` |
| Blend front matter | in-repo | `blend/document.ts` parses the YAML front matter inside `Effect.try`; `blend/schema.ts` decodes it with Effect Schema. `packages/opencode/src/task/blend/` imports no `yaml` or `ajv` package |

Port API used by this feature (verified in `node_modules/@jambudipa/xstate-effect`, 0.2.0):

- Root `@jambudipa/xstate-effect`: `setup(...).createMachine(config)`, `createMachine`, `stateIn`, `stateNotIn`,
  `and`, `or`, `not`, `assign`, `raise`, `createActor` (an Effect that needs a `Scope`), `fromCallback`,
  `fromEffect`, `fromStream`, `transition` (an Effect of `[nextSnapshot, actions]`), `initialTransition`,
  `getInitialSnapshot`, `getNextSnapshot`. `snapshot.can`, `machine.resolveState` and `machine.transition` return
  Effects.
- `@jambudipa/xstate-effect/graph`: `getAdjacencyMap(logic, options)` — the options argument is REQUIRED (pass `{}`
  for none); options `events` (array, or a function of the snapshot), `serializeState`, `serializeEvent`,
  `filterEvents`, `limit` (default `Infinity`; exceeding it fails with "Traversal limit exceeded"), `fromState`,
  `stopWhen`, `toState`. Returns `Effect<AdjacencyMap, TraversalError, R>`.
- The engine today imports `and, assign, getInitialSnapshot, not, or, setup, stateIn, transition` from the root
  (`engine-xstate/index.ts:2`). No other file imports the port.

The worktree has `node_modules` (`bun install` ran during preparation, 4783 packages).

## Codebase Patterns

- **Module shape** (`packages/opencode/AGENTS.md`). Flat exports plus a self re-export (`export * as Foo from
  "./foo"`, or `"."` in an `index.ts`). No `export namespace`. No barrel in a multi-sibling folder. The engine
  exports `TaskEngineXState` from `engine-xstate/index.ts:892`.
- **Effect style** (root `AGENTS.md`, `packages/opencode/AGENTS.md`, `docs/CLAUDE/code-standards/effect_v4.md`).
  `Effect.gen` with `yield*`; `Effect.fn("Domain.method")` for named effects, `Effect.fnUntraced` for internal
  helpers; `Schema.TaggedErrorClass` for typed errors; `Effect.void`; no `async`/`await` or Promise chains in
  Effect-owned code; no `any`, no `else`, early returns, no `try`/`catch` where avoidable; `Effect.forkIn(scope)` /
  `Effect.forkScoped`; synchronous logic stays synchronous.
- **The owner's state rule overrides the general Effect guidance.** The user-wide guidance recommends `Ref` /
  `SynchronizedRef` for shared state. The owner's requirement (task-questions.md question 13, D9) forbids `Ref`,
  `SynchronizedRef`, `MutableHashMap`, polled loops and module-level mutable `let` in
  `packages/opencode/src/task/` and `packages/tui/src/task-ui/`: every state, transition and decision that reads
  state is xstate context or state. `Semaphore` (resource locks), `Queue`, `Deferred` and `Stream.scan` stay allowed
  (AD-17).
- **Services and layers.** `Context.Service<Self, Shape>()("@opencode/<Name>")`; layers wired as nodes with
  `LayerNode.make({ service, layer, deps })` or `makeGlobalNode(...)` for process-global services
  (`packages/core/src/effect/layer-node.ts`). `InstanceStore` is a global node (`project/instance-store.ts:228`);
  `BackgroundJob` (`background/job.ts:35`) and `EventV2Bridge` (`event-v2-bridge.ts:71`) are `LayerNode.make`.
  `SessionPrompt.node` is `LayerNode.make` (`session/prompt.ts:1782-1812`) with no task dependency today.
- **The harness today has no Effect service.** `TaskCommand.run` (`core/command.ts:118-227`) is a plain `Effect.fn`.
  It resolves `Session`, `SessionStatus`, `InstanceStore`, `EventV2Bridge`, `BackgroundJob` and `Database` with
  `Effect.serviceOption` and dies with `HarnessUnavailable` when one is missing (`command.ts:47-69`), because
  `SessionPrompt` cannot depend on the harness layer-wise. `Ops` (`core/ops.ts`) is built in `SessionPrompt` as
  `taskOps` (`prompt.ts:1396-1411`) and passed in, so `src/task/` never imports `SessionPrompt`.
- **Facts.** Stored as the EventV2 event `task.harness.fact`, durable v1, aggregate `runID`
  (`core/events.ts:61-65`); `FactSchema` (`events.ts:31-54`) has 16 members; `asFact` / `asStored` (`events.ts:57-58`)
  keep it in step with the `Fact` union of `core/model.ts:76-107`. `/task trust` writes `outside.trusted` to the
  directory aggregate (`directoryID`, `events.ts:79`).
- **Status file.** `<directory>/.opencode/task/status.json`, written atomically (temp file then rename) by
  `TaskStatus.write` (`core/status.ts:166-177`); encoded with closed `Schema.Literals` (`status.ts:10-34`). Readers:
  the TUI mirror schema (`packages/tui/src/task-ui/store.ts:10-44`, every state an open `Schema.String`, excess keys
  dropped), the conformance reader (`test/task-harness/arms/status.ts`, loose) and `core-status.test.ts:179`.
- **TUI plugin.** `internal:task-ui` (`packages/tui/src/task-ui/index.tsx`), seven designs, a keymap layer, the
  watch view, a 1 s poll of the status file. Tests use `testRender` from `@opentui/solid`, `renderOnce`,
  `captureCharFrame`, `app.mockInput`; status injection by `parse(JSON.stringify(fixture))` and
  `createView({ status, now, design })`.
- **Commit and naming conventions.** `type(scope): summary` subjects (`feat(task): …`), with the user's commit-body
  rule (Why / Source / Notes).

## Key Files

Modification type: UPDATE (existing file changes), NEW (file or folder created). A NEW folder row names the folder;
the files inside it are listed in the Purpose column.

| File | Purpose | Modification Type |
|------|---------|-------------------|
| `packages/opencode/src/task/engine-xstate/index.ts` | Engine API: `initial`, `apply`, fold, selectors, `view`, `XStateEngine`; the four per-unit machines and the fold code go (D1) | UPDATE |
| `packages/opencode/src/task/engine-xstate/machine.ts` | `machine(plan)`: plain-data config, then `createMachine` (AD-1..AD-5); `DEAD`, `CLASS` tables | NEW |
| `packages/opencode/src/task/engine-xstate/alphabet.ts` | Progress-fact alphabet and the walk key (AD-7) | NEW |
| `packages/opencode/src/task/core/model.ts` | `TaskState` gains `blocked`; `Engine` over an opaque `RunSnapshot`; `State` becomes selector output only | UPDATE |
| `packages/opencode/src/task/core/events.ts` | `fold` over snapshots; `FactSchema` gains `task.nudged` (P2), `spec.checked` (P3), optional `path` on `run.started` / `run.resumed` (P2) | UPDATE |
| `packages/opencode/src/task/core/status.ts` | Phase 1: project through `view(snapshot)`; phase 2: the AD-13 contract (`project(plan, snapshot)`, `refused`, `write(directory, status, aliveAt?)`) | UPDATE |
| `packages/opencode/src/task/core/runner.ts` | Phase 1: AD-20 seam (T1.11); phase 2: deleted by T2.12, its pure exports move | UPDATE |
| `packages/opencode/src/task/core/sessions.ts` | Message builders stay; `builderTurn`'s Refs and polled loop go (D7) | UPDATE |
| `packages/opencode/src/task/core/hooks.ts` | Constants, `shellEnvironment`, pure `repetition`, routing over `HarnessHooks`; the four maps go (D7, AD-11) | UPDATE |
| `packages/opencode/src/task/core/command.ts` | Check order and lease (AD-19), every failure listed (D10), D13 refusal, run header (D17), resume rule (AD-6) | UPDATE |
| `packages/opencode/src/task/core/ops.ts` | Text-part `metadata` (D17); `say` (D18) | UPDATE |
| `packages/opencode/src/task/core/index.ts` | Barrel: keeps `run`, `CommandInput`; exports the harness node if needed | UPDATE |
| `packages/opencode/src/task/core/harness.ts` | `TaskHarness` service: root actor, directory leases, session index, trust forwarding (AD-8, AD-11, AD-19) | NEW |
| `packages/opencode/src/task/core/recorder.ts` | Recorder and status writer (AD-9) | NEW |
| `packages/opencode/src/task/core/workers.ts` | Stateless workers: `begin`, `builderTurn`, `sessionEvents`, `proof`, `verifierPrompt`, `merge`, `scenarioProof`, `scenarioJudge`, `staleCheck`, `record`, `touch`, `summary` (AD-8) | NEW |
| `packages/opencode/src/task/core/supervise` | Folder: `run.ts` (run supervisor), `task.ts` (task supervisor), `scenario.ts` (scenario supervisor) (AD-8, AD-11, AD-12, AD-18) | NEW |
| `packages/opencode/src/task/limits.ts` | Keeps its values; supervisors read them as delays | UPDATE |
| `packages/opencode/src/task/blend/schema.ts` | `ensures` required in `VerifyFrontMatter` (D11) | UPDATE |
| `task-formats/blend/schema/verify.schema.json` | Top-level `required: ["ensures"]` for parity with the Effect schema (D11) | UPDATE |
| `task-formats/blend/README.md` | "Validation" section (AC 1); `ensures` required; Layout tree lists the example folders | UPDATE |
| `task-formats/blend/example-format-faults.spec` | Fault folder: stray file, `TASK.md` with no H1, unknown front-matter key (D14) | NEW |
| `task-formats/blend/example-cycle.spec` | Fault folder: T1.1 after T1.2, T1.2 after T1.1 (D14) | NEW |
| `task-formats/blend/example-self-after.spec` | Fault folder: T1.1 after T1.1 (D14) | NEW |
| `task-formats/blend/example-unknown-after.spec` | Fault folder: `after` names T7 (D14) | NEW |
| `task-formats/blend/example-no-ensures.spec` | Fault folder: a leaf `VERIFY.md` with no `ensures` (D14) | NEW |
| `task-formats/blend/example-outside-run.spec` | Valid spec: T1.2 after T1.1, run as the T1.2 subtree (D14) | NEW |
| `task-formats/blend/example-scenarios.spec` | Live-check folder, built in phase 1 (T1.15): parent T1, one leaf and scenario S1 proved by a `[S1]` test (D15) | NEW |
| `task-formats/blend/example-cascade.spec` | Live-check folder, built in phase 1 (T1.15): parent T1; T1.1 gate always exits 1, budget 1; T1.2 after T1.1; T1.3 independent (D15) | NEW |
| `packages/opencode/script/task-demo.sh` | Copies every `example-*.spec` folder too (D15) | UPDATE |
| `packages/opencode/src/session/prompt.ts` | `taskOps.prompt` forwards part metadata; `taskOps.say`; hook call sites take `HarnessHooks`; `SessionPrompt.node` depends on `TaskHarness.node` | UPDATE |
| `packages/opencode/test/task/engine-xstate.test.ts` | Rewritten as fact sequences; header list classes each old test (owner ruling 2) | UPDATE |
| `packages/opencode/test/task/engine-xstate-random.test.ts` | Snapshots and selectors; AD-5 fold tests | UPDATE |
| `packages/opencode/test/task/engine-xstate-graph.test.ts` | Graph proof (AD-7) | NEW |
| `packages/opencode/test/task/port-conformance.test.ts` | Re-runs the 2026-10-14 port probes (spine Stack section) | NEW |
| `packages/opencode/test/task/state-audit.test.ts` | D9 audit with the AD-17 allowlist | NEW |
| `packages/opencode/test/task/lib` | Folder: `delegate.ts` (runs a named test of another package, asserts it passed), `scripted.ts` (scripted-model run helper) | NEW |
| `packages/opencode/test/task/core-status.test.ts` | `toEqual` expectations follow the new state names (P1) and the AD-13 fields (P2) | UPDATE |
| `packages/opencode/test/task/core-command.test.ts` | Refusal text follows EXPERIENCE (D10); fake `Ops` gains `say` | UPDATE |
| `packages/opencode/test/task/core-runner.test.ts` | Imports follow the moved pure functions | UPDATE |
| `packages/opencode/test/task/harness-wiring.test.ts` | Hook round trips through `HarnessHooks` | UPDATE |
| `packages/opencode/test/task/blend-messages.test.ts` | Seven `VerifyFrontMatter` cases gain `ensures`; one new missing-`ensures` case | UPDATE |
| `packages/opencode/test/task-harness/conformance.test.ts` | Follows the new outcome rules (H3 reason, no `run.ended done`); H1–H16 stay green | UPDATE |
| `packages/opencode/test/task-harness/arms/status.ts` | Conformance status reader accepts `blocked` and the AD-13 fields | UPDATE |
| `packages/tui/package.json` | Adds `"@jambudipa/xstate-effect": "catalog:"` (D16) | UPDATE |
| `packages/tui/src/task-ui/machine.ts` | The `taskView` machine (AD-16) | NEW |
| `packages/tui/src/task-ui/actor.ts` | The `fromActor` adapter (AD-16, AD-17) | NEW |
| `packages/tui/src/task-ui/shared.tsx` | Shared region: run warning list, outside wait lines, STOPPED list, SCENARIOS list (EXPERIENCE) | NEW |
| `packages/tui/src/task-ui/store.ts` | AD-13 decode, tag classification, `DISPLAY` table, durations, run usage helpers; `ACTIVE`, `ENDED`, `poll`, `LIVE_WINDOW` go | UPDATE |
| `packages/tui/src/task-ui/index.tsx` | Creates the `taskView` actor and adapter; the 1 s poll and the root signal go | UPDATE |
| `packages/tui/src/task-ui/ui.tsx` | Brand spinner (D23), shortcut bar without the `/task-design` hint (D22), new status parts | UPDATE |
| `packages/tui/src/task-ui/watch.tsx` | `armed`/`disarm` and `target` move into the machine; 500 ms tail becomes a delayed transition | UPDATE |
| `packages/tui/src/task-ui/peek.tsx` | BUILDER heading reasons and durations (D19, D21); polls become delayed transitions; `harnessOf` carries tokens and cost | UPDATE |
| `packages/tui/src/task-ui/designs/1-ledger.tsx` | Run title, outside line, refusal lines, shared region | UPDATE |
| `packages/tui/src/task-ui/designs/2-dock.tsx` | Strip parts, cost segment, shared region | UPDATE |
| `packages/tui/src/task-ui/designs/3-board.tsx` | Columns from tags, card lines 2–3, STOPPED groups | UPDATE |
| `packages/tui/src/task-ui/designs/4-matrix.tsx` | `time` column, legend `⊖ blocked`, shared region | UPDATE |
| `packages/tui/src/task-ui/designs/5-gantt.tsx` | Lanes from `spans`, right column (duration and state) | UPDATE |
| `packages/tui/src/task-ui/designs/6-hud.tsx` | Selected-task line with duration, elapsed and run usage | UPDATE |
| `packages/tui/src/task-ui/designs/7-ticker.tsx` | Toast reasons, end notification from tags, shared region in the dialog | UPDATE |
| `packages/tui/src/task-ui/designs/screen.tsx` | Full-screen header (title, run usage), refused body, shared region | UPDATE |
| `packages/tui/src/task-ui/README.md` | Documents the machine, liveness, tags, the animated mark, run usage | UPDATE |
| `packages/tui/src/routes/session/index.tsx` | User message renders the run header from text-part metadata (D17) | UPDATE |
| `packages/tui/src/component/prompt/index.tsx` | Run usage in the prompt footer (D24) | UPDATE |
| `packages/tui/src/feature-plugins/sidebar/context.tsx` | Run usage lines in the Context panel (D24) | UPDATE |
| `packages/tui/test/task-ui/task-ui.test.tsx` | Re-baselined for the hint, the lane and tags; new behaviour tests | UPDATE |
| `packages/tui/test/task-ui/fixture-status.json` | Old fixture; kept through phase 3, deleted by T4.2 once no test reads it | UPDATE |
| `packages/tui/test/task-ui/fixture-projected.json` | Shared fixture: the AD-13 projection of the observed facts, written by `status-fixture.test.ts` (SD-10) | NEW |
| `packages/opencode/test/task/engine-api.test.ts` | Engine API selectors, purity, foreign and error snapshots (T1.6) | NEW |
| `packages/opencode/test/task/alphabet.test.ts` | Progress alphabet and walk key (T1.9) | NEW |
| `packages/opencode/test/task/delegate.test.ts` | The delegate helper (T1.13) | NEW |
| `packages/opencode/test/task/live-check-runs.test.ts` | Scripted runs of the live-check folders (T3.9) | NEW |
| `packages/opencode/test/task/task-demo.test.ts` | The demo seed copies every example folder (T3.10) | NEW |
| `packages/opencode/test/task/core-sessions.test.ts` | Message builders stay; imports follow T2.12 | UPDATE |
| `packages/opencode/test/task/blend.test.ts` | Loads the example folders (T3.5, T3.7) | UPDATE |
| `packages/tui/test/task-ui/plugin.test.tsx` | Plugin behaviour on the view actor (T4.3) | UPDATE |
| `packages/tui/test/task-ui/fixture-phase1.json` | Phase-1 projection of the observed facts for RM26 (T1.12; retired by T2.3) | NEW |

## UPDATE-file analysis (current / what changes / what must be preserved)

**`engine-xstate/index.ts`** (892 lines) — *Current:* header (20-49) says "four machines, joined by fold code" (23)
and "the fold keeps one machine per unit" (31-32). `obligationMachine` (174-219), `taskMachine` (319-475, parallel:
`evidence` 382-406 with transient `assessing`, `work` 407-473 with `waiting`, `building`, `proving`, `verifying`,
transient `judging`, `trusted`, `stalled`, finals `needs_human`, `budget_exhausted`, `cancelled`, `failed`, and
`other`), `scenarioMachine` (500-533), `runMachine` (597-633; finals `refused`, `done`, `cancelled`, `needs_human`,
`budget_exhausted`, `failed` at 623-628; `other` takes `follows` at 631). `follows` (567-582), `runPure` (639),
`stepRun` (684-692), `stepTask` (695-745, sends `task.moved` to the run), `cancel` (748-757), `staleAlone` (761-777),
`stepScenario` (779-793), `initial` (796-859), `apply` (862-888, returns early when the run is `done`),
`XStateEngine` (890). A fact that changes nothing returns the identical `State`. *Changes:* D1, D2, D3, D4 — the
whole fold is replaced by `machine(plan)` plus a pure `apply(plan, snapshot, fact)` over the port's `transition`;
selectors `view`, `unitState`, `tags`, `waitingOn`, `blockedBy`, `ended`; memoised machine per plan (`WeakMap`); dies
on a snapshot of another machine; returns its input when the snapshot status is not `active`. *Preserved:*
purity and identity on a no-op fact; history entry shape `{ at, unit, from?, to, reason? }`; reason texts
(`<id>: <reason>`, `<id>: not judged`, `stale: <id>`); attempts and budget rules (a parent's single review counts as
attempt 1 and is never rebuilt); `worktree`/`branch`/`base`/`head`/`session` appear only once a fact sets them;
`outside.trusted` history entry `{ unit: <id>, to: "trusted", reason: "outside" }`. Callers: `command.ts:14, 192,
204`; `runner.ts:125, 796, 833-858`; `events.ts:120-121`; `status.ts`; `core-status.test.ts:60-176`; both engine
tests.

**`core/model.ts`** (130) — *Current:* `RunState` (7), `TaskState` (8-18, has `stalled`, no `blocked`), `State`
(61-67), `Fact` union (76-107), `Plan` (110-121), `Engine` (124-128) over `State`. *Changes:* `TaskState` gains
`blocked`; `ScenarioState` gains `blocked` and `cancelled`; `Engine` takes an opaque `RunSnapshot`; `State` is the
`view` selector's output only; `Plan` gains `external` ids (P3, AD-15). *Preserved:* the `Fact` union stays equal to
`FactSchema`; `Plan` built by `TaskCommand.plan`.

**`core/events.ts`** (123) — *Current:* `FactSchema` (31-54), `ENDED` (82), `ended` (84), `publish` (86-92), `read`
(97-107, pages of 500), `latestRun` (110-113), `trustedOutside` (116-117), `fold(engine, plan, facts)` (120-121).
*Changes:* `fold` returns a snapshot; `ended` reads the engine selector; new members per AD-10 land in the phase that
writes them. *Preserved:* event type and version (durable v1); every stored payload still decodes; `latestRun`,
`trustedOutside`.

**`core/status.ts`** (179) — *Current:* closed literal sets (10-34), `Task` (36-42), `Status` (62-68), `ACTIVE` (73),
`trusted()` (86-91; an id outside both plan and outside counts as untrusted, which makes a subtree wait for ever),
`waitingOn` (94-95), `runState` (97-105), `project` (108-144; maps a verifying scenario to `pending` at 136),
`refused` (147-153), `write` (166-177, atomic, a failure is only logged). *Changes:* phase 1 projects through
`view(snapshot)` with today's fields and the new state names (AD-20); phase 2 implements AD-13 exactly (tags,
causes, times, spans, titles, `outside`, `external`, `warning`, `aliveAt` stamped by `write`); `runState` and the
`waitingOn` derivation go. *Preserved:* atomic write with no leftover temp file; `proofLogFile`; field names the TUI
and the conformance reader read; `refused` keeps `spec = specPath` (and `args` for the R1 not-inside case).

**`core/runner.ts`** (886) — *Current:* `Run` holds `state`, `outside` and `spec` Refs (63-66), lock/checkout/git
semaphores (68-72), `children` and `failures` MutableHashMaps (74-75), `stopping` Ref (76), a `FiberMap` of workers
(79); process-wide `active` registry (90) with `running` (93) and `trustActive` (96-101); `record` (120-132:
publish, `engine.apply`, outside update, `writeStatus`, under the lock, uninterruptible); `build` (405-483, `let
text` 424, `let nudges` 434, `while (true)` 435); `mergeLeaf` (499-508, 3 retries spaced 500 ms); `checkStale`
(633-644); `checkWallClocks` (661-682); `checkDone` (691-712); `MAX_FAILURES` (716); `guarded` (720-754, 1 s retry
sleep 735); `schedule` (756-789, readiness at 768, scenario readiness 776-778); `TICK` 250 ms (791), `STALE_EVERY` 4
(792), `loop` with `let tick` (794-804); `stopWork` (808-815); `interrupted` (819-827); `unfinishedBase` (833);
`run` (844-884). Exported pure functions: `latestVerdicts` (182), `results` (258-280), `scenarioOutcome` (586),
`taskClockStart` (653), `unfinishedBase` (833). *Changes:* phase 1 (AD-20): holds the run snapshot, `record` folds
with `apply`, `schedule` starts work by phase tags, the loop ends when the snapshot status is `done`; `checkDone`,
the readiness check, the `outside` Ref and the recording of `run.ended { state: "done" }` go. Phase 2: everything
stateful goes; the pure exports move to the module that uses them (`workers.ts` or `supervise/*`). *Preserved:* the
pure exports and their tests (`core-runner.test.ts`); `unfinishedBase` (used by `command.ts:191`); facts per
transition; resume by fold; a cancelled job records `run.cancelled`; a server stop leaves the run resumable
(819-827); child turns cancelled within `cancelDeadline`; the merged head is the proved head (497-508); conformance
H1–H16.

**`core/sessions.ts`** (314) — *Current:* message builders `builderMessage` (59-106), `continueMessage` (109),
`nudgeMessage` (113), `judgeMessage` (116-142), `judgeMissingMessage` (145-150), `oneLine` (34); child-session
create / prompt / cancel (155-179) inside `env.instances.provide({ directory })`; `builderHistory` (184-194);
`SPEND_CAP` (199); `spendCapError` (220-234); `builderTurn` (242-312) with `activity` (256), `outcome` (257) and
`busy` (273) Refs and a `while (true)` loop polling every 200 ms (`POLL`, 206) for retry spend cap and stall (274-300).
*Changes:* the Refs and the loop go; the turn becomes the `builderTurn` worker plus the `sessionEvents`
`fromCallback` actor; stall, spend cap and idle become task-supervisor transitions and guards (AD-11). *Preserved:*
message texts pinned by `core-sessions.test.ts` and read by the scripted model; spend-cap detection on both the retry
status and the turn error (conformance H14); a running tool resets the idle clock; per-instance provide.

**`core/hooks.ts`** (97) — *Current:* `BUILDER`, `VERIFIER` (12-13); `shellEnvironment` (20-24); module-level
MutableHashMaps `ready` (28), `verdicts` (29), `repeated` (30), `limits` (31); `take` (36-40); `watch` / `watching`
/ `unwatch` (43-55; `unwatch` is never called in `src`, so `limits` leaks); `recordReady` / `takeReady` (57-64);
`recordVerdicts` / `takeVerdicts` (66-74); `checkRepetition` (80-90); `takeRepeated` (93-95). Synchronous callers:
`prompt.ts:1215-1216` (repetition check before each model request), `prompt.ts:1288` (`createTaskHarnessTools(agent,
sessionID)`, defined at `prompt.ts:1714-1758`; `recordReady` 1728, `recordVerdicts` 1749), `tool/shell.ts:491`,
`agent/agent.ts:286, 322`. *Changes:* AD-11 — the maps go; functions take a `HarnessHooks` value
(`ownerOf(session)`, `send(event)`, `limitOf(session)`) and send `hook.ready`, `hook.verdicts`, `hook.repeated` to the
owning supervisor; `repetition(limit, calls)` stays pure. *Preserved:* tool names, an invalid verdict records
nothing, shell environment stripping, the repetition limit 3 and its reason text (`harness-wiring.test.ts`).

**`core/command.ts`** (229) — *Current:* checks in order: `currentModel` and directory (122-133); `trust <id>`
(135-146, reply "Task harness: recorded the outside precondition <id> as trusted."); usage (147); limits and
`ensureExcluded` (149-151); `.spec` folder (160); `Blend.load` with the FIRST failure only (163-165; fallback "R1 .:
the spec did not load" 166); task folder R2 (171-176); busy per run id (178-179, "Task harness: the run of <spec> is
already going on."); `readiness` (182-185); `environment(ops)` (189); `plan` (190; scenarios whose needs fall outside
are dropped silently at 106); unfinished base on another branch (191-201); `BackgroundJob.start` (214-223, its
output "the task run of <spec> ended <state>" at 219-222); reply "Task harness: running <args> in the background.
Its status is in .opencode/task/status.json." (224-226). *Changes:* AD-19 order (usage, loader, R2, `run.live`, git
readiness, unfinished base, D13, `run.claim`, `BackgroundJob.start` with `run.release` on a failed start); every
loader failure (D10); D13 refusal with trust from folded slices (AD-15); resume only when the latest slice is not
ended and has the same path (AD-6); the run header with `metadata.taskHarness.header` (D17); the job body builds the
run scope (AD-8). *Preserved:* no model request ever (`prompt.test.ts:2476`, conformance H1, H2); refusals need no
session services; `ensureExcluded` before any status write; the branch-resume refusal; the trust branch; the job id
is the run id with `metadata.parentSessionId`, so cancelling the session cancels the job (`run-state.ts:111-145`,
H16); `plan()` results for subtrees (`core-status.test.ts`).

**`core/ops.ts`** (26) — *Current:* `PromptInput` (8-15) text parts `{ type, text }` with no `metadata`; `Ops` =
`prompt`, `cancel`, `currentModel`. *Changes:* optional text-part `metadata` (D17); `say({ sessionID, text })`
(D18). *Preserved:* no import of `SessionPrompt`. The fake `Ops` in `core-command.test.ts:37-47` gains `say`.

**`session/prompt.ts`** — *Current:* `taskOps` (1396-1411); `/task` dispatch (1428) before any template read;
`prompt` (1093-1113; `noReply` returns the user message at 1111); text parts already accept `metadata`
(`packages/schema/src/v1/session.ts:114, 419`); an assistant message is written only in `runLoop` (1228-1243); the
loop exits on an assistant whose `finish` is not `tool-calls`/`unknown` and whose `parentID` is the last user
(1154-1173); one runner per session (`run-state.ts:52-69`). *Changes:* forward part metadata; implement `say`
(complete `SessionV1.Assistant`, `parentID` = the run header message, current model, zero cost and tokens,
`time.completed`, `finish: "stop"`, plus one text part; waits behind the session's run lock; still writes after the
user aborts); hook call sites pass `HarnessHooks`; `SessionPrompt.node` depends on `TaskHarness.node`. *Preserved:*
`/task` takes no run lock and makes no model call; the run-loop exit rule (a later user prompt still loops); cancel
propagation to the task job.

**`blend/schema.ts`** (196) — *Current:* `VerifyFrontMatter` (149-165) with `ensures` as `optionalKey` (152,
`minProperties 1`). `task-formats/blend/schema/verify.schema.json` has no top-level `required`. *Changes:* `ensures`
required in both (D11); a missing `ensures` fails R3 with `(root): 'ensures' is a required property`
(`document.ts:101`). *Preserved:* R3 message parity with the Python checker; every shipped `VERIFY.md` and every
golden negative already has `ensures`.

**`blend/index.ts`, `blend/model.ts`, `blend/rules.ts`** — *Current:* `load` never fails and returns every failure,
stable-sorted by rule (86-94); R1–R4 per file skip the cross-file rules (67-69, 82); spec id = folder name minus
`.spec` (71), title = `SPEC.md` H1 (72, 327); `Failure { rule, path, message }`, `path` relative to the `.spec`
folder, `.` for the folder (`model.ts:83-87`); R6 unknown `after` "after names unknown task X" (`rules.ts:54-56`); R7
order (`rules.ts:101-125`: ancestor/descendant 104-112, cycles 120-123 as "order has a cycle: A → B → A", DFS
127-150; a self-after is the cycle "T → T"). *Changes:* none for D10 (the loader already returns every failure).
*Preserved:* golden model equality and the 38 negative cases (`blend.test.ts`).

**`task-formats/blend/README.md`** — *Current:* sections Layout (12; its tree lists only
`provider-ordering-admin.spec`), Design rules (33), file kinds (46; `VERIFY.md` 108), Proofs and judges (187), Rules
R1–R13 (204-223), Parse (225; step 7 at 239 "Report every failure with its file and its rule"), parse target (242),
State (348), Validating (358-371), What changed (373), The example (381). *Changes:* a "Validation" section that
answers questions 1, 3 and 4 (AC 1), replacing "Validating"; `ensures` required; Layout lists the example folders.
*Preserved:* rule numbering and parse step order.

**`script/task-demo.sh`** — *Current:* wipe guard (17-27), copies `test/task-harness/release-notes-repo` (29), copies
only `release-notes.spec` and `provider-ordering-admin.spec` (30-33), `git init` on `main`, commit "seed",
`bun install --frozen-lockfile`, `exec bun dev`, prints "/task trust T9" and the release-notes command (41).
*Changes:* copy every `task-formats/blend/example-*.spec` folder; print the two live-check commands. *Preserved:*
the wipe guard, the clean checkout, the printed instructions.

**`script/task-conformance.ts`** — runs `test/task-harness/conformance.test.ts` per arm and scores H1–H16 plus L1.
`FINGERPRINT` (43-51) covers both spec trees, the seed, the solution, the suite, `scripts.ts` and `arms`; the guard
fails when a fingerprinted path is dirty, so edits there must be committed before a conformance run. Command: `cd
packages/opencode && bun run script/task-conformance.ts --arm o2 --runs 1`.

**TUI `task-ui/store.ts`** (335) — *Current:* mirror schema (10-44, open strings, `reason`/`worktree`/`from`
`optional(NullOr(String))`, `attempts` and `waitingOn` required); `parse` (49); `poll` (52-63: `createSignal` plus
`Effect.repeat(Schedule.spaced)`); `LIVE_WINDOW` 300 000 ms (81); `TONES` (93-111), `GLYPHS` (113-131), fallbacks
`idle`/`•` (133-135); `ACTIVE` (161), `ENDED` (164) used at 209, 215, 227, 237 and in `watch.tsx:98, 462`,
`5-gantt.tsx:18`, `7-ticker.tsx:64`; `createView` with signals `design`, `chosen`, `expanded`, `watching`
(286-289). *Changes:* AD-13 decode (new fields optional), tag classification, `DISPLAY` table (adds `blocked` `⊖`
warning), durations, run usage; `ACTIVE`, `ENDED`, `poll`, `LIVE_WINDOW` and the four signals go. *Preserved:*
`parse` refuses `{`, `{run:{}}` and `''`; tree order; selection wrap and design cycle 7→1; the last good status is
kept when a read fails.

**TUI `task-ui/index.tsx`** (202) — *Current:* design from kv `task_ui_design` (44); a 1 s poll of text, mtime, proof
logs and clock (72-81); `root` signal (88-93); `liveSessions(api, root)` 2 s poll and `owns` (98-100); `live` memo
(101-110); keymap layer with `task-design` slash name (178-196); `registerTab` (199). *Changes:* creates the
`taskView` actor and the `fromActor` signal; the poll, `root` and `live` go into the machine. *Preserved:*
`/task-design` picker and the seven designs; following a rewritten status; kv persistence and the invalid-value
fallback; no status file shows nothing and Tab goes to the agent (`plugin.test.tsx`).

**TUI `task-ui/ui.tsx`** (241) — *Current:* `Brand` (52-58) static bold `◆ In the Flow`; `barKeys` (123-140) with the
`/task-design` "switch" part at 136; `registerTab` (148-180); `ShortcutBar` (186-227, per-design order 197, width fit
198-205). *Changes:* D22 removes 136; D23 Brand becomes the spinner row; new parts (run warning, outside wait,
stopped count). *Preserved:* drop order at narrow widths; watch-mode bar strings; Tab behaviour. `task-ui.test.tsx`
lines 191 and 195 pin the old hint and change.

**TUI `task-ui/watch.tsx`** (465) — *Current:* `chooseWatch` (91-143), `WatchBand` (155-195), `LiveProofPanel` 500 ms
tail (272-292), `stopper` (300-330: `armed` signal 306, local `let disarm` 307, `Effect.sleep` 5 s 322-326),
`target` signal (359-366), `esc` layer (438-450), toggle (453-464). *Changes:* `stopKey` and `watch` regions,
delayed tail. *Preserved:* `chooseWatch`, `bandText`, proof panel, esc twice aborts and toasts, Board collapse on
watch. `task-ui.test.tsx:341` renders `WatchBand` and expects `◆ In the Flow watching…`, which an animated Brand
changes (the test injects a still or ended liveness, or a static frame).

**TUI `task-ui/peek.tsx`** (259) — *Current:* `harnessOf` (38-56) maps id, unit, role, again, created, updated;
`liveSessions` (62-84) polls children and all sessions every 2 s and activity every 1.5 s; BUILDER heading from
`builderText` (200-204, "attempts · state"). *Changes:* reasons, wait sentences, durations, did-not-start fallback;
`harnessOf` carries tokens and cost; polls become delayed transitions. *Preserved:* `lines()`, titles,
"BUILDER  attempt 3 · budget exhausted" becomes the EXPERIENCE form (re-baselined).

**TUI designs** — `1-ledger.tsx` (WIDTH 38, header 16-19, spec basename 20-25, reason 39-43); `2-dock.tsx`;
`3-board.tsx` (`COLUMNS` 7-15, STOPPED is the fallback column, `columnOf` 17-18 on the raw state, reason on the card
81-85); `4-matrix.tsx` (the only SCENARIOS list today 68-79); `5-gantt.tsx` (`span` 15-22 uses `ENDED`, `lane` 25-36
derives state from history at 29); `6-hud.tsx` (imports `span`); `7-ticker.tsx` (toasts 52-63, `attention.notify` on
`ENDED` 64-68, local `let shown` 73-104); `screen.tsx` (header 28-42, reason 43-47). *Preserved:* the render strings
pinned by `task-ui.test.tsx:145-158` unless EXPERIENCE changes them.

**TUI `component/prompt/index.tsx`** — usage memo (310-327) from the last assistant message with output tokens, cost
shown only above 0; rendered at 1771-1777. **`feature-plugins/sidebar/context.tsx`** — three lines from the last
assistant message with output tokens (21, 43-45). **`component/spinner.tsx`** — `<spinner frames interval={80}>`
gated by kv `animations_enabled`, fallback `⋯` (17-19). **`routes/session/index.tsx`** — `UserMessage` (1563-1660)
renders non-synthetic text and ignores `TextPart.metadata`, but the parts are available (1444-1463); sidebar shows
above 120 cells (316). No tests cover the footer and the sidebar today.

**Engine tests** — `engine-xstate.test.ts` (618) has 27 tests plus 2 base tests. The ones that change class:
stop-at-once (6, 9, 11, 12, 13, 17, 21, 23, 24 and the `follows` half of 27), waiting-on-cancel (14), hand-built
`State` via `altered` (25, 26, 27). `engine-xstate-random.test.ts` folds 40 seeds × 100 facts and requires 11 moves.

## Technical Decisions

Spec decisions (SD) fill gaps the inputs leave. Each cites its source. None contradicts a D<n>.

- **SD-1 Test folder and names.** `TEST_DIR` below. Scenario tests are `verify-spec-<ID>.spec.ts` (the generator
  names them after the spec folder `spec`); each test title starts with the scenario id and a space. Source: the
  definitions generator, the paused `task-harness` spec precedent.
- **SD-2 UI scenarios delegate.** `packages/tui` does not export `task-ui`, and `packages/opencode` must not import
  TUI sources by relative path. A UI scenario test in `TEST_DIR` calls `test/task/lib/delegate.ts`, which runs
  `bun test --timeout 30000 <file> -t <pattern> --reporter=junit --reporter-outfile=<tmp>` with the working directory
  `packages/tui`, reads the report with `Junit` (`src/task/proof/junit.ts`), and passes only when the exit code is 0 and at least one named
  test passed. Source: plan.md ("the opentui test renderer in `packages/tui/test/task-ui/`"), repo facts.
- **SD-3 Phase mapping.** Parent T1 is plan phase 1, T2 phase 2, T3 phase 3, T4 phase 4. The goal loop's checkpoint
  merge (AC 7) follows the review of T1. Source: plan.md, the brief.
- **SD-4 AC 6 at the checkpoint (resolved by prepare-goal).** AC 6 names "both valid live-check plans", and AC 7
  merges after AC 2–6 pass. T1.15 builds `example-scenarios.spec` and `example-cascade.spec` in phase 1 (with the
  parent T1 that R2 requires and `ensures` in every `VERIFY.md`), and T1.10 walks their plans loaded with
  `Blend.load`. T3.7 checks that both still load once `ensures` is required. No hand-built shapes exist. Source:
  prepare-goal ruling of 2026-10-14, from the AC 6 and AC 7 text.
- **SD-5 Fact members land with their phase.** `task.nudged` and the optional `path` land in phase 2 (the supervisors
  write them); `spec.checked` lands in phase 3 (D12). Source: spine Deferred ("each new member lands no earlier than
  the phase that writes it").
- **SD-6 The summary lands in phase 4.** In phase 2 the run supervisor goes from a `done` run actor straight to
  `closed`; phase 4 inserts the `summary` invocation before `closed` (AD-18). Source: D18 in phase 4.
- **SD-7 External regions land in phase 1; the D13 refusal in phase 3.** A subtree plan's `after` ids outside the run
  need a node, or the generated `stateIn` guard names no state and the port returns an `error` snapshot. So T1.2 adds
  `external` regions (AD-15) and `TaskCommand.plan` lists them in phase 1; an untrusted external region keeps its
  dependant waiting, as today. The D13 refusal, the trust read from folded slices and the start-up trust record land
  in T3.4. Source: AD-1, AD-6, AD-15; adversarial review.
- **SD-8 The audit allowlist shrinks.** T2.1 lands the audit with the AD-17 final entries plus interim entries for
  every phase-1 construct that phase 2 removes; each interim entry names the task that removes it. T2.13 requires the
  entries for `packages/opencode/src/task/` to equal the AD-17 entries for that tree; T4.13 requires the whole list to
  equal AD-17 with `task-ui` in scope. Source: plan.md, AD-17.
- **SD-9 Refusal text.** Refusals follow EXPERIENCE: header line, the `run.reason` lines, optional hint. The two
  `core-command.test.ts` strings are re-baselined in phase 3. Source: D10, AD-14, EXPERIENCE "Refusal".
- **SD-10 Shared status fixture.** `packages/opencode/test/task/status-fixture.test.ts` builds the AD-13 projection of
  the observed release-notes facts (T1.1–T1.3 trusted, T1.4 budget exhausted after 3 attempts, so T1.5 and T1
  blocked) with a fixed clock through `TaskStatus.write`, and requires it to equal a NEW file
  `packages/tui/test/task-ui/fixture-projected.json`; `UPDATE_FIXTURE=1` rewrites the file; a TUI test decodes it in
  phase 2. The old `fixture-status.json` stays until phase 4, so the TUI suite stays green in phase 2; T4.2 moves the
  TUI tests to the projected fixture, lists each changed test in the file header (ported, re-baselined, retired), as
  for the engine tests, and deletes the old fixture when no test reads it. Source: AD-13, owner ruling 2 by analogy.
- **SD-11 Scripted end-to-end runs.** The two live-check folders also run with the scripted model
  (`test/task/lib/scripted.ts`, over `test/lib/llm-server.ts` and `provideTmpdirServer`), so D2 and D3 are proved
  through `/task` without paid spend; the paid tmux check stays a goal-loop step (D25).
- **SD-12 Phase-1 TUI display.** The TUI decodes every state as an open string, so a phase-1 `blocked` task decodes,
  shows the fallback glyph `•`, the label "blocked", sits in STOPPED (the fallback column) and shows its reason on the
  Board card. The `⊖` row lands with the `DISPLAY` table in phase 4. No phase-1 TUI change.
- **SD-13 An unloadable stored slice.** The inputs do not say what the D13 check does when a stored slice's `path`
  no longer loads. This spec pins the conservative choice: the command refuses with one plain line that names the
  slice's path, because without that plan it cannot know whether the slice holds the folder task (AD-15). Own
  judgment; the owner may overrule.
- **SD-14 The outcome entry's `from`.** The `running` ↔ `waiting` toggles of `outcome` are not logged (AD-4), so the
  run's final history entry has `from` equal to the run's last logged state (`running`, written by `run.started` or
  `run.resumed`). Source: AD-4, AD-5; adversarial review.
- **SD-15 The line of an obligation-id change.** AD-12 makes a valid reload that adds or removes an obligation id of
  the plan a `spec.checked` failure but sets no line. This spec pins `R3 <task folder>/VERIFY.md: obligation <id> is
  not in the loaded plan; the run keeps the plan it loaded` (added) and `R3 <task folder>/VERIFY.md: obligation <id>
  of the loaded plan is missing; the run keeps the plan it loaded` (removed). Own judgment.
- **SD-16 An `error` snapshot is a defect.** AD-6 says `apply` returns its input when the snapshot status is not
  `active`, and that any status other than `active` from `initial` is a defect. This spec narrows the pass-through to
  `done`: `apply` dies on an `error` snapshot (RM28), so a machine error never freezes a run.

## Test Patterns

TEST_DIR: packages/opencode/test/task

- **Why this folder.** `packages/opencode` holds the harness, depends on `@opencode-ai/tui` (`workspace:*`), and its
  test preload loads `@opentui/solid/preload`. Every scenario test lives here. UI scenarios delegate (SD-2).
- **File names.** `packages/opencode/test/task/verify-spec-<SCENARIO-ID>.spec.ts`. Every test title starts with the
  scenario id and a space (`RM7 T1.5 and T1 block in the fold step that exhausts T1.4`). Bun discovers `*.spec.ts`.
- **Running.** Never from the repository root. A path under `packages/<name>/` runs from that package:
  `cd packages/opencode && bun test --timeout 30000 test/task/<file>`; `cd packages/tui && bun test --timeout 30000
  test/task-ui/<file>`. The graph walks set an explicit 60 s per-test timeout (AD-7).
- **Unit tests** sit beside the scenario files: `engine-xstate.test.ts`, `engine-xstate-random.test.ts`,
  `engine-xstate-graph.test.ts`, `port-conformance.test.ts`, `state-audit.test.ts`, `machine.test.ts`,
  `recorder.test.ts`, `harness.test.ts`, `supervise-run.test.ts`, `supervise-task.test.ts`,
  `supervise-scenario.test.ts`, `workers.test.ts`, `status-fixture.test.ts`, `fault-folders.test.ts`,
  `summary.test.ts`, `readme-validation.test.ts`, plus the existing `core-*` and
  `blend*` tests. TUI unit tests: `packages/tui/test/task-ui/machine.test.ts`, `task-ui.test.tsx`,
  `shared.test.tsx`, `designs.test.tsx`, `usage.test.tsx`, `plugin.test.tsx`.
- **Effect tests.** `testEffect(NodeServices.layer)` from `test/lib/effect.ts`; `it.instance(..., { git: true })`
  with `TestInstance` from `test/fixture/fixture.ts`; `TestClock` from `effect/testing` for delayed transitions and
  heartbeats (no real sleeps in supervisor tests).
- **Command tests.** `TaskCommand.run({ sessionID, arguments }, ops)` with a recording fake `Ops` (pattern of
  `core-command.test.ts:35-50`); read `.opencode/task/status.json` for `run`.
- **Scripted model.** `test/lib/llm-server.ts` and the conformance helpers (`test/task-harness/scripts.ts`,
  `arms/*`) drive builder and verifier turns.
- **TUI tests.** `testRender` from `@opentui/solid`; viewport 120 × 40 by default; `parse(JSON.stringify(fixture))`;
  inject `now` and `run.aliveAt` instead of a real clock; drive the `taskView` actor with events.
- **Baseline (2026-10-14, `ac870df79a`).** `engine-xstate.test.ts`, `core-status.test.ts` and `blend.test.ts`: 86 pass,
  0 fail, 3.2 s. Root `bun lint`: 0 errors, 0 warnings, about 15 min. `packages/opencode` `bun typecheck`: clean,
  6 s. `bun test --timeout 30000 test/task` in `packages/opencode` (the filter also matches
  `test/task-harness`): 270 tests, 0 fail, 18 skipped (the conformance checks skip without `TASK_HARNESS_ARM`), 45 s.
  `packages/tui/test/task-ui`: 33 pass, 0 fail, 5.4 s.
- **Scenario evidence (risk for `[DS]`).** The bundled `scenario-state-reporter.mjs` and the verify-scenario skill name
  Vitest and Playwright runners; every scenario test here runs under `bun test`. The goal loop must name the
  sanctioned evidence path for a `bun test` file before `[DS]` verifies a scenario. `[CS]` cannot change the reporter
  (anti-tamper policy). BUILD-1 to BUILD-4 and BUILD-6 are build checks run by command, not scenario files.

## Coding-standards constraints by phase

Sources: `docs/CLAUDE/code-standards/effect_v4.md` (EFX-xx), root and package `AGENTS.md`, the owner's state rule.

| Phase | Constraints |
| --- | --- |
| All | EFX-09 (v4 combinator names); EFX-01 (`Effect.fn` names); EFX-07 (synchronous logic stays synchronous); EFX-18 (die for broken invariants: a machine-definition error, a foreign snapshot, a duplicate state id); EFX-21 (decode untrusted data with Schema: status file, facts, front matter); module shape with self re-export; no `any`, no `else`, no `try`/`catch` where avoidable; no Promise API in harness code |
| 1 | The machine is fold-safe: only `assign` and `raise` with no delay; no `after`, `invoke`, `spawn` or custom action (AD-1); guards use `stateIn` on explicit ids, never tags; `maxIterations` 1 000 |
| 2 | EFX-24, EFX-25, EFX-26 (every acquire paired with a release; fibers tied to a scope; `Effect.scoped`); EFX-28 (`record` uninterruptible from first step to last); EFX-29 (bounded retries and waits: 3 worker failures, `cancelDeadline`); EFX-31 (capture the context for the async tool `execute` callbacks); EFX-32 (structured logging); no `Ref`, `SynchronizedRef`, `MutableHashMap`, `FiberMap`, polled loop or module-level `let` outside the AD-17 allowlist |
| 3 | EFX-21 for the fault folders' expectations (assert the loader's `Failure` values, and the refusal text built from them); data folders contain no `.ts` file (the package typecheck has no `include`) |
| 4 | No `Effect.repeat`, `Schedule`, `Effect.sleep` or `setInterval` in `task-ui` (AD-16); colours only from theme tokens; every glyph one cell wide; the `fromActor` adapter decides nothing |

## Dependencies

- `@jambudipa/xstate-effect` 0.2.0 (engine, supervisors, TUI view machine, graph proof).
- EventV2 store (facts), `BackgroundJob` (the run's job), `Session` / `SessionStatus` / `SessionPrompt` (child
  sessions, `say`), `InstanceStore`, `Database`.
- `opentui-spinner` 0.0.7 (D23).
- No external service, network call or new provider. The D25 live check spends on the TUI's configured model and is
  a goal-loop step.

## Web Research

Checked on 2026-10-14 with the npm registry (`npm view <package> version` and `time`) and the GitHub advisory
database (`gh api /advisories?ecosystem=npm&affects=<package>`). No upgrade is in scope: the spine pins the catalog
versions, and the user guidance keeps the repository's Effect major.

- **Library:** @jambudipa/xstate-effect
- **Current project version:** 0.2.0 (catalog, exact)
- **Latest stable:** 0.2.0, published 2026-10-14T06:25Z (0.1.0 on 2026-10-09)
- **Breaking changes:** none relative to the pin. The package is pre-1.0, so a minor can change the API; the
  `bunfig.toml` `minimumReleaseAgeExcludes` list already exempts it from the 3-day release age.
- **Security:** no GitHub advisory.
- **Recommended pin:** 0.2.0, exact. The port conformance test (`port-conformance.test.ts`) re-runs the 2026-10-14
  probes so a later upgrade fails in CI, not in a run.
- **Sources:** https://www.npmjs.com/package/@jambudipa/xstate-effect (registry metadata via `npm view`; the web page
  answered HTTP 403), the package's own `llms.txt` and `README.md` in `node_modules`.

- **Library:** effect and @effect/platform-node
- **Current project version:** 4.0.3
- **Latest stable:** 4.0.4, published 2026-10-13
- **Breaking changes:** none expected in a patch; the 4.0.4 release notes were not reachable from the
  `Effect-TS/effect-smol` release list (it lists prereleases only), so the 4.0.3 pin stays authoritative.
- **Security:** advisories GHSA-38f7-945m-qr2g (< 3.20.0) and GHSA-6hr9-4692-fch9 (withdrawn, <= 1.0.4) do not
  affect 4.0.3.
- **Recommended pin:** 4.0.3 (catalog). Keep the repository's Effect major and patch.
- **Sources:** https://www.npmjs.com/package/effect (registry `time` metadata),
  https://github.com/Effect-TS/effect-smol/releases, https://github.com/advisories?query=effect

- **Library:** @opentui/core and @opentui/solid
- **Current project version:** 0.4.5
- **Latest stable:** 0.6.5, published 2026-10-14
- **Breaking changes:** two minors ahead; not evaluated, because no upgrade is in scope and the test renderer API in
  use (`testRender`, `renderOnce`, `captureCharFrame`, `mockInput`) is the 0.4.5 API.
- **Security:** no GitHub advisory.
- **Recommended pin:** 0.4.5 (catalog). The repository upgrades opentui with `script/upgrade-opentui.ts`, outside
  this goal.
- **Sources:** https://www.npmjs.com/package/@opentui/core (registry metadata)

- **Library:** opentui-spinner
- **Current project version:** 0.0.7
- **Latest stable:** 0.0.7, published 2026-06-09
- **Breaking changes:** none.
- **Security:** no GitHub advisory.
- **Recommended pin:** 0.0.7. The `<spinner frames interval color>` element of `component/spinner.tsx` takes a fixed
  frame list, which D23 needs.
- **Sources:** https://www.npmjs.com/package/opentui-spinner (registry metadata)

- **Library:** solid-js
- **Current project version:** 1.9.10
- **Latest stable:** 1.9.17
- **Breaking changes:** none relevant (patch releases).
- **Security:** GHSA-3qxh-p7jc-5xh6 affects < 1.9.4 only; 1.9.10 is not affected.
- **Recommended pin:** 1.9.10 (catalog).
- **Sources:** https://www.npmjs.com/package/solid-js, https://github.com/advisories/GHSA-3qxh-p7jc-5xh6

- **Tool:** Bun
- **Current project version:** 1.3.14 (root `AGENTS.md`; the pre-push hook accepts `^1.3.14`)
- **Latest stable:** 1.4.3 (npm `bun` package)
- **Breaking changes:** not evaluated; no upgrade is in scope. The `bun test` flags this spec uses (`-t`,
  `--reporter=junit`, `--reporter-outfile`, `--timeout`) exist in 1.3.14 (`bun test --help`, checked 2026-10-14).
- **Security:** none found for the pin.
- **Recommended pin:** 1.3.14.
- **Sources:** https://www.npmjs.com/package/bun (registry metadata), local `bun test --help`

- **Tool:** TypeScript and the `tsgo` type checker
- **Current project version:** TypeScript 5.9.3; `@typescript/native-preview` 7.0.0-dev.20251207.1 (`tsgo --noEmit`)
- **Latest stable:** TypeScript 7.0.2 (npm `typescript`)
- **Breaking changes:** not evaluated; no upgrade is in scope.
- **Security:** none relevant.
- **Recommended pin:** the catalog pins.
- **Sources:** https://www.npmjs.com/package/typescript (registry metadata)

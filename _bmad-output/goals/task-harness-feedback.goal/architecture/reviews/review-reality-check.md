---
review: reality-check
target: ../ARCHITECTURE-SPINE.md
reviewer-lens: 'every committed decision was web-researched or reality-checked: versions, technology fit, and every API the spine relies on exists in the installed versions with the assumed semantics'
date: '2026-10-14'
verdict: 'sound foundation, not ready to bind: 1 critical, 3 high, 6 medium, 7 low'
---

# Reality-check review — ARCHITECTURE-SPINE.md (task-harness-feedback)

## Verdict

The spine is well grounded in the installed port and in the brownfield code. Every port API it names exists in
`@jambudipa/xstate-effect` 0.2.0. All four claims it marks "verified 2026-10-14" are true: I re-ran each one.
The stack table matches the root catalog exactly.

Three port behaviours that the spine never states, and therefore never checked, break the spine's own rules:

1. A send from inside actor processing only queues. The Recorder's "send, then write `status.json` from the
   snapshot" therefore writes the snapshot from before the fact (critical).
2. A pure `transition` on a `done` snapshot still moves units, but a live actor drops the event. The fold and
   the live actor diverge after the outcome is final (high).
3. After a `raise`, actions see the raised event, so `event.at` is `undefined` for the outcome move and for
   the run `endedAt` (high).

A fourth gap is unmeasured cost. One pure transition of a single generated machine costs 2 to 15 ms in a
synthetic benchmark. The `limit` of `getAdjacencyMap` counts dequeued edges, not states. AD-7 has no measured
evidence that its walks finish inside `bun test` (high).

## Method

- Read the spine in full. Read the root `package.json` catalog, `bunfig.toml`, the installed port
  (`package.json`, `llms.txt`, `dist/*.d.ts`, `src/`), and the opencode seams that the spine names.
- Queried the npm registry from a scratch directory (`/private/tmp/claude-501/rc-review`):
  `npm view <pkg> version` and `npm view <pkg> time`.
- Fetched the port's 0.2.0 changelog from GitHub. The package does not ship `CHANGELOG.md`, although the README
  links to it.
- Wrote and ran four bun probes outside the repo. Each probe imports the port's `dist/index.js` and the
  `effect@4.0.3` copy by absolute path:
  `/private/tmp/claude-501/rc-review/{probe.ts,probe2.ts,probe3.ts,bench.ts}`. The probe IDs (P1–P16) and their
  output are in the appendix.
- I read no state, evidence or key file.

## What I verified as correct

### Stack table against the catalog, the installed tree and the registry (2026-10-14)

| Spine row | Root catalog (`package.json`) | Installed (`node_modules/.bun`) | npm latest | Result |
| --- | --- | --- | --- | --- |
| Bun 1.3.14 | `packageManager: bun@1.3.14` (line 7) | `bun --version` → 1.3.14 | 1.4.3 | matches repo; not latest |
| TypeScript 5.9.3 | `typescript: 5.9.3` (line 82) | `typescript@5.9.3` | 7.0.2 | matches catalog; see L1 (the real checker is tsgo) |
| effect 4.0.3 | `effect: 4.0.3` (line 70) | `effect@4.0.3` (the port resolves the same copy through its symlink) | 4.0.4 (2026-10-13) | matches repo; not latest |
| @effect/platform-node 4.0.3 | line 38 | — | 4.0.4 | matches repo |
| @jambudipa/xstate-effect 0.2.0 | line 40 | `@jambudipa+xstate-effect@0.2.0+b10868da9591cb2f` | 0.2.0 (published 2026-10-14 06:25 UTC) | matches; latest |
| "XState 5.33.2 behaviour" | port `package.json` description | — | xstate 5.33.2 | matches; latest upstream |
| solid-js 1.9.10 | line 96 | `solid-js@1.9.10` | 1.9.17 | matches repo; not latest |
| @opentui/core, @opentui/solid 0.4.5 | lines 47, 49 | `@opentui+core@0.4.5`, `@opentui+solid@0.4.5` | 0.6.4 | matches repo; two minors behind |

The port has `peerDependencies: { effect: "^4.0.0" }` and exactly one effect copy is installed (4.0.3). No
duplicate effect instance exists.

### Port APIs the spine relies on (all exist in 0.2.0)

| API | Evidence | Semantics as the spine assumes? |
| --- | --- | --- |
| `setup(...).createMachine` | `dist/setup.d.ts:734`; P1–P15 | yes |
| `type: "parallel"`, nested parallel | P2–P4, P15 | yes |
| `always` (eventless) rows | P1, P6, P15 (cascade settles in one macrostep across three regions) | yes |
| `after` with a delay function | `setup({ delays })` (`src/setup.ts:166`); P12 | yes, but see M2 (re-arm needs `reenter: true`) |
| `stateIn("#id")` splits on `.` | `src/stateUtils.ts:959` (`toStatePath`); `src/StateValue.ts:292-308` splits on unescaped `.`; P1 | **yes, re-verified**. A dotted id makes the initial snapshot status `error` ("Child state node '#T1' does not exist") |
| `and`, `or`, `not` | `dist/index.d.ts` guard exports; P6: `and([])` is true, `or([])` is false | yes. A task with no dependencies is ready at once and never blocked |
| `raise` | P4, P7 | yes, but see H2 (the raised event replaces the fact as `event`) |
| `meta`, `getMeta()` | `src/Snapshot.ts:423`; P8 returns `{ "T1_4/building": { unit, kind, state } }` | yes, keyed by the explicit id |
| `tags`, `hasTag` | P8 | yes, but `tags` is a `ReadonlyArray`, not a `Set` (L5) |
| `transition`, `getInitialSnapshot` as Effects | `dist/testing/getNextSnapshot.d.ts:54,223`; the engine already wraps them with `Effect.runSync(Effect.orDie(...))` (`engine-xstate/index.ts:639`) | yes |
| `createActor(logic, { snapshot })` | `src/Types.ts:3125-3130`; P9: an actor started from a folded snapshot takes later events | yes |
| `system.get`, `systemId` | `llms.txt:66`; P10: `None` before the spawn, `Some` while it runs, `None` after `stopChild` | yes |
| `spawnChild`, `stopChild` | P10 | yes. `SpawnOptions` has no `snapshot` member (`src/Types.ts:544-556`); see M3 |
| `invoke` with `onSnapshot` | `src/Types.ts:1914`; P11 | yes, but see M1 (it delivers snapshots, not typed events) |
| `fromEffect` (stop interrupts, the finalizer runs) | `src/actors/fromEffect.ts:229-258`; P11b | yes |
| `fromStream` | `src/actors/fromObservable.ts:407-431`; P11 | exists; see M1 |
| `getAdjacencyMap` from `./graph`, `events` as a function, `serializeState`, `limit`, `TraversalLimitError` | `dist/graph/index.d.ts`, `dist/graph/types.d.ts:168,199,211`, `src/graph/adjacency.ts:72-73`; P13 | yes, but `limit` counts dequeued edges (H3) |
| `actor.changes` stream (for `fromActor`) | `llms.txt:66`, `src/Actor.ts:300` | yes |

### The four spine claims marked "verified 2026-10-14" (all re-verified)

| Claim | Probe | Result |
| --- | --- | --- |
| The port splits `#id` on `.` (AD-1) | P1 | true: `#T1.4/x` errors, `#T1_4/x` resolves |
| A final state in a parallel region still takes events (AD-2) | P2 | true: `trusted` (final) → `proving` on `stale` |
| An `active.onDone` target in a sibling region re-enters `active` (AD-4) | P3 | true: `T1` is reset to `waiting`, `outcome` is `done`, and the status stays `active` |
| A targetless `onDone` that raises keeps unit finals and gives status `done` (AD-4) | P4 | true: `{ outcome: done, active: { T1: trusted } }`, status `done` |

### Opencode seams

| Seam | Evidence | Result |
| --- | --- | --- |
| `SessionStatus` events | `packages/opencode/src/session/status.ts:11,41-43`; `packages/schema/src/session-status-event.ts:9-49`. `Status` carries `{ type: idle \| retry(message) \| busy }` | exists. `Idle` is marked `// deprecated` (line 43); see L4 |
| Status events reach the harness's `EventV2` | `event-v2-bridge.ts:12-27`: the bridge publishes into `EventV2.Service`. `sessions.ts:23` types `env.events` as `EventV2.Interface` | yes |
| `MessageV2.Event.PartDelta`, `PartUpdated` | `session/message-v2.ts:70-75`; `schema/src/v1/session.ts:622-651` (`PartUpdated` carries the whole `part`, so a tool's `state.status` is readable). `task/core/sessions.ts:261-262` subscribes to both already | yes |
| `TextPart` and `TextPartInput` `metadata` | `schema/src/v1/session.ts:114` (`Record<String, Json>`), `:419` (`Record<String, MutableJson>`). `session/prompt.ts:1033` keeps the input part's fields by spread | yes. Only `Ops.PromptInput` (`task/core/ops.ts:12`) lacks it, which AD-13 says it adds |
| `Ops` interface | `task/core/ops.ts:17-24`: `prompt`, `cancel`, `currentModel` | yes. `say` is new (M5) |
| App runtime LayerNode list | `effect/app-runtime.ts:59-107`; `LayerNode.make({ service, layer, deps })` (`packages/core/src/effect/layer-node.ts:103-117`) | yes. No `TaskHarness` node exists yet (M4) |
| `insufficient_quota` retryability | `provider/error.ts:138-143`: a stream error with code `insufficient_quota` is `isRetryable: false` with the message "Quota exceeded. Check your plan and billing details." `SPEND_CAP` (`task/core/sessions.ts:199`) matches it through `billing` | yes for stream errors; see L3 for the HTTP path |
| Background job status `cancelled` | `task/core/runner.ts:825` reads `job.value.status !== "cancelled"` today | yes |
| 16 existing fact types | `task/core/events.ts:31-54` | yes |

---

## Findings

### Critical

#### C1 — The Recorder writes `status.json` from the snapshot before the fact (AD-9). The repetition stop reads a stale snapshot (AD-11).

- **Spine:** AD-9: "`record(fact)` holds the Recorder's single permit while it does three steps in order: it
  publishes the fact …, sends the fact to the run actor, and writes `status.json` from the run actor's
  snapshot." It also says "Supervisors and workers record facts only through the Recorder."
- **Reality:** a send completes after the macrostep only "from outside every actor's processing". A send "made
  from inside an actor's processing or callbacks … only queues the event" (`src/ActorRef.ts:149-155`,
  `src/Actor.ts:245-251`, and the `ProcessingActors` reference at `src/Actor.ts:603-608`). The worker's fiber
  inherits that context.
- **Evidence (P16):** a `fromEffect` worker calls `send(fact)`, then `getSnapshot`, on another root actor. It
  reads `n = 1` where the post-fact value is `2`. From outside any actor, the same code reads the post-fact
  value.
- **Consequence:** each `status.json` write lags one fact behind the facts the run actor has processed.
  Supervisor and worker paths, which AD-9 makes the only paths, are always inside actor processing. The run's
  last fact (the final outcome) is never written until another record arrives. The TUI can show a finished
  run as running for ever.
- **Same mechanism, AD-11:** `prompt.ts` "sends `hook.calls`, then ends the turn if the owner's snapshot carries
  the tag `repeated`". The prompt loop starts from the `builderTurn` worker through `ops.prompt`. The session
  runner forks it with `Effect.forkIn(scope)` (`effect/runner.ts:95`), so it probably inherits the processing
  context. The check would then see `repeated` one call late. This last point is inferred from Effect context
  inheritance and is not yet probed in opencode itself.
- **Fix:**
  1. Keep the permit only around "publish, then send". That alone keeps the store order and the actor order the
     same, because the mailbox is FIFO.
  2. Write `status.json` from a status-writer fiber that consumes `runActor.changes`. Fork it in the Recorder's
     scope when the Recorder is built, outside any actor. Each committed macrostep, including the final one,
     then produces a write.
  3. For AD-11, do not read the owner's snapshot right after the send. Choose one:
     - Wait with `waitFor(ownerRef, s => s.context.callsSeen >= n)` under a short timeout.
     - Compute the repetition verdict in the hook as a pure function and send it as data.
  4. Add a test in the shape of P16 for each path: a worker records, and the test asserts the file content
     after the record returns.
  5. Add a spine rule: "No code reads an actor's snapshot right after a `send` made from inside actor
     processing."

### High

#### H1 — The fold and the live actor diverge after the outcome is final (AD-5, AD-6)

- **Spine:** AD-5: "Each fact that changes the snapshot appends at least one entry … This invariant lets the live
  run actor (`send`) and the fold (`apply`) agree." AD-6: "`apply(plan, snapshot, fact)` … is pure."
- **Reality (P5, P14):** a pure `transition` on a `done` snapshot still runs the first microstep, as upstream
  `macrostep` does. `T1` moves `trusted` → `proving` and the status stays `done`. The live actor drops the
  same event with the warning `Event "stale" was sent to stopped actor … already reached its final state` and
  keeps `T1: trusted`.
- **When it happens:**
  - The job finalizer records `run.cancelled` after a run that is already `done`. AD-8 and AD-18 make the
    finalizer record on every job cancel.
  - A stale check that fires in the same instant as the last fact.
  - A resume of a slice whose outcome is final (AD-6).
  - An AD-15 trust read that folds a slice with facts after `done`.
- **Fix:**
  1. Make `apply` return its input unchanged when `snapshot.status !== "active"`. This matches the actor.
  2. Make the Recorder skip the send, or refuse the record, once the run actor is `done`. State whether a
     post-`done` fact is still stored.
  3. Add post-`done` facts to the "fold both ways" random test of AD-5.
  4. State the rule in AD-6.

#### H2 — `event.at` is `undefined` after a `raise`, so the outcome move has no time (AD-4, AD-5, AD-13)

- **Spine:** AD-5: "`at` is the `at` of the fact that triggered the macrostep, and eventless moves take the same
  `at`." The run's `endedAt` is "the `at` of the fact whose macrostep made the outcome final". The outcome is
  decided on `run.settled`, which `active.onDone` raises (AD-4).
- **Reality (P7):** the port, like XState, passes the raised event as `event` to the transitions it selects. It
  also passes it to the eventless rows that follow. The actions of the `run.settled` row and of the next
  `always` row both saw `run.settled` with `at: undefined`. The `xstate.done.state.*` event that `onDone`
  handles has no `at` either.
- **Consequence:** the outcome history entry and `run.endedAt` get no time, or the time of an earlier fact if
  code falls back. The AD-5 "fold both ways" test cannot catch it, because both paths agree on `undefined`.
- **Fix:**
  1. Make the first action of every fact transition `assign({ at: ({ event }) => event.at })`.
  2. Make every log, time and span action read `context.at`, never `event.at`.
  3. Raise `run.settled` with `at` from the context.
  4. Add a unit test: settle a run, then assert `run.endedAt === <last fact at>` and assert the `at` of the
     outcome's history entry.

#### H3 — The AD-7 graph walk budget is unmeasured, and `limit` bounds edges, not states

- **Spine:** "Each walk passes `limit: 100_000` …" and "Prevents: … a walk that cannot finish inside `bun test`".
  The assumption note reasons in keys: "exceeds 10^7 keys".
- **Reality, the limit:** `src/graph/adjacency.ts:72` increments `iterations` for each dequeued entry before the
  visited check. Duplicates count, so the limit bounds roughly the edges (states × events per state). P13: a
  machine with 16 states and 64 edges fails with `TraversalLimitError` at `limit: 20`. The doc comment "after
  more than `limit` states" is misleading. Upstream behaves the same way.
- **Reality, the cost (`bench.ts`, a synthetic machine in the AD-1 to AD-3 shape: N task regions, two
  always-final obligations each, `or`/`and` `stateIn` rows over three dependencies):**

  | Task regions | ms per pure `transition` |
  | --- | --- |
  | 10 | 2.3 |
  | 30 | 6.7 |
  | 60 | 15.0 |

  These figures include JIT warm-up and are an order-of-magnitude guide. Today's comment in
  `engine-xstate/index.ts:44` gives "about 250 µs per `apply`" for the per-unit design. At 3 ms, 100 000 edges
  take about 5 minutes. The package test command is `bun test --timeout 30000` (`packages/opencode/package.json:10`).
- **Fix:**
  1. Measure both walks on the real `machine(plan)` for the release-notes plan before you bind AD-7.
  2. State the edge count and the wall time in the spine.
  3. Size `limit` in edges, and give each graph test an explicit timeout above the measured time.
  4. If the stale walk is too slow, restrict its alphabet further. For example, add `obligation.stale` only to
     the first trusted unit in document order.
  5. Note that `getAdjacencyMap` keeps the full snapshot for each key, including `context.log` and `spans`.
     Memory grows with path length, so measure it too.

### Medium

#### M1 — `fromStream` delivers snapshots, not the typed events `turn.activity`, `turn.tool` and `turn.status` (AD-11)

- **Spine:** "The `sessionEvents` actor turns the session's part events and `SessionStatus` events into
  `turn.activity`, `turn.tool { running }` and `turn.status { type, message? }`." AD-8 lists the workers as
  "`fromEffect` or `fromStream` actors".
- **Reality (P11):** a `fromStream` element becomes `snapshot.context` (`Some(element)`, SD-17,
  `src/actors/fromObservable.ts:407-416`). The parent receives `xstate.snapshot.<invokeId>` events through
  `onSnapshot`. It first receives one snapshot with no element. No event of type `turn.activity` ever arrives.
- **Fix:** choose one mechanism and name it in AD-11:
  - Use `onSnapshot` with guards over the unwrapped element, and ignore the initial empty snapshot.
  - Use `fromCallback`, whose `sendBack` relays typed events to the parent (`src/actors/fromCallback.ts:220,
    231-236`), and run the Effect stream inside it.

#### M2 — The stall timer re-arms only with `reenter: true` (AD-11)

- **Spine:** "A stall is an `after: streamIdle` transition, re-entered on each activity."
- **Reality (P12):** activity arrives at 40 ms and the idle limit is 60 ms. With a plain self-transition
  (`reenter` unset, the v5 default), the state is `stalled` at 80 ms. With `reenter: true`, it is still
  `watching`.
- **Consequence:** without the flag, a builder that streams steadily is cut as stalled.
- **Fix:** write "`turn.activity` is a self-transition with `reenter: true`" in AD-11. Add a test that uses
  `SimulatedClock` (exported, `dist/index.d.ts`).

#### M3 — The run actor cannot be a spawned child that starts from the fold (AD-8)

- **Spine:** AD-8 says "The run actor … is created from the fold of the run's stored facts". The topology
  diagram draws it as a child of the run supervisor.
- **Reality:** `spawnChild` and `spawn` take only `id`, `input`, `systemId` and `syncSnapshot`
  (`src/Types.ts:544-556`), as in upstream. Only `createActor(logic, { snapshot })` starts from a given snapshot
  (P9), and that actor is a root with its own system.
- **Fix:** state that the Recorder creates the run actor with `createActor(machine(plan), { snapshot: fold })` in
  the Recorder's scope. That scope already outlives the supervisor (AD-18). The supervisor holds only a
  reference to it. Redraw the diagram, and keep `system.get` ids for the supervisors only.

#### M4 — 0.2.0 makes `createActor` require the services of a machine's actions and actors. The `TaskHarness` layer must not depend on `SessionPrompt`.

- **Reality:** the 0.2.0 changelog (GitHub, `packages/core/CHANGELOG.md`, minor b58adfd) says "`createActor` of a
  `setup` machine now requires the services that its actions' Effects and its actors need". The bump commit
  `2c0214ab71` says the engine was not affected "because it creates no actors". The new design creates many.
- **Seam:** the harness root and its workers need `Session`, `SessionStatus`, `InstanceStore`, `EventV2`,
  `BackgroundJob` and `Database` (today's `Env`, `task/core/sessions.ts:19-27`). `SessionPrompt.node`
  (`session/prompt.ts:1782-1813`) must depend on the new `TaskHarness.node`, because the hooks route through
  it.
- **Fix:**
  1. Name the `TaskHarness.node` deps in AD-8.
  2. Forbid `SessionPrompt.node` in them, to avoid a layer cycle. `Ops` stays an argument for each run, as the
     spine already says.
  3. Name how the AI SDK tool `execute` callbacks in `createTaskHarnessTools` (`session/prompt.ts:1710-1758`)
     reach the harness. They are synchronous, non-Effect functions today, but `system.get` and `send` are
     Effects. Make `execute` async and run the Effect with the captured context.

#### M5 — `Ops.say` must build a full assistant message. No opencode API does this today (AD-18).

- **Reality:** `SessionV1.Assistant` (`packages/schema/src/v1/session.ts:463-495`) requires these fields:
  `parentID`, `modelID`, `providerID`, `mode`, `agent`, `path`, `cost`, `tokens`, `time.created`. Every current
  harness message is a user-role `noReply` prompt (`task/core/command.ts:123-130`).
- **Fix:** specify the fields in AD-18:
  - `parentID`: the `/task` user message.
  - `modelID` and `providerID`: the session's current model.
  - `cost` and `tokens`: zero.
  - `time.completed`: set.
  - `finish: "stop"`: set, so the prompt loop does not treat the message as unfinished.

  Check that the root session's next prompt still runs. If the user-role `noReply` form is acceptable, it
  needs no new message builder.

#### M6 — The port is pre-1.0 and was published on the day the spine binds to it

- **Reality:**
  - 0.2.0 was published 2026-10-14 06:25 UTC (`npm view @jambudipa/xstate-effect time`).
  - It is exempt from the repository's 3-day `minimumReleaseAge` (`bunfig.toml`, commit `3b922817a1`).
  - It was built and tested against `effect` 4.0.0 and TypeScript ~6.0.3 (its `devDependencies`), and it runs
    here on 4.0.3 under tsgo.
  - `llms.txt:83` says "A minor version may change the API".
- **Fix:** keep the exact pin (it is exact today). Record in the Stack section that the spine's semantics
  were probed on 0.2.0. Turn P1–P16 into a small conformance test under `packages/opencode/test/task/`, so
  that a port upgrade fails in CI and not in a run.

### Low

#### L1 — The Stack table omits the real type checker and the spinner

- `typecheck` is `tsgo --noEmit` (`packages/opencode/package.json:9`, `packages/tui/package.json:10`). The
  checker is `@typescript/native-preview` 7.0.0-dev.20251207.1 (catalog line 83), not `typescript` 5.9.3.
- AD-16 relies on `opentui-spinner` 0.0.7 (catalog line 63). Its peer range is `@opentui/* ^0.3.4`, which
  excludes the installed 0.4.5. It works in the repo today (`packages/tui/src/component/register-spinner.ts:2`).
- **Fix:** add both rows.

#### L2 — Newer releases exist, and the spine does not say that the pins are deliberate

- effect and @effect/platform-node 4.0.4 (2026-10-13), solid-js 1.9.17, @opentui 0.6.4, TypeScript 7.0.2 and
  Bun 1.4.3 are on the registry. No decision needs them.
- **Fix:** add one line: "Versions are the repository catalog pins, checked against npm on 2026-10-14. No
  upgrade is in scope."

#### L3 — "`insufficient_quota` arrives only in the second place" is true only for stream errors (AD-11)

- `classifyStreamError` makes it non-retryable (`provider/error.ts:138-143`). An HTTP `APICallError` 429 instead
  takes `isRetryable` from the AI SDK (`provider/error.ts:239`). Opencode then retries it (`session/retry.ts:33,
  98-109`), so it arrives as a `retry` status first.
- AD-11 already matches both places, so behaviour is correct. Only the sentence is wrong.
- **Fix:** reword the sentence. Keep a test for each path. The stream path's text is "Quota exceeded. Check
  your plan and billing details." and depends on `SPEND_CAP` matching `billing`.

#### L4 — Use `SessionStatus.Event.Status` with `type: "idle"`, not `Event.Idle`

- `Idle` is marked `// deprecated` (`packages/schema/src/session-status-event.ts:43`). The spine's "Idle is the
  status `idle`" is already correct.
- **Fix:** say "subscribe to `Event.Status` only" in AD-11.

#### L5 — `snapshot.tags` is an array

- P8 shows `Array.isArray(tags)` is true. Upstream uses a `Set`. Code written from XState docs (`tags.has`)
  would fail.
- **Fix:** make the selectors use `hasTag`, or array operations.

#### L6 — An unresolved `stateIn` id fails silently as an `error` snapshot

- P1: a guard on a missing id makes `getInitialSnapshot` succeed with status `error`. The Effect does not fail.
- **Fix:** make `machine(plan)` or `initial(plan)` assert that the status is `active`. Treat any other status
  as a defect, which matches the spine's convention "a machine-definition error is a defect". Add the
  release-notes plan to that test.

#### L7 — The plans that AD-7 needs do not exist yet, and `metadata` must be JSON

- `example-scenarios.spec`, `example-cascade.spec` and `example-outside-run.spec` are not in the repo. D14 in
  `decisions.md:234-253` creates them. AD-7's main walk depends on them.
- `TextPart.metadata` is `Record<string, Json>`, so omit `task` when it is absent rather than set it to
  `undefined`.
- **Fix:** state the D14 dependency in AD-7. Add "omit absent keys" to AD-13.

---

## Appendix — probe output (bun 1.3.14, port 0.2.0, effect 4.0.3)

Scripts: `/private/tmp/claude-501/rc-review/probe.ts`, `probe2.ts`, `probe3.ts`, `bench.ts` (outside the repo).

```text
P1 dotted id init exit: {"value":{"a":"x","b":"w"},"status":"error","error":"Error: Child state node '#T1' does not exist on machine 'p1'"}
P1 underscore id: {"a":"x","b":"ok"}
P2 after go: {"active":{"T1":"trusted","T2":"waiting"},"outcome":"running"}
P2 after stale (final left?): {"active":{"T1":"proving","T2":"waiting"},"outcome":"running"}
P3 targeted onDone value/status: {"value":{"active":{"T1":"waiting"},"outcome":"done"},"status":"active"}
P4 targetless onDone value/status: {"value":{"outcome":"done","active":{"T1":"trusted"}},"status":"done"}
P5 pure transition on done snapshot: {"value":{"outcome":"done","active":{"T1":"proving"}},"status":"done"}
P6 and([]) -> a, or([]) -> b: {"a":"y","b":"w"}
P7 events seen by actions after raise: ["settled-action:run.settled:undefined","always-action:run.settled:undefined"]
P8 getMeta: {"T1_4/building":{"unit":"T1.4","kind":"task","state":"building"}}
P8 tags (type, value): {"isArray":true,"isSet":false,"value":["T1.4:active","T1.5:waits:T1.4"]}
P8 hasTag: true
P9 actor from snapshot: start value, after stale: {"start":{"active":{"T1":"trusted","T2":"waiting"},"outcome":"running"},"after":{"active":{"T1":"proving","T2":"waiting"},"outcome":"running"},"status":"active"}
P10 system.get before/during/after: {"before":false,"during":true,"after":false}
P11 fromStream onSnapshot payloads: [{"type":"xstate.snapshot.0.p11.on"},{"type":"xstate.snapshot.0.p11.on","ctx":{"type":"turn.activity"}},{"type":"xstate.snapshot.0.p11.on","ctx":{"type":"turn.tool","running":true}},{"type":"xstate.snapshot.0.p11.on","ctx":{"type":"turn.status","status":"idle"}}]
P11b fromEffect stop on state exit: ["finalizer ran"]
P12 reenter=false: value at 80ms (activity at 40ms, idle 60ms): "stalled"
P12 reenter=true: value at 80ms (activity at 40ms, idle 60ms): "watching"
P13 states with limit 100: 16
P13 limit 20 (> 16 states, < 64 edges): "TraversalLimitError"
WARN Event "stale" was sent to stopped actor … This actor has already reached its final state, and will not transition.
P14 live actor: done, then stale: {"before":{"outcome":"done","active":{"T1":"trusted"}},"beforeStatus":"done","sendExit":"Success","after":{"outcome":"done","active":{"T1":"trusted"}},"afterStatus":"done"}
P14 pure fold of the same facts: {"value":{"outcome":"done","active":{"T1":"proving"}},"status":"done"}
P15 cascade after one fact: {"value":{"T1":"blocked","T1_5":"blocked","T1_4":"budget_exhausted"},"status":"done"}
P16 record from outside: n after send: 1
P16 record from a fromEffect worker: n read right after send (expect 2): [1]
P16 run actor n later: 2
bench {"regions":10,"transitions":40,"msPerTransition":2.326,"status":"done"}
bench {"regions":30,"transitions":120,"msPerTransition":6.685,"status":"done"}
bench {"regions":60,"transitions":240,"msPerTransition":14.997,"status":"done"}
```

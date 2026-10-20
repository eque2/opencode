---
review: statechart correctness
target: ../ARCHITECTURE-SPINE.md (AD-1 to AD-7, AD-13), against ../../decisions.md D1-D5
port: '@jambudipa/xstate-effect 0.2.0 (src/stateUtils.ts, src/StateMachine.ts, src/graph/adjacency.ts, src/guards/stateIn.ts)'
date: '2026-10-14'
reviewer: ad-hoc statechart reviewer
---

# Statechart review of the architecture spine

## Verdict

The paradigm is sound. One generated parallel machine, `stateIn` cascade rows, a targetless `active.onDone` that
raises `run.settled`, and a canonical-interleaving walk all work on the port's real algorithm. A model of the
release-notes plan, built from the spine's rules, walks to **0 stuck states**. Its negative control finds the
observed stuck state.

Several rules, as written, either cannot be implemented or make the fold and the live actor disagree:

- The fold takes facts after the run is done.
- History order inside a microstep is activation order, not document order, and a restored actor uses a third
  order.
- An entry action cannot see which dependency died.
- `run.settled` carries no `at`.
- A literal reading of AD-3 row 2 hangs, because the port's `maxIterations` defaults to `Infinity`.
- The AD-7 walk as specified takes about 3 minutes, and `limit` counts edges, not keys.

Each has a small, concrete fix (below). With those fixes, I see no structural blocker for D1-D5.

## Method

I read the port's microstep, macrostep, selection, conflict, completion and graph code. I then ran 11 probes with
`bun` against the port's `dist`, with the worktree's `effect@4.0.3`. The probes live outside the repository, in the
session scratchpad (`p1-done.mjs` … `p11-two.mjs`, `rn-model.mjs`, `rn-walk*.mjs`).

`rn-model.mjs` generates the AD-1 to AD-4 machine for `task-formats/blend/release-notes.spec`, with these parts:

- 6 tasks and 27 obligations (each task's `ensures`), 13 scenarios, and the outside regions T8 and T9.
- `taskAttempts: 3`.
- AD-3 rows, AD-4 outcome rows and an AD-7 alphabet.

It is a model, not the generator, so treat its timings as indicative only.

Port line numbers refer to
`node_modules/.bun/@jambudipa+xstate-effect@0.2.0+b10868da9591cb2f/node_modules/@jambudipa/xstate-effect/src/`.

## What holds (checked, no change needed)

- **Completion is computed against the in-progress configuration.** `completionOfFinal` runs as each final node is
  entered, against `stateNodes` = start nodes minus exited plus entered-so-far (`stateUtils.ts:1417-1450`,
  `:1540-1557`). Take a microstep in which one region moves final to final and another leaves final, or moves
  non-final to final. That microstep raises `xstate.done.state.<active>` at most once, and only when every region
  ends final. `completedNodes` (`:1439`) stops a double completion within one microstep. `trusted → proving` on
  `obligation.stale`, with the obligation `trusted → stale` in the same microstep, raises no task-region done event.
- **A final state takes events.** Probe p1 confirms the AD-2 note: `trusted` reopens on its own row.
- **`active.onDone` fires once in a live run.** p1: after `run.settled` the outcome is final, and the root (parallel)
  is complete, so the machine is `done`. The actor then drops every event (`Actor.ts:1148`, warning "sent to stopped
  actor").
- **The targetless `onDone` plus `raise` path works.** p1: `doneEvent = xstate.done.state.run.active`,
  `settledEvent = run.settled`, outcome `done`. The AD-4 warning about an `onDone` target is right: a multi-target
  transition whose domain is `active` re-enters every region (see H6).
- **There are no cross-region conflicts.** A row whose source and target lie in one unit region has that region's
  compound as its domain (`getTransitionDomain`, `:1168-1185`). The exit sets of two regions are disjoint, so
  `removeConflictingTransitions` (`:1223-1258`) keeps both.
- **The readiness rows cannot oscillate within a macrostep.** A dependency enters `trusted` only through the
  eventless `judging` row, and leaves it only through a fact. Inside one macrostep the AD-3 guards are therefore
  monotone. `running`/`waiting` use complementary guards over unit states that they do not feed back into.
- **AD-1 ids, meta and tags behave as specified (p7).**
  - `#T1_1/trusted` resolves. `toStatePath` splits on `.` (`stateUtils.ts:959`), so `/` is safe.
  - `stateIn("#…")` is `_nodes.includes(node)` (`guards/stateIn.ts:28-37`).
  - `getMeta()` keys are the explicit ids (`T1_1/trusted, T1_2/trusted`).
  - Tags with dots work: `hasTag("T1.1:ended") === true`.
- **AD-7 soundness of the main walk.** "First unit in document order that has a fact" is a persistent set while
  `obligation.stale`, `run.cancelled` and `run.ended` stay out of the alphabet. Facts of other units cannot disable
  that unit's facts:
  - A `ready` or started unit's dependencies are trusted.
  - A trusted unit leaves `trusted` only through `obligation.stale`.
  - A trusted unit therefore cannot die.

  Persistent sets keep every reachable deadlock. The spine's sentence "a fact moves only its own unit" is loose: a
  task fact also moves its obligations, and the scenario batch moves several scenarios. The conclusion still holds
  (L8).
- **The negative control works.** With the AD-3 `blocked` rows removed, the model walk finds 33 stuck task
  configurations, including
  `T1=waiting T1.1=trusted T1.2=trusted T1.3=trusted T1.4=budget_exhausted T1.5=waiting` (3.6 s).

---

## Critical

### C1 — The fold applies facts to a `done` snapshot; the live actor ignores them (AD-6, AD-2, AD-15)

**Finding.** The port's `machine.transition` does not read the snapshot's status (`StateMachine.ts:1604-1615`).
`runMacrostep` still takes the first microstep for a non-active snapshot (`stateUtils.ts:2978`). Only the loop that
follows needs `status === "active"` (`:3000`). The microstep then runs with `startsDone`, so every exit action runs
again (`:1559-1562`). The actor drops the same event (`Actor.ts:1148`).

**Evidence (p1).**

```
a.done          {"status":"done","value":{"outcome":"done","active":{"O":"passed","A":"trusted"}}, log: 2 entries}
FOLD a.stale on done snapshot: {"status":"done", ... "A":"work"}, log: 3 entries (trusted->work @3)
ACTOR a.stale after done:      {"status":"done", ... "A":"trusted"}, log: 2 entries
```

**Why it matters.** Facts can reach the store after the outcome is final. The realistic case is a `staleCheck` tick
that lands between the final snapshot and the moment the run supervisor stops. The obligation rows and the
`trusted` row still take `obligation.stale` in a done snapshot. Most other late facts (`task.stalled`,
`run.cancelled`, a duplicate `outside.trusted`) find no row on a final state, so they stay no-ops. The live snapshot
ignores the stale fact, but every later fold applies it. A trusted task then reads as `proving`, with extra history
entries and a status that is still `done`. AD-15 reads trust by folding stored slices, so the command then refuses a
subtree run that the live run showed as trusted. Today's
engine guards this (`engine-xstate/index.ts`, `apply`: `if (status === "done") return state`). The spine's AD-6
does not carry the guard forward.

**Fix.** In AD-6, state: "`apply` returns its input unchanged when `snapshot.status !== "active"`." Add a
random-fold test case that appends facts after the outcome is final. In AD-7, pass
`stopWhen: (s) => s.status !== "active"` (supported, `graph/adjacency.ts:91`), or return `[]` from `events` for a
done snapshot. p5 shows that without it the walk keeps expanding: `{"b":"f","a":"w"}done`.

---

## High

### H1 — History order within a microstep is activation order; a restored actor gives a different order (AD-5, AD-6, AD-8)

**Finding.** Eventless selection reads the configuration in `_nodes` order (`stateUtils.ts:2699`). New nodes are
appended at the end (`planMicrostep`, `:1535`), so this is the order in which nodes were last entered, not document
order. Transition actions run in that selection order. Entry actions run in document order (`byDocumentOrder`,
`:1528`).

`restoreSnapshot`, which `createActor(m, { snapshot })` uses, rebuilds `_nodes` from the value in document order
(`StateMachine.ts:1798-1811`). The same facts therefore log in one order in the fold and in another order in an
actor that AD-8 created "from the fold".

**Evidence (p3).** Regions A and B are in document order. A bounces out of and back into `waiting`, then one event
makes both ready in one eventless microstep:

```
_nodes atomic order before go: B/waiting, run.F.off, A/waiting
FOLD   transition-action order:   B:waiting->ready | A:waiting->ready
FOLD   entry-action order:        A:ready | B:ready
ACTOR(restored) transition order: A:waiting->ready | B:waiting->ready
```

AD-3 logs `blocked` in an entry action. If other moves log in transition actions, one microstep that contains both
kinds puts every transition-action entry before every entry-action entry, whatever the document order.

**Why it matters.**

- AD-5's "the order of regions is document order" is false.
- AD-5's fold-versus-send test, as described (both from the start), never takes the restore path, so it passes
  while a resumed run's `status.json` history differs from a later re-fold of the same facts.
- `snapshot.tags` order (`getConfigurationTags`, configuration order) differs in the same way.

**Fix (pick one, and state it in AD-5).**

1. Append every history entry in the **entry action** of the target state, which runs in document order. Each row
   carries static params `{ unit, from, to }`. Its transition action stores `{ from, reason }` in a per-unit slot,
   and the target's entry action appends the entry from that slot. A targetless row (`task.repeated`,
   `task.stalled`, `task.nudged`) appends in its transition action, because it is the only move of its macrostep.
2. Or create the run actor by **replaying** the slice into a fresh `createActor(machine)`, never through
   `{ snapshot }`. Then relax AD-5 to "selection order".

Either way, extend the AD-5 test: fold a prefix, restore an actor from it, send the suffix, and compare with the
full fold. Have the projection emit `tags` in a fixed order, sorted or by plan.

### H2 — The `blocked` entry action cannot find "the first dead dependency" (AD-3)

**Finding.** An action receives context, event and params, not the configuration. Probe p8 reads
`self.getSnapshot()` from the `blocked` entry action. In the pure `transition` the scope's `self` is inert. In the
actor, `getSnapshot` is an Effect property, not a function. Even read as an Effect, it can only give the last
committed snapshot (before this macrostep), in which the dependency is not yet dead.

```
FOLD : entry action saw throws: TypeError: self.getSnapshot is not a function
ACTOR: entry action saw throws: TypeError: ... 'self.getSnapshot' is an instance of Object
```

The rule "The entry action of `blocked` sets `blockedBy = { id, state }` … `id` is the first dead dependency" needs
the dependency's state, which only a guard (`stateIn`) can read.

**Fix.** Generate one `blocked` row for each (dependency, dead state) pair, in dependency order, then by dead
state: `{ guard: stateIn("#T1_4/budget_exhausted"), target: "blocked", actions: { type: "block", params: { id: "T1.4",
state: "budget_exhausted" } } }`. The first enabled row is the first dead dependency. Its params give `blockedBy`
and the reason text. T1 has 5 dependencies × 4 dead states = 20 rows, which is cheap. Apply the same rule to the
AD-4 reason texts (M3).

### H3 — AD-3 row 2, read literally, adds `ready → ready` and `parked → parked`; with a logging action this hangs (AD-3)

**Finding.** AD-3 lists rows "for each state that has not started" (`waiting`, `ready`, `parked`) and row 2 is "to
`ready` or `parked`". On `ready`, row 2 targets the state itself. The guard stays true, and the row's `assign`
makes a new snapshot each time. The loop's no-change stop (`stepped !== previous`, `stateUtils.ts:3030`) therefore
never fires. The port's `maxIterations` defaults to `Infinity` (`StateMachine.ts:1510`, `stateUtils.ts:2997`).

**Evidence (p2).**

```
maxIterations = 500       -> FAILED: Infinite loop detected: ... more than 500 microsteps ...
maxIterations = (default) -> machine.options.maxIterations = Infinity; still running after 6 s: HANG
```

The graph `limit` cannot help, because the hang is inside one `transition`. AD-7's "it never hangs" is therefore
not guaranteed.

**Fix.**

- State the rows for each source exactly:
  - `waiting`: [blocked, ready (or ready/parked)].
  - `ready`: [blocked, waiting].
  - `parked`: [blocked, ready, waiting].
- Never generate a row whose target equals its source.
- Set `options: { maxIterations: 1_000 }` (or similar) in the generated config, so that any future oscillation
  fails as a `TransitionError` and does not hang the fold, the actor or the test.

### H4 — `run.settled` (and anything after an internal event) carries no `at` (AD-4, AD-5)

**Finding.** After the macrostep handles an internal event, `nextEvent` is that event (`stateUtils.ts:3020`). Every
later eventless guard and action sees it. `run.settled` and the `xstate.done.state.*` events have no `at`.

**Evidence (p1).** The `run.settled` row's action reads `event.at`:

```
"settledEvent":"run.settled","settledAt":"NO-AT"
```

**Why it matters.** AD-5's run `endedAt` ("the `at` of the fact whose macrostep made the outcome final") and any
outcome history entry cannot read `event.at`. Unit eventless moves do see the fact, because eventless rows run to
quiescence before the internal queue (`:3006-3021`) and unit guards never read the outcome. That ordering is
incidental, not stated.

**Fix.** In AD-5, state that every action takes `at` through one helper,
`event.at ?? context.log.at(-1).at`. The outcome's `run.settled` rows always use `context.log.at(-1).at`, because
the macrostep that completes `active` always appended a unit entry first. Do **not** add a "current `at`" context
field written on every fact, because it breaks the no-change test (M4).

### H5 — `apply` with a machine rebuilt from the same plan drops every fact silently (AD-6, AD-1)

**Finding.** A snapshot's `_nodes` are node objects of the machine that made it. `transition(B, snapshotOfA, e)`
computes the selection value from A's nodes against B's root. `getValueFromAdj` (`stateUtils.ts:580-612`) finds no
entry for B's root, gives `{}`, and selects nothing.

**Evidence (p11).** Two machines are built from the same plan, and facts alternate between them:

```
same machine : T1.1 trusted  T1.3 ready
mixed machine: T1.1 building T1.3 waiting      values equal: false
build ms: 17.9
```

The signature `apply(plan, snapshot, fact)` invites `machine(plan)` on each call. With "returns its input when no
entry was added", every fact is then a silent no-op. Each build also costs about 18 ms.

**Fix.** In AD-6, state:

- `machine(plan)` is memoised by plan identity (`WeakMap<Plan, Machine>`).
- `apply` uses that instance and dies (a defect) when `snapshot.machine !== machine(plan)`.
- The AD-15 cross-slice reads use the same memoised full-spec machine.

### H6 — The cancel mechanism is unspecified; a multi-target cancel resets final units (AD-4)

**Finding.** "`run.cancelled` and `run.ended` move each non-final unit state to `cancelled`" can be generated as one
transition on `active` with every non-final unit's `#…/cancelled` as a target. That transition's domain is `active`
(the least common ancestor), so every region is exited and re-entered. A region with no target is entered by
default, which resets trusted tasks and obligations.

**Evidence (p7).**

```
before multi-target cancel: {"active":{"U1":"t","U2":"b"}}
after  multi-target cancel: {"active":{"U1":"b","U2":"cancelled"}} status active
```

**Fix.** In AD-4, state the mechanism. Each non-final unit state (task `waiting`, `ready`, `building`, `proving`,
`verifying`; scenario `waiting`, `ready`, `verifying`) gets its own `on: { "run.cancelled": "cancelled",
"run.ended": "cancelled" }` row, so the domain is the unit's region. Final states get no row, and no ancestor
(region, `active`, root) handles these events, because a final state would otherwise inherit the ancestor's row
through `orOwn`. The live outcome state takes the same event in the same microstep, with a targetless row that
notes the stop.

### H7 — AD-7 as written does not finish inside `bun test`, and `limit` counts edges (AD-7)

**Finding 1, the limit.** `getAdjacencyMap` increments its counter on every dequeue, before the duplicate-key check
(`graph/adjacency.ts:72` then `:81`). `limit` therefore bounds explored edges + 1, not keys.

p5: 10 keys and about 200 edges fail at `limit: 150` and pass at `limit: 250`.

**Finding 2, the cost.** On the release-notes model, with `serializeState` = value + attempts (as AD-7 specifies)
and the canonical alphabet:

| Variant | Keys | Edges | Stuck | Time |
| --- | --- | --- | --- | --- |
| AD-7 as written (value + attempts, with `task.stalled`/`task.nudged`) | 24,103 | 32,622 | 0 | 176 s |
| without the two key-neutral facts | 24,103 | 29,640 | 0 | 173 s |
| ended tasks keyed by state only (no attempts, no obligation states) | 336 | 864–1,018 | 0 | 7.8 s |
| negative control (collapsed key) | 396 | 924 | 33 | 3.6 s |
| full interleaving (collapsed key, `limit: 60_000`) | — | — | — | not finished after about 25 min; stopped |

The last row supports AD-7's [ASSUMPTION] that the full interleaving of release-notes is out of reach, and so it
supports the canonical reduction.

The cost is about 5 ms per edge. One `task.proved` that moves 5 obligations takes 7 microsteps and 9.3 ms. A
no-op fact takes 1.4 ms. The initial snapshot takes 62 ms (`rn-cost.mjs`; see M5). Bun's default per-test timeout
is 5 s.

**Fix.**

- Say "100_000 queue entries (edges)", not keys, and calibrate the limit to about 3× the measured edge count.
- Key an ended task (any final work state) by its state alone. Its attempts and obligation states cannot affect any
  later move in the main walk, so this is sound there. It is **not** sound in the stale walk (M6).
- Leave out of the walk alphabet the facts that never change a key (`task.stalled`, `task.nudged`). Keep them in
  the supervisor-alphabet test.
- Give each walk an explicit test timeout (for example 60 s).

---

## Medium

### M1 — A queued done event fires even after a region has left final (AD-2, AD-4)

**Finding.** The port queues `xstate.done.state.<active>` when the last region enters final (`applyCompletion`,
`stateUtils.ts:2802`).
Eventless microsteps run before the queue is read (`stateUtils.ts:3006-3021`), and the done event is not
re-checked. `parked` is final with eventless exits, so a parked exit that becomes enabled in the completing
macrostep still settles the run.

**Evidence (p10).**

```
after go: {"active":{"P":"ready","Q":"b"},"outcome":"done"} status active
```

The outcome is `done` while P is live, and the machine never completes.

**Reachability today.** I found no path in the spine's machine. A `parked` exit needs `outside.trusted` (final to
final) or a task that leaves `trusted` (to non-final). Neither can complete `active` in the same macrostep, because
when every other region is final the run has already ended. The design is one row away from this, though: any new
eventless exit from a final state reintroduces it.

**Fix.** Guard each AD-4 `run.settled` row with the generated "every unit region final" `stateIn` conjunction. Add
a terminal row with no target that ignores a stale `run.settled`. Alternatively, state as an AD-2 invariant that no
eventless row of a final state can become enabled by a fact that completes `active`, and test it.

### M2 — The "waiting" guard over "every unit tagged `active`" includes obligations (AD-4, AD-13)

**Finding.** AD-13 tags obligation `passed`, `failed` and `rejected` as `active`, and AD-1 makes obligations units.
A dead task keeps an obligation in `failed` or `rejected` for ever. A run with a dead task and an unrelated task
that waits on an `outside` precondition therefore stays `running`, never `waiting`, which contradicts D4's explicit
waiting report.

Release-notes happens to hide this, because every death there blocks T1.5. My model's negative control shows the
run `waiting` only because it counts task and scenario states alone.

**Fix.** Define the guard over task work states (`ready`, `building`, `proving`, `verifying`) and scenario states
(`ready`, `verifying`) only. Consider whether an obligation under a dead or blocked task should carry `active` at
all (AD-13).

### M3 — The outcome reasons need data that actions cannot read (AD-4)

**Finding.** The AD-4 reasons list each dead task, each blocked task with its cause, failed scenarios and parked
scenarios with their untrusted outsides. Guards can read these with `stateIn`, but the `run.settled` actions that
write the reason cannot (H2).

**Fix.** State that the outcome reason is computed from `context.log`: the last entry for each unit, with
`blockedBy` from the `blocked` entry. Static plan data gives the outside ids. The "earliest dead entry" rule
already reads the log.

### M4 — "A fact that appends no entry changes nothing" is fragile; use identity (AD-5, AD-6)

**Finding.** The invariant holds only if every context write also appends an entry. Every context write in
AD-10 is paired with an entry, provided that the targetless rows log:

- `task.repeated` (+1 attempt)
- `task.stalled` and `task.nudged`
- `spec.checked`
- the stop note on `run.cancelled`

Today's engine logs `building → building` for these. The spine does not say so. If one targetless row writes
context without an entry (for example the attempt counter), `apply` drops it while the actor keeps it. The fold
then never exhausts the budget, and every resume resets the attempts.

The port returns the **identical** snapshot object when nothing is selected. p9: `unknown event → identical: true`,
`unhandled fact → true`, `second outside.trusted → true`.

**Fix.**

- Define `apply`'s no-change test as `next === prev`, not "no entry added".
- Keep the entry invariant as a separate test: the log grows if and only if the value or a non-log context field
  changed.
- State in AD-5 that targetless rows which write context also append an entry.

### M5 — Every obligation's done event costs a full microstep and an eventless pass (AD-2)

**Finding.** Each obligation state is final. Every obligation move therefore raises
`xstate.done.state.<obligation region>`, then `…evidence`, and `…<task>` when the work state is final. Each event
is one microstep, followed by a full eventless re-selection, because `shouldSelectEventlessTransitions` resets
after an internal event (`stateUtils.ts:3030`).

**Evidence (`rn-cost.mjs`).**

- `task.proved` for T1.1 (5 obligations): 7 microsteps, 9.3 ms.
- A no-op fact: 1.4 ms.
- `initial(plan)`: 62 ms (27 obligation regions enter final).

Today's engine notes about 250 µs per `apply`. This does not affect correctness. It is about 40× more fold time,
and it dominates the graph walk (H7).

**Fix.** Accept the cost, but put the numbers in AD-6. Size AD-7 with the collapsed key. If the fold of a long
slice exceeds a model turn, the Deferred snapshot cache applies. Do not handle `xstate.done.state.*` anywhere other
than `active.onDone`.

### M6 — The stale walk's alphabet multiplies keys with no stuck-state value (AD-7)

**Finding.** "`obligation.stale` for each obligation in `passed` or `trusted`" includes the obligations of dead
tasks. Those moves change only the obligation's own state (no task row takes them), so each dead task contributes
up to 2^k keys under full interleaving. The ended-task key collapse from H7 is unsound here, because a trusted
task's obligations can reopen it.

**Fix.** In the stale walk, offer `obligation.stale` only for obligations of tasks in `trusted` (the only ones that
move another unit) and of tasks still in progress. Key the obligations of dead and blocked tasks as `-`.

### M7 — The alphabet misses facts the supervisors record in `ready` (AD-7 against AD-8, AD-10)

**Finding.** AD-8 records `task.failed` (`harness error`) after 3 worker failures. For a leaf in `ready`, the failing
worker is `begin`. AD-7 gives a `ready` unit only its start fact, and its supervisor test forbids any other fact
type in that state. Likewise, the `scenarioProof` batch failure records `scenario.proved` failed for `ready`
scenarios. That one is covered by "any payload", but it needs a machine row from `ready` to `failed`.

**Fix.** Either add `task.failed` to the `ready` alphabet, with a `ready → failed` row, or make `begin` failures
retry inside `ready` with no fact. State which in AD-7 and AD-8.

---

## Low

- **L1 — Duplicate explicit ids are accepted silently (AD-1).** `idMap` is `HashMap.fromIterable`
  (`StateMachine.ts:1485`), so the last id wins. p7: `T1.4` and `T1_4` both generate `T1_4/w`, and the machine
  builds. The `.` → `_` rule is not injective, and an `outside` id could equal an AD-15 external region id.
  **Fix:** the generator asserts that every explicit id is unique and dies otherwise.
- **L2 — `JSON.stringify(snapshot.value)` is not a canonical key (AD-7).** The value's key order follows `_nodes`.
  When the machine completes, `_nodes` is sorted into reverse document order (`stateUtils.ts:1560`). p1:
  `{"outcome":"done","active":{"O":"passed","A":"trusted"}}`. **Fix:** build `serializeState` from the plan's unit
  list in plan order, reading each unit's state from the active nodes, plus attempts.
- **L3 — Never key the walk on `meta.state` (AD-1, AD-13).** `meta.state` is the status name, so `ready` and
  `waiting` (task), and `parked` and `waiting` (scenario), share a value. A key built from it merges a state that
  has start facts with one that has none, which is unsound. Use the machine state keys.
- **L4 — An `error` snapshot reads as "stuck".** My first negative control removed the `blocked` states that guards
  name. `getInitialSnapshot` then returned `status: "error"`, which the walk counted as one stuck state.
  **Fix:** the walk asserts `status ∈ {active, done}` for every visited snapshot. Keep AD-7's requirement that the
  negative control gives the *specific* observed state.
- **L5 — The AD-7 plan list names folders that do not exist yet.** `example-scenarios.spec`,
  `example-cascade.spec` and `example-outside-run.spec` are not in the repository (D14 and D15 are phase 3). The
  phase-1 graph test can walk only release-notes, plus a hand-built cascade plan for the stale walk. **Fix:** name
  the phase-1 set and add the folders when phase 3 lands.
- **L6 — The run machine must stay fold-safe (AD-6).** The pure `transition` collects custom actions without running
  them, and it cannot fire delays. **Fix:** state that the generated machine uses only `assign` and non-delayed
  `raise`, with no `after`, `invoke`, `spawn` or custom actions. AD-1 already implies this. A restored actor runs
  no initial macrostep and no eventless re-check on `start` (`StateMachine.ts` `start`), which is fine because
  every folded snapshot is stable.
- **L7 — History names for `ready` and `parked` moves (AD-5, AD-13).** If the history stores status names, a
  `waiting → ready` move logs as `waiting → waiting`. **Fix:** do not log moves whose status name does not change
  (`ready`/`parked`/`waiting` toggles, `judging`). The invariant still holds, because the primary move of that
  macrostep is logged. Say so in AD-5.
- **L8 — Tighten AD-7's soundness sentence.** Replace "a fact moves only its own unit" with the actual condition:
  "no fact outside the chosen unit can disable or change the chosen unit's facts. This holds while the alphabet
  has no `obligation.stale`, `run.cancelled` or `run.ended`, because a unit with a fact has only trusted
  dependencies, and a trusted unit leaves `trusted` only by `obligation.stale`." Also add a check that the chosen
  unit's offered facts include at least one key-changing fact, so that a disagreement between the alphabet and the
  machine fails loudly rather than reading as stuck.
- **L9 — `serializeState` = value + attempts is sufficient only while no guard reads other context.** Today only
  attempts (budget) and the log (AD-4 "earliest dead", which picks only among final outcomes) are read. **Fix:** add
  a test that lists the context paths the guards read, and fail if one is missing from the key.

## Answers to the brief, in one place

| Question | Answer |
| --- | --- |
| Done events when a region leaves final and re-enters one? | Correct per microstep. Completion reads the in-progress configuration, and `completedNodes` stops doubles. |
| Can `active.onDone` fire twice? | Not in a live actor (the machine is `done` right after). In the fold on a done snapshot, the event is queued but never handled, while the exit actions run again and other rows still move units (C1). |
| Can it fire while a region has left final? | Yes, mechanically (p10): a queued done event is not re-checked. This is unreachable in the spine's machine today (M1). |
| Done events for every obligation sub-region? | Semantically harmless, but each one is a microstep plus an eventless pass (M5). They also replace `event`, so later actions lose `at` (H4). |
| Eventless loop guard? | None by default: `maxIterations` is `Infinity`. A self-row with an `assign` hangs (H3). |
| Row conflicts across regions? | None, unless one transition targets several regions (H6). |
| `run.settled` in the outcome; `running`↔`waiting`; ordered guards? | It works (p1). The guards are complementary, with no oscillation. Fix the obligation tags (M2), `at` (H4) and the reason data (M3). |
| History order and the AD-5 invariant? | The order is activation order for transition actions, and a restored actor differs (H1). The invariant is fragile; use identity (M4). `running`↔`waiting` and the spans are not counterexamples, because they only move with a logged unit move. |
| Fold by `transition` against `send`? | They differ on a done snapshot (C1), on `_nodes` order after a restore (H1), and with a rebuilt machine (H5). Delays and custom actions are none today (L6). |
| AD-7 reduction, limit and key? | The reduction is sound for stuck states. `limit` counts edges. The key as written gives about 24k keys and about 3 min, and collapsing ended tasks gives 336 keys and 7.8 s (H7). Value + attempts is sufficient, subject to L2, L3 and L9. |
| AD-1 ids, meta and tags? | They work as specified (p7). Assert that ids are unique (L1). |

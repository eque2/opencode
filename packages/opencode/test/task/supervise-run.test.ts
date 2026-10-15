import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Schema,
  Scope,
} from "effect"
import path from "path"
import {
  type AnyEventObject,
  assign,
  createActor,
  createMachine,
  fromCallback,
  fromEffect,
  setup,
  SimulatedClock,
} from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskCommand } from "@/task/core/command"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import type { SessionID } from "@/session/schema"
import { RunSupervisor } from "@/task/core/supervise/run"
import { ScenarioSupervisor } from "@/task/core/supervise/scenario"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskStatus } from "@/task/core/status"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, obligationsOf, trustLeaf } from "./lib/machine"
import { eventually, type Run, runOf, settle, stored, storedFacts, storedTypes, unitOf } from "./lib/supervise"

// The run supervisor (spine AD-8, AD-12, AD-19, D6). Unit supervisors are stand-ins that keep their input and the
// events they receive, unless a test needs the real one; the run's facts go through a real Recorder into the real
// event store. Timers run on a SimulatedClock unless the test runs in the harness.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

// A unit supervisor stand-in: it keeps its input, every unit.moved, and the spec reloads it receives.
const listener = setup({
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- xstate reads `types` for its type parameters only
  types: {} as {
    context: { input: unknown; moved: ReadonlyArray<AnyEventObject>; reloads: number }
    events: AnyEventObject
    input: unknown
  },
}).createMachine({
  context: ({ input }) => ({ input, moved: [], reloads: 0 }),
  on: {
    "unit.moved": { actions: assign({ moved: ({ context, event }) => [...context.moved, event] }) },
    "spec.reloaded": { actions: assign({ reloads: ({ context }) => context.reloads + 1 }) },
  },
})

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) the run supervisor only spawns, stops and sends events to a unit supervisor; the stand-in takes each such use
const taskStandIn = listener as unknown as typeof TaskSupervisor.machine
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) as for the task supervisor stand-in
const scenarioStandIn = listener as unknown as typeof ScenarioSupervisor.machine

const Listened = Schema.Struct({
  context: Schema.Struct({
    input: Schema.Struct({
      entry: Schema.Number,
      tags: Schema.Array(Schema.String),
      session: Schema.optional(Schema.String),
      runStart: Schema.optional(Schema.Number),
      clock: Schema.optional(Schema.Struct({ start: Schema.Number, now: Schema.Number })),
    }),
    moved: Schema.Array(
      Schema.Struct({
        unit: Schema.String,
        entry: Schema.Number,
        state: Schema.String,
        tags: Schema.Array(Schema.String),
        latest: Schema.Boolean,
      }),
    ),
    reloads: Schema.Number,
  }),
})

// The log messages of `effect` and of every actor it creates (an actor logs with the context it was made in).
const logged = <A, E, R>(messages: Array<unknown>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(options.message)
        }),
      ]),
    ),
  )

const said = (messages: ReadonlyArray<unknown>, text: string) =>
  messages.filter((message) => JSON.stringify(message).includes(text)).length

type Actors = NonNullable<Parameters<typeof RunSupervisor.machine.provide>[0]["actors"]>

// The batch proof stand-in: every scenario of a batch passes.
const passingBatch = fromEffect(({ input }: { input: { run: TaskWorkers.Run; ids: ReadonlyArray<string> } }) =>
  Effect.gen(function* () {
    yield* FileSystem.FileSystem
    yield* Path.Path
    for (const id of input.ids) yield* TaskWorkers.record(input.run, { type: "scenario.proved", id, status: "passed" })
  }),
)

// A stale check stand-in that finds nothing.
const quietStale = fromEffect<
  { readonly run: TaskWorkers.Run },
  Option.Option<BlendModel.Spec>,
  never,
  FileSystem.FileSystem | Path.Path
>(() =>
  Effect.gen(function* () {
    yield* FileSystem.FileSystem
    yield* Path.Path
    return Option.none<BlendModel.Spec>()
  }),
)

interface Options {
  readonly clock?: SimulatedClock
  readonly actors?: Actors
  readonly trusts?: Effect.Effect<ReadonlyArray<string>>
  readonly resumed?: boolean
  readonly release?: Effect.Effect<void>
}

type Setup = Run & { readonly plan: Plan }

const inputOf = (setup: Setup, options: Options): RunSupervisor.Input => ({
  run: setup.run,
  events: setup.events,
  resumed: options.resumed ?? false,
  path: setup.plan.path,
  trusts: options.trusts ?? Effect.succeed([]),
  release: options.release ?? Effect.void,
  writer: setup.recorder.writer,
})

const logicOf = (options: Options) =>
  RunSupervisor.machine.provide({
    actors: { task: taskStandIn, scenario: scenarioStandIn, batch: passingBatch, ...options.actors },
  })

// The run supervisor as a root actor of its own system, on a SimulatedClock unless the test passes another clock.
const supervise = Effect.fnUntraced(function* (setup: Setup, options: Options = {}) {
  const actor = yield* createActor(logicOf(options), {
    input: inputOf(setup, options),
    clock: options.clock ?? new SimulatedClock(),
  })
  yield* actor.start
  return actor
})

type Supervisor = Effect.Success<ReturnType<typeof supervise>>

const childOf = (actor: { system: Supervisor["system"] }, id: string) => actor.system.get(id)

const listened = Effect.fnUntraced(function* (actor: { system: Supervisor["system"] }, id: string) {
  const ref = yield* childOf(actor, id)
  if (Option.isNone(ref)) return Option.none<typeof Listened.Type>()
  return Option.some(Schema.decodeUnknownSync(Listened)(yield* ref.value.getSnapshot))
})

const alive = (actor: { system: Supervisor["system"] }, id: string) => Effect.map(childOf(actor, id), Option.isSome)

const running = (actor: Supervisor) =>
  eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches("running")),
    "the run supervisor is running",
  )

const runSetup = Effect.fnUntraced(function* (
  plan: Plan,
  stored: Parameters<typeof runOf>[0]["stored"],
  extra: Partial<Parameters<typeof runOf>[0]> = {},
) {
  return { plan, ...(yield* runOf({ plan, directory: "/root", stored, ...extra })) }
})

describe("the run supervisor's start", () => {
  it.live("records run.started with its path and base, then each directory trust of an outside region once", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [])
      yield* supervise(setup, { trusts: Effect.succeed(["T9", "T1.1", "T9", "T8"]) })
      yield* stored(setup.id, 3)
      yield* settle
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "run.started", path: plan.path, base: "dev" },
        { type: "outside.trusted", id: "T9" },
        { type: "outside.trusted", id: "T8" },
      ])
      expect(yield* storedTypes(setup.id)).toHaveLength(3)
    }),
  )

  it.live("records run.resumed when it resumes its stored slice", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      yield* supervise(setup, { resumed: true })
      yield* stored(setup.id, 1)
      expect(yield* storedFacts(setup.id)).toMatchObject([{ type: "run.resumed", path: plan.path, base: "dev" }])
    }),
  )

  it.live(
    "SV20 defers a trust forwarded during start-up, applies it once after run.started, and ignores a repeat",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const setup = yield* runSetup(plan, [])
        const gate = yield* Deferred.make<void>()
        const slowStart = fromEffect(({ input }: { input: { run: TaskWorkers.Run; resumed: boolean; path: string } }) =>
          Effect.gen(function* () {
            yield* Deferred.await(gate)
            yield* TaskWorkers.record(input.run, { type: "run.started", base: input.run.base, path: input.path })
            return yield* Clock.currentTimeMillis
          }),
        )
        const actor = yield* supervise(setup, { actors: { start: slowStart }, trusts: Effect.succeed(["T9"]) })
        expect((yield* actor.getSnapshot).value).toBe("starting")
        yield* actor.send({ type: "run.trust", id: "T9" })
        yield* actor.send({ type: "run.trust", id: "T1.3" })
        yield* settle
        expect(yield* storedTypes(setup.id)).toEqual([])
        yield* Deferred.succeed(gate, undefined)
        yield* stored(setup.id, 2)
        yield* running(actor)
        // A trust that comes again once the region holds it, or for a task, records nothing.
        yield* eventually(
          Effect.map(setup.recorder.actor.getSnapshot, (snapshot) => unitOf(snapshot, "T9").state === "trusted"),
          "T9 trusted",
        )
        yield* actor.send({ type: "run.trust", id: "T9" })
        yield* actor.send({ type: "run.trust", id: "T1.3" })
        yield* settle
        expect(yield* storedFacts(setup.id)).toMatchObject([
          { type: "run.started" },
          { type: "outside.trusted", id: "T9" },
        ])
        expect(yield* storedTypes(setup.id)).toHaveLength(2)
      }),
  )

  it.live("SV20 records a trust for an outside region once, never for an external region or a task", () =>
    Effect.gen(function* () {
      // The subtree of T1.5: T1.3 and T1.4 are its external regions, T9 its outside precondition.
      const plan = yield* loadPlan("release-notes.spec", "T1.5")
      expect(plan.external).toEqual(["T1.3", "T1.4"])
      const setup = yield* runSetup(plan, [])
      yield* supervise(setup, { trusts: Effect.succeed(["T9", "T1.3", "T1.5"]) })
      yield* stored(setup.id, 2)
      yield* settle
      expect(yield* storedFacts(setup.id)).toMatchObject([
        { type: "run.started" },
        { type: "outside.trusted", id: "T9" },
      ])
      expect(yield* storedTypes(setup.id)).toHaveLength(2)
    }),
  )

  it.live("is registered as run:<runID> in the harness before it reads the directory's trusts", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [])
      const harness = yield* TaskHarness.make
      const seen: Array<boolean> = []
      const trusts = Effect.map(harness.running(setup.id), (registered) => {
        seen.push(registered)
        return []
      })
      yield* harness.spawnRun(setup.id, logicOf({}), inputOf(setup, { trusts }))
      yield* eventually(
        Effect.sync(() => seen.length === 1),
        "the trusts read",
      )
      expect(seen).toEqual([true])
    }),
  )
})

describe("the unit supervisors (SV2)", () => {
  it.live(
    "spawns one per ready or active task and per verifying scenario, sends each new entry once, and stops it",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const f = facts()
        const setup = yield* runSetup(plan, [f.runStarted()])
        const actor = yield* supervise(setup)
        yield* running(actor)
        const task = (unit: string) => `task:${setup.id}:${unit}`
        yield* eventually(alive(actor, task("T1.1")), "the T1.1 supervisor")
        // The tasks tagged ready at start each get a supervisor; a waiting one does not.
        expect(yield* alive(actor, task("T1.2"))).toBe(true)
        expect(yield* alive(actor, task("T1.5"))).toBe(false)
        const record = (fact: Parameters<typeof TaskWorkers.record>[1]) => TaskWorkers.record(setup.run, fact)
        yield* record({ type: "task.started", task: "T1.1", worktree: "/wt", branch: "b", base: "c", session: "ses_x" })
        yield* record({ type: "task.ready", task: "T1.1", head: "h" })
        yield* eventually(
          Effect.map(
            listened(actor, task("T1.1")),
            (got) => Option.isSome(got) && got.value.context.moved.length === 2,
          ),
          "two entries of T1.1",
        )
        const moved = Option.getOrThrow(yield* listened(actor, task("T1.1"))).context.moved
        expect(moved.map((item) => [item.state, item.tags, item.latest])).toEqual([
          ["building", ["active", "building"], true],
          ["proving", ["active", "proving"], true],
        ])
        expect(moved[1]?.entry).toBe((moved[0]?.entry ?? 0) + 1)
        // T1.1 ends trusted: its supervisor stops, and S2 (needs T1.1) is proved and then judged by its own supervisor.
        yield* record({
          type: "task.proved",
          task: "T1.1",
          results: obligationsOf(plan, "T1.1").map((id) => ({ id, status: "passed" })),
        })
        yield* record({ type: "task.verified", task: "T1.1", verdicts: [] })
        yield* eventually(
          Effect.map(alive(actor, task("T1.1")), (live) => !live),
          "the T1.1 supervisor stopped",
        )
        yield* eventually(alive(actor, `scenario:${setup.id}:S2`), "the S2 supervisor")
        expect(yield* storedTypes(setup.id)).toContain("scenario.proved")
        // No unit got an entry twice.
        for (const unit of ["T1.2", "T1.3"]) {
          const got = yield* listened(actor, task(unit))
          if (Option.isSome(got)) {
            const entries = got.value.context.moved.map((item) => item.entry)
            expect(entries).toEqual([...new Set(entries)])
          }
        }
      }),
  )

  it.live("spawns a task that became ready without an entry with its state and tags, and a resumed building task", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      // T1.1 is trusted, so T1.3 (after T1.1) is ready with no entry of its own; T1.2 was building at the stop.
      const setup = yield* runSetup(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.started("T1.2")])
      const actor = yield* supervise(setup, { resumed: true })
      yield* running(actor)
      const task = (unit: string) => `task:${setup.id}:${unit}`
      yield* eventually(alive(actor, task("T1.3")), "the T1.3 supervisor")
      yield* eventually(alive(actor, task("T1.2")), "the T1.2 supervisor")
      // T1.3 became ready when T1.1 was trusted: no history entry of its own, and the ready tags.
      const ready = Option.getOrThrow(yield* listened(actor, task("T1.3"))).context.input
      expect(ready).toMatchObject({ entry: -1, tags: ["waiting", "ready"] })
      // T1.2 builds on resume: its newest entry, its tags, its builder session and its clock from the resume.
      const building = Option.getOrThrow(yield* listened(actor, task("T1.2"))).context.input
      const snapshot = yield* setup.recorder.actor.getSnapshot
      expect(building).toMatchObject({
        entry: unitOf(snapshot, "T1.2").entry,
        tags: ["active", "building"],
        session: "ses_T1.2",
      })
      expect(building.runStart ?? 0).toBeGreaterThan(1_000_000_000_000)
      expect(building.clock?.start).toBe(building.runStart)
    }),
  )

  it.live("begins a task that became ready once, however many snapshots follow", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const setup = yield* runSetup(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
      const begun: Array<string> = []
      const counting = TaskSupervisor.machine.provide({
        actors: {
          begin: fromEffect<
            { run: TaskWorkers.Run; task: BlendModel.Task },
            { worktree: string; branch: string; base: string; session: SessionID },
            never,
            FileSystem.FileSystem | Path.Path
          >(({ input }) =>
            Effect.gen(function* () {
              yield* FileSystem.FileSystem
              yield* Path.Path
              begun.push(input.task.id)
              return yield* Effect.never
            }),
          ),
        },
      })
      const actor = yield* supervise(setup, { actors: { task: counting } })
      yield* running(actor)
      yield* eventually(
        Effect.sync(() => begun.includes("T1.3")),
        "T1.3 begins",
      )
      // More snapshots: a stale check would not move T1.3; other units' facts do not either.
      yield* TaskWorkers.record(setup.run, { type: "outside.trusted", id: "T9" })
      yield* TaskWorkers.record(setup.run, { type: "outside.trusted", id: "T8" })
      yield* settle
      expect(begun.filter((id) => id === "T1.3")).toEqual(["T1.3"])
      expect(begun.toSorted()).toEqual(["T1.2", "T1.3"])
    }),
  )

  it.live("starts only the newest work of a task whose two entries come in one snapshot", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const setup = yield* runSetup(plan, [f.runStarted(), f.started("T1.1")])
      let proofs = 0
      let turns = 0
      const counting = TaskSupervisor.machine.provide({
        actors: {
          prove: fromEffect(
            ({ input }: { input: { run: TaskWorkers.Run; task: BlendModel.Task; spec: BlendModel.Spec } }) =>
              Effect.gen(function* () {
                yield* FileSystem.FileSystem
                yield* Path.Path
                proofs++
                return yield* Effect.never.pipe(Effect.as(input.task.id), Effect.asVoid)
              }),
          ),
          builderTurn: fromEffect<
            { run: TaskWorkers.Run } & Parameters<typeof TaskWorkers.builderTurn>[1],
            TaskWorkers.Turn,
            never,
            never
          >(({ input }) =>
            Effect.sync(() => {
              turns++
              return input.task.id
            }).pipe(Effect.andThen(Effect.never)),
          ),
        },
      })
      // The relay is the test: each push is one snapshot the supervisor sees.
      const actor = yield* supervise(setup, {
        actors: { task: counting, watch: fromCallback(() => undefined) },
      })
      const push = Effect.gen(function* () {
        yield* actor.send({
          type: "run.changed",
          snapshot: yield* setup.recorder.actor.getSnapshot,
          now: yield* Clock.currentTimeMillis,
        })
      })
      yield* running(actor)
      yield* stored(setup.id, 1)
      yield* push
      yield* eventually(
        Effect.sync(() => turns === 1),
        "the first turn",
      )
      // task.ready (proving) and a failed task.proved (building again) commit before the next snapshot it sees.
      yield* TaskWorkers.record(setup.run, { type: "task.ready", task: "T1.1", head: "h" })
      yield* TaskWorkers.record(setup.run, {
        type: "task.proved",
        task: "T1.1",
        results: [{ id: "T1.1.c1", status: "failed", reason: "no" }],
      })
      yield* eventually(
        Effect.map(
          setup.recorder.actor.getSnapshot,
          (snapshot) =>
            unitOf(snapshot, "T1.1").state === "building" &&
            snapshot.context.log.filter((item) => item.unit === "T1.1").length === 3,
        ),
        "T1.1 back in building",
      )
      yield* push
      yield* eventually(
        Effect.sync(() => turns === 2),
        "the turn of attempt 2",
      )
      yield* settle
      expect(proofs).toBe(0)
      expect(turns).toBe(2)
    }),
  )

  it.live("SV26 counts a unit supervisor that errored as three worker failures: the task ends with its defect", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (b) a unit supervisor that errors at once takes the task supervisor's place
      const broken = fromEffect(() =>
        Effect.die(new Error("the supervisor broke")),
      ) as unknown as typeof TaskSupervisor.machine
      const actor = yield* supervise(setup, { actors: { task: broken } })
      yield* running(actor)
      yield* eventually(
        Effect.map(storedFacts(setup.id), (list) =>
          list.some((fact) => fact.type === "task.failed" && fact.task === "T1.1"),
        ),
        "T1.1 failed",
      )
      const failed = (yield* storedFacts(setup.id)).find((fact) => fact.type === "task.failed" && fact.task === "T1.1")
      expect(failed).toMatchObject({ reason: "harness error: the supervisor broke" })
      expect((yield* actor.getSnapshot).status).toBe("active")
    }),
  )
})

describe("the timer regions", () => {
  it.live("SV5 touches every 5 s on its own region while a stale check waits on the checkout lock", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      const clock = new SimulatedClock()
      let touches = 0
      let checks = 0
      const counting = fromEffect(({ input }: { input: { run: TaskWorkers.Run } }) =>
        Effect.sync(() => {
          touches++
          return input.run.id
        }).pipe(Effect.asVoid),
      )
      const held = fromEffect(({ input }: { input: { run: TaskWorkers.Run } }) =>
        Effect.gen(function* () {
          yield* FileSystem.FileSystem
          yield* Path.Path
          yield* input.run.locks.checkout.withPermit(Effect.sync(() => checks++))
          return Option.none<BlendModel.Spec>()
        }),
      )
      const release = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(setup.run.locks.checkout.withPermit(Deferred.await(release)))
      const actor = yield* supervise(setup, { clock, actors: { touch: counting, stale: held } })
      yield* running(actor)
      yield* settle
      yield* clock.increment(1_000)
      yield* settle
      expect((yield* actor.getSnapshot).matches({ running: { staleCadence: "checking" } })).toBe(true)
      yield* clock.increment(4_000)
      yield* eventually(
        Effect.sync(() => touches === 1),
        "one touch",
      )
      yield* settle
      yield* clock.increment(5_000)
      yield* eventually(
        Effect.sync(() => touches === 2),
        "a second touch",
      )
      // The stale check still waits: the heartbeat never waited on it.
      expect(checks).toBe(0)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
      yield* eventually(
        Effect.sync(() => checks === 1),
        "the stale check",
      )
    }),
  )

  it.live("logs a failed touch, counts it toward nothing and records no fact", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      const clock = new SimulatedClock()
      const messages: Array<unknown> = []
      let touches = 0
      const failing = fromEffect<{ run: TaskWorkers.Run }, void, TaskWorkers.WorkerError, never>(({ input }) =>
        Effect.gen(function* () {
          touches++
          return yield* Effect.fail(new TaskWorkers.WorkerError({ message: `no touch for ${input.run.id}` }))
        }),
      )
      yield* logged(
        messages,
        Effect.gen(function* () {
          const actor = yield* supervise(setup, { clock, actors: { touch: failing } })
          yield* running(actor)
          for (const count of [1, 2, 3]) {
            yield* clock.increment(5_000)
            yield* eventually(
              Effect.sync(() => touches === count),
              `touch ${count}`,
            )
            yield* settle
          }
          expect((yield* actor.getSnapshot).matches({ running: { heartbeat: "beating" } })).toBe(true)
        }),
      )
      // Each failure is logged; none records a fact or ends anything.
      expect(said(messages, "task harness: a heartbeat touch failed")).toBe(3)
      expect(said(messages, `no touch for ${setup.id}`)).toBe(3)
      expect(yield* storedTypes(setup.id)).toEqual(["run.started"])
    }),
  )

  it.live("records obligation.stale for a changed hash and sends the reloaded spec to its unit supervisors (H9)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const specDir = path.join(directory, "release-notes.spec")
      yield* fs.copy(path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec"), specDir)
      const loaded = yield* Blend.load(specDir)
      const spec = loaded.spec
      if (spec === undefined) throw new Error("the copy did not load")
      const plan = TaskCommand.plan({
        spec,
        specPath: "release-notes.spec",
        path: "release-notes.spec",
        root: Option.none(),
      })
      const f = facts()
      const setup = {
        plan,
        ...(yield* runOf({ plan, directory, stored: [f.runStarted(), ...trustLeaf(plan, f, "T1.1")] })),
      }
      // runOf points the stale check at the directory; the spec folder is inside it.
      const run = { ...setup.run, specDir }
      const clock = new SimulatedClock()
      const actor = yield* createActor(logicOf({}), { input: { ...inputOf(setup, {}), run }, clock })
      yield* actor.start
      yield* running(actor)
      yield* eventually(alive(actor, `task:${setup.id}:T1.2`), "the T1.2 supervisor")
      const file = path.join(specDir, "T1-release-notes.task", "T1.1-commit-parser.task", "VERIFY.md")
      yield* fs.writeFileString(file, (yield* fs.readFileString(file)).replace(/text: "/, 'text: "Changed. '))
      yield* clock.increment(1_000)
      yield* eventually(
        Effect.map(storedTypes(setup.id), (types) => types.includes("obligation.stale")),
        "obligation.stale",
      )
      const staleFacts = (yield* storedFacts(setup.id)).filter((fact) => fact.type === "obligation.stale")
      expect(staleFacts.map((fact) => (fact.type === "obligation.stale" ? fact.id : ""))).toContain("T1.1.c1")
      yield* eventually(
        Effect.map(
          listened(actor, `task:${setup.id}:T1.2`),
          (got) => Option.isSome(got) && got.value.context.reloads > 0,
        ),
        "spec.reloaded at T1.2",
      )
      const current = (yield* actor.getSnapshot).context.spec
      expect(current.obligations.find((item) => item.id === "T1.1.c1")?.text.startsWith("Changed. ")).toBe(true)
    }),
  )

  it.live("logs a stale check that fails three times, records no fact, and keeps its cadence", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      const clock = new SimulatedClock()
      const messages: Array<unknown> = []
      let checks = 0
      const failing = fromEffect<
        { readonly run: TaskWorkers.Run },
        Option.Option<BlendModel.Spec>,
        TaskWorkers.WorkerError,
        FileSystem.FileSystem | Path.Path
      >(({ input }) =>
        Effect.gen(function* () {
          yield* FileSystem.FileSystem
          yield* Path.Path
          checks++
          return yield* Effect.fail(new TaskWorkers.WorkerError({ message: `no spec at ${input.run.specDir}` }))
        }),
      )
      yield* logged(
        messages,
        Effect.gen(function* () {
          const actor = yield* supervise(setup, { clock, actors: { stale: failing } })
          yield* running(actor)
          for (const count of [1, 2, 3, 4]) {
            yield* settle
            yield* clock.increment(1_000)
            yield* eventually(
              Effect.sync(() => checks === count),
              `check ${count}`,
            )
          }
          yield* settle
          expect((yield* actor.getSnapshot).status).toBe("active")
        }),
      )
      expect(said(messages, "task harness: a stale check failed")).toBe(4)
      expect(said(messages, `no spec at ${setup.run.specDir}`)).toBe(4)
      expect(yield* storedTypes(setup.id)).toEqual(["run.started"])
    }),
  )

  it.live("ends a run that outlasts its wall clock, counted from this job's run.started or run.resumed", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const limits: TaskLimits.Limits = { ...TaskLimits.scripted, runWallClock: Option.some(Duration.minutes(30)) }
      for (const resumed of [false, true]) {
        // A resumed slice ran before this job: its earlier time does not count.
        const setup = yield* runSetup(plan, resumed ? [facts().runStarted()] : [], { limits })
        const clock = new SimulatedClock()
        const actor = yield* supervise(setup, { clock, resumed, actors: { stale: quietStale } })
        yield* running(actor)
        yield* settle
        const first = resumed ? "run.resumed" : "run.started"
        yield* clock.increment(Duration.toMillis(Duration.minutes(30)) - 1_000)
        yield* settle
        expect(yield* storedTypes(setup.id)).toEqual([first])
        yield* clock.increment(1_000)
        yield* stored(setup.id, 2)
        expect((yield* storedFacts(setup.id))[1]).toMatchObject({
          type: "run.ended",
          state: "failed",
          reason: "wall clock: the run took over 30 min",
        })
      }
    }),
  )
})

// A run of a copy of the release-notes spec whose stale check reads the copy.
const copiedRun = Effect.fnUntraced(function* (
  stored: (plan: Plan, f: ReturnType<typeof facts>) => ReadonlyArray<Fact>,
  resumed = false,
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const specDir = path.join(directory, "release-notes.spec")
  yield* fs.copy(path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec"), specDir)
  const loaded = yield* Blend.load(specDir)
  const spec = loaded.spec
  if (spec === undefined) throw new Error("the copy did not load")
  const plan = TaskCommand.plan({
    spec,
    specPath: "release-notes.spec",
    path: "release-notes.spec",
    root: Option.none(),
  })
  const setup = { plan, ...(yield* runOf({ plan, directory, stored: stored(plan, facts()) })) }
  const clock = new SimulatedClock()
  const actor = yield* createActor(logicOf({}), {
    input: { ...inputOf(setup, { resumed }), run: { ...setup.run, specDir } },
    clock,
  })
  yield* actor.start
  yield* running(actor)
  // A file of the copy, rewritten.
  const edit = (file: string, change: (text: string) => string) =>
    Effect.gen(function* () {
      const target = path.join(specDir, file)
      yield* fs.writeFileString(target, change(yield* fs.readFileString(target)))
    })
  // One stale check: the cadence fires, and the check ends back in `waiting`.
  const check = Effect.gen(function* () {
    yield* settle
    yield* clock.increment(1_000)
    yield* eventually(
      Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ running: { staleCadence: "checking" } })),
      "the stale check starts",
    )
    yield* eventually(
      Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ running: { staleCadence: "waiting" } })),
      "the stale check ends",
    )
    yield* settle
  })
  const lines = Effect.map(Blend.load(specDir), (result) =>
    result.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`),
  )
  return { specDir, setup, actor, plan, edit, check, lines }
})

const T11_VERIFY = "T1-release-notes.task/T1.1-commit-parser.task/VERIFY.md"
const T12_TASK = "T1-release-notes.task/T1.2-version-bump.task/TASK.md"

// Two loader failures: an unknown category in T1.1's VERIFY.md and a second `refs` key in T1.2's TASK.md.
const breakTwo = (edit: Effect.Success<ReturnType<typeof copiedRun>>["edit"]) =>
  Effect.gen(function* () {
    yield* edit(T11_VERIFY, (text) => text.replace("category: happy-path", "category: nonsense"))
    yield* edit(T12_TASK, (text) => text.replace("---\n", "---\nrefs: []\n"))
  })

const ADDED = '  c9:\n    category: boundary\n    text: "An added obligation."\n    covers: [S2]\n'
const addObligation = (text: string) => text.replace("ensures:\n", `ensures:\n${ADDED}`)
const changeText = (text: string) => text.replace(/text: "/, 'text: "Changed. ')

const checkedFacts = (id: string) =>
  Effect.map(storedFacts(id), (list) => list.flatMap((fact) => (fact.type === "spec.checked" ? [fact] : [])))

const lineOf = (failure: { readonly rule: string; readonly path: string; readonly message: string }) =>
  `${failure.rule} ${failure.path}: ${failure.message}`

const runSnapshot = (setup: Setup) => setup.recorder.actor.getSnapshot

// The run's history entries for spec.checked.
const checkedEntries = (snapshot: Effect.Success<ReturnType<typeof runSnapshot>>) =>
  snapshot.context.log.filter((entry) => entry.unit === "run" && (entry.reason ?? "").startsWith("spec.checked"))

describe("spec.checked and the run warning (D12, AD-12, VF4, VF5)", () => {
  it.live(
    "VF4 a reload that does not validate keeps the plan and the spec, records spec.checked once and sets the warning",
    () =>
      Effect.gen(function* () {
        const { setup, actor, plan, edit, check, lines } = yield* copiedRun((plan, f) => [f.runStarted()])
        const before = (yield* actor.getSnapshot).context.spec
        yield* breakTwo(edit)
        const expected = yield* lines
        expect(expected).toHaveLength(2)
        yield* check
        // The same failures again record nothing.
        yield* check

        const checked = yield* checkedFacts(setup.id)
        expect(checked.map((fact) => fact.failures.map(lineOf))).toEqual([expected])
        expect((yield* actor.getSnapshot).context.spec).toBe(before)
        const snapshot = yield* runSnapshot(setup)
        expect(TaskEngineXState.view(snapshot).run.warning).toBe(expected.join("\n"))
        expect(TaskStatus.project(plan, snapshot).run.warning).toBe(expected.join("\n"))
        expect(checkedEntries(snapshot).map((entry) => entry.reason)).toEqual(["spec.checked: 2 failures"])
      }),
  )

  it.live("VF5 the next reload that validates records spec.checked with no failures and clears the warning", () =>
    Effect.gen(function* () {
      const { specDir, setup, plan, edit, check } = yield* copiedRun((plan, f) => [f.runStarted()])
      const file = path.join(specDir, T11_VERIFY)
      const fs = yield* FileSystem.FileSystem
      const verify = yield* fs.readFileString(file)
      const task = yield* fs.readFileString(path.join(specDir, T12_TASK))
      yield* breakTwo(edit)
      yield* check
      yield* edit(T11_VERIFY, () => verify)
      yield* edit(T12_TASK, () => task)
      yield* check

      expect((yield* checkedFacts(setup.id)).map((fact) => fact.failures.length)).toEqual([2, 0])
      const snapshot = yield* runSnapshot(setup)
      expect(TaskEngineXState.view(snapshot).run.warning).toBeUndefined()
      expect(TaskStatus.project(plan, snapshot).run).not.toHaveProperty("warning")
      expect(checkedEntries(snapshot).map((entry) => entry.reason)).toEqual([
        "spec.checked: 2 failures",
        "spec.checked: no failures",
      ])
    }),
  )

  it.live(
    "a valid reload that adds an obligation id of the plan is a spec.checked failure; the run keeps the old text",
    () =>
      Effect.gen(function* () {
        const { setup, actor, edit, check, lines } = yield* copiedRun((plan, f) => [
          f.runStarted(),
          ...trustLeaf(plan, f, "T1.1"),
        ])
        yield* edit(T11_VERIFY, (text) => changeText(addObligation(text)))
        expect(yield* lines).toEqual([])
        yield* check

        expect((yield* checkedFacts(setup.id)).map((fact) => fact.failures.map(lineOf))).toEqual([
          [`R3 ${T11_VERIFY}: obligation T1.1.c9 is not in the loaded plan; the run keeps the plan it loaded`],
        ])
        // No new text, no stale obligation, no reload sent.
        const spec = (yield* actor.getSnapshot).context.spec
        expect(spec.obligations.find((item) => item.id === "T1.1.c1")?.text.startsWith("Changed. ")).toBe(false)
        expect(spec.obligations.some((item) => item.id === "T1.1.c9")).toBe(false)
        expect(yield* storedTypes(setup.id)).not.toContain("obligation.stale")
      }),
  )

  it.live("a valid reload that removes an obligation id of the plan is a spec.checked failure", () =>
    Effect.gen(function* () {
      const { setup, actor, edit, check, lines } = yield* copiedRun((plan, f) => [f.runStarted()])
      const before = (yield* actor.getSnapshot).context.spec
      yield* edit(T11_VERIFY, (text) => text.replace(/ {2}c3:\n(?: {4}.*\n)+/, ""))
      expect(yield* lines).toEqual([])
      yield* check

      expect((yield* checkedFacts(setup.id)).map((fact) => fact.failures.map(lineOf))).toEqual([
        [`R3 ${T11_VERIFY}: obligation T1.1.c3 of the loaded plan is missing; the run keeps the plan it loaded`],
      ])
      expect((yield* actor.getSnapshot).context.spec).toBe(before)
    }),
  )

  it.live(
    "a resumed slice with a 2-failure warning and a now-valid spec: spec.checked [] comes before obligation.stale",
    () =>
      Effect.gen(function* () {
        const warned = [
          { rule: "R3", path: T11_VERIFY, message: "first" },
          { rule: "R3", path: T12_TASK, message: "second" },
        ]
        const { setup, actor, edit, check } = yield* copiedRun(
          (plan, f) => [
            f.runStarted(),
            ...trustLeaf(plan, f, "T1.1"),
            { type: "spec.checked", at: 50, failures: warned },
          ],
          true,
        )
        expect(TaskEngineXState.view(yield* runSnapshot(setup)).run.warning).toBe(warned.map(lineOf).join("\n"))
        yield* edit(T11_VERIFY, changeText)
        yield* check
        yield* eventually(
          Effect.map(storedTypes(setup.id), (types) => types.includes("obligation.stale")),
          "obligation.stale",
        )

        const types = yield* storedTypes(setup.id)
        const checkedAt = types.lastIndexOf("spec.checked")
        expect((yield* checkedFacts(setup.id)).map((fact) => fact.failures.length)).toEqual([2, 0])
        expect(checkedAt).toBeLessThan(types.indexOf("obligation.stale"))
        const log = (yield* runSnapshot(setup)).context.log
        const entry = log.findLastIndex((item) => item.unit === "run" && item.reason === "spec.checked: no failures")
        const stale = log.findIndex((item) => item.unit === "T1.1.c1" && item.to === "stale")
        expect(entry).toBeGreaterThan(-1)
        expect(entry).toBeLessThan(stale)
        expect(TaskEngineXState.view(yield* runSnapshot(setup)).run.warning).toBeUndefined()
        const spec = (yield* actor.getSnapshot).context.spec
        expect(spec.obligations.find((item) => item.id === "T1.1.c1")?.text.startsWith("Changed. ")).toBe(true)
      }),
  )

  it.live(
    "a resumed slice with a warning: a valid reload that changes a hash and adds an id records only spec.checked",
    () =>
      Effect.gen(function* () {
        const warned = [
          { rule: "R3", path: T11_VERIFY, message: "first" },
          { rule: "R3", path: T12_TASK, message: "second" },
        ]
        const { setup, actor, edit, check } = yield* copiedRun(
          (plan, f) => [
            f.runStarted(),
            ...trustLeaf(plan, f, "T1.1"),
            { type: "spec.checked", at: 50, failures: warned },
          ],
          true,
        )
        const before = (yield* actor.getSnapshot).context.spec
        yield* edit(T11_VERIFY, (text) => changeText(addObligation(text)))
        yield* check

        expect((yield* checkedFacts(setup.id)).map((fact) => fact.failures.map(lineOf))).toEqual([
          warned.map(lineOf),
          [`R3 ${T11_VERIFY}: obligation T1.1.c9 is not in the loaded plan; the run keeps the plan it loaded`],
        ])
        expect(yield* storedTypes(setup.id)).not.toContain("obligation.stale")
        expect((yield* actor.getSnapshot).context.spec).toBe(before)
      }),
  )
})

describe("the end of the run", () => {
  it.live(
    "UI24 stops every region when the run is done, waits for the writer's done write, frees the lease, closes",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const setup = yield* runSetup(plan, [facts().runStarted()])
        const harness = yield* TaskHarness.make
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
        yield* harness.claim({ directory, runID: setup.id, spec: plan.specPath, path: plan.path })
        const atRelease: Array<boolean> = []
        const release = Effect.gen(function* () {
          atRelease.push(setup.recorder.writer.pollUnsafe() !== undefined)
          yield* harness.release(directory, setup.id)
        })
        const actor = yield* supervise(setup, { release })
        yield* running(actor)
        yield* TaskWorkers.record(setup.run, { type: "run.cancelled", reason: "user stop" })
        yield* eventually(
          Effect.map(actor.getSnapshot, (snapshot) => snapshot.status === "done"),
          "the run supervisor closed",
        )
        expect((yield* actor.getSnapshot).value).toBe("closed")
        // The writer had ended (its last write is the done snapshot) before the lease was freed.
        expect(atRelease).toEqual([true])
        expect(yield* harness.live(directory)).toEqual(Option.none())
      }),
  )

  it.live("SV26 a run actor that stops with an error ends the run, logs the defect and frees the lease", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const broken = TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
        node.id === "T1_1/building"
          ? {
              ...node,
              always: [
                { guard: { type: "xstate.stateIn", params: { stateValue: "#nowhere/at_all" } }, target: "proving" },
              ],
            }
          : node,
      )
      const machine = createMachine(broken, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS })
      const setup = yield* runSetup(plan, [facts().runStarted()], { machine })
      const messages: Array<unknown> = []
      let released = 0
      // The harness is made under the test's logger: its actors log with the context they were made in.
      yield* Effect.gen(function* () {
        const harness = yield* TaskHarness.make
        yield* harness.spawnRun(setup.id, logicOf({}), inputOf(setup, { release: Effect.sync(() => released++) }))
        yield* TaskWorkers.record(setup.run, {
          type: "task.started",
          task: "T1.1",
          worktree: "/wt",
          branch: "b",
          base: "c",
          session: "s",
        })
        yield* RunSupervisor.awaitClosed(harness, setup.id).pipe(Effect.timeout(10_000))
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(options.message)
            }),
          ]),
        ),
      )
      expect(released).toBe(1)
      expect(messages.some((message) => JSON.stringify(message).includes("the run actor stopped with an error"))).toBe(
        true,
      )
    }),
  )

  it.live("SV26 a run supervisor that stops with an error ends the job's wait as a close does, and logs it", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = []
      yield* Effect.gen(function* () {
        const harness = yield* TaskHarness.make
        const broken = fromEffect(() => Effect.die(new Error("the run supervisor broke")))
        yield* harness.spawnRun("task_superviserunbroken", broken)
        yield* RunSupervisor.awaitClosed(harness, "task_superviserunbroken").pipe(Effect.timeout(10_000))
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>((options) => {
              messages.push(options.message)
            }),
          ]),
        ),
      )
      expect(
        messages.some((message) => JSON.stringify(message).includes("the run supervisor stopped with an error")),
      ).toBe(true)
      expect(messages.some((message) => JSON.stringify(message).includes("the run supervisor broke"))).toBe(true)
    }),
  )

  it.live("SV27 a closed scope stops the supervisors with no fact and no release", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      let released = 0
      const scope = yield* Scope.make()
      const actor = yield* supervise(setup, { release: Effect.sync(() => released++) }).pipe(Scope.provide(scope))
      yield* running(actor)
      yield* eventually(alive(actor, `task:${setup.id}:T1.1`), "the T1.1 supervisor")
      yield* Scope.close(scope, Exit.void)
      yield* settle
      expect((yield* actor.getSnapshot).status).toBe("stopped")
      expect(yield* storedTypes(setup.id)).toEqual(["run.started"])
      expect(released).toBe(0)
    }),
  )
})

describe("the job's cancel (SV4, SV25)", () => {
  it.live("SV4 records run.cancelled while a stale check waits, lets the supervisor close, and the file holds it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = yield* loadPlan("release-notes.spec")
      const setup = { plan, ...(yield* runOf({ plan, directory, stored: [facts().runStarted()], writes: true })) }
      const harness = yield* TaskHarness.make
      const held = fromEffect(({ input }: { input: { run: TaskWorkers.Run } }) =>
        Effect.gen(function* () {
          yield* FileSystem.FileSystem
          yield* Path.Path
          yield* input.run.locks.checkout.withPermit(Effect.void)
          return Option.none<BlendModel.Spec>()
        }),
      )
      const release = yield* Deferred.make<void>()
      yield* Effect.forkChild(setup.run.locks.checkout.withPermit(Deferred.await(release)))
      let released = 0
      yield* harness.spawnRun(
        setup.id,
        logicOf({ actors: { stale: held } }),
        inputOf(setup, { release: Effect.sync(() => released++) }),
      )
      const ref = Option.getOrThrow(yield* harness.system.get(TaskHarness.systemId.run(setup.id)))
      // The stale cadence fires after 1 s and its check waits on the checkout lock.
      yield* eventually(
        Effect.map(ref.getSnapshot, (snapshot) => JSON.stringify(snapshot.value).includes('"staleCadence":"checking"')),
        "the stale check waits",
      )
      const before = yield* Clock.currentTimeMillis
      yield* RunSupervisor.cancel(harness, setup.run)
      const took = (yield* Clock.currentTimeMillis) - before
      expect(yield* storedTypes(setup.id)).toEqual(["run.started", "run.cancelled"])
      // The supervisor closed by itself before the cancel stopped it: its last step freed the lease.
      expect(released).toBe(1)
      expect(took).toBeLessThan(Duration.toMillis(setup.run.limits.cancelDeadline) + 2_000)
      expect(yield* harness.running(setup.id)).toBe(false)
      yield* eventually(
        Effect.gen(function* () {
          const text = yield* fs
            .readFileString(path.join(directory, ".opencode", "task", "status.json"))
            .pipe(Effect.orElseSucceed(() => "{}"))
          return text.includes('"cancelled"')
        }),
        "status.json holds the cancel",
      )
      const status = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(
        yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json")),
      )
      expect(status.run.state).toBe("cancelled")
      yield* Deferred.succeed(release, undefined)
    }),
  )

  it.live("SV25 a cancel before run.started is stored waits for it, and records run.cancelled after it", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runSetup(plan, [facts().runStarted()])
      const harness = yield* TaskHarness.make
      const gate = yield* Deferred.make<void>()
      const slowStart = fromEffect(({ input }: { input: { run: TaskWorkers.Run; resumed: boolean; path: string } }) =>
        Effect.gen(function* () {
          yield* Deferred.await(gate)
          yield* TaskWorkers.record(input.run, { type: "run.resumed", base: input.run.base, path: input.path })
          return yield* Clock.currentTimeMillis
        }),
      )
      yield* harness.spawnRun(setup.id, logicOf({ actors: { start: slowStart } }), inputOf(setup, { resumed: true }))
      const cancelling = yield* Effect.forkChild(RunSupervisor.cancel(harness, setup.run))
      yield* Effect.sleep(200)
      expect(yield* storedTypes(setup.id)).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(cancelling)
      expect(yield* storedTypes(setup.id)).toEqual(["run.resumed", "run.cancelled"])
    }),
  )
})

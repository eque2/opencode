import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Logger, Option, Schema, Semaphore } from "effect"
import path from "path"
import { createActor, fromEffect, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"
import { BASE, boundary, eventually, storedFacts, storedTypes } from "./lib/supervise"

// Scenario SV5 (spec task-harness-feedback, AD-8, AD-9, AD-12; task T2.10): the heartbeat, the wall clock and the
// stale cadence run independently.
//
//   Given a live run whose stale check is held on the checkout lock
//   When the clock advances by 5 seconds
//   Then the status file is touched once with a newer heartbeat
//   And a touch that fails is logged and records no fact
//   And the run wall clock records run.ended in state failed when it expires
//
// The run supervisor is the real machine, created as a root actor on a SimulatedClock so the test can move its timers
// by exactly 5 s. Its workers are the real ones: `touch` asks the real Recorder's status writer to rewrite the last
// snapshot, `stale` loads the spec under the run's checkout lock, `record` goes through the Recorder into the real
// event store. The status writer writes status.json for real; its write function is wrapped only to count the writes.
// The plan is the T1.5 subtree of release-notes: T1.5 waits on the external T1.3 and T1.4 and on T9, so the run is
// live with no unit to supervise and every write is the run's own. The checkout lock is held from the start, so every
// stale check waits on it. One test replaces the touch worker with one that fails, because the real touch (a queue
// offer) cannot fail; that test is about the run supervisor's handling of the failure.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_DIR = path.resolve(import.meta.dir, "../../../../task-formats/blend/release-notes.spec")

interface Write {
  readonly aliveAt: number
  readonly status: TaskStatus.Status
}

let runs = 0

// The run: its Recorder writing status.json in a fresh directory, its locks with the checkout lock held, and the run
// supervisor on a SimulatedClock. `messages` gets every log message of the Recorder, the workers and the actors.
const startRun = Effect.fnUntraced(function* (options: {
  readonly limits?: TaskLimits.Limits
  readonly touch?: ReturnType<typeof fromEffect<{ run: TaskWorkers.Run }, void, TaskWorkers.WorkerError, never>>
}) {
  const fs = yield* FileSystem.FileSystem
  const plan = yield* loadPlan("release-notes.spec", "T1.5")
  const directory = yield* fs.makeTempDirectoryScoped()
  const events = yield* EventV2Bridge.Service
  const id = `task_sv5run${(runs++).toString(16).padStart(4, "0")}`
  const writes: Array<Write> = []
  const recorder = yield* TaskRecorder.make({
    plan,
    runID: id,
    directory,
    stored: [],
    events,
    write: (status, aliveAt) =>
      Effect.sync(() => writes.push({ aliveAt, status })).pipe(
        Effect.andThen(TaskStatus.write(directory, status, aliveAt)),
      ),
  })
  const checkout = yield* Semaphore.make(1)
  // The checkout lock, held by another fiber until the test lets it go.
  const held = yield* Deferred.make<void>()
  const letGo = yield* Deferred.make<void>()
  const holder = yield* Effect.forkChild(
    checkout.withPermit(Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(letGo)))),
  )
  yield* Deferred.await(held)
  const { env } = boundary([])
  const run: TaskWorkers.Run = {
    env,
    id,
    directory,
    base: BASE,
    specDir: SPEC_DIR,
    plan,
    root: SessionID.make("ses_sv5_root"),
    model: { providerID: "test", modelID: "test" },
    limits: options.limits ?? TaskLimits.scripted,
    locks: { checkout, git: yield* Semaphore.make(1) },
    recorder,
    claim: () => Effect.void,
  }
  const clock = new SimulatedClock()
  let released = 0
  const logic =
    options.touch === undefined
      ? RunSupervisor.machine
      : RunSupervisor.machine.provide({ actors: { touch: options.touch } })
  const actor = yield* createActor(logic, {
    input: {
      run,
      events,
      resumed: false,
      path: plan.path,
      trusts: Effect.succeed([]),
      externals: [],
      release: Effect.sync(() => {
        released++
      }),
      writer: recorder.writer,
    } satisfies RunSupervisor.Input,
    clock,
  })
  yield* actor.start
  yield* eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches("running")),
    "the run supervisor runs",
  )
  // The run.started write has landed, and nothing else is in flight.
  yield* eventually(
    Effect.sync(() => writes.length > 0),
    "the first status write",
  )
  yield* Effect.sleep(150)
  const unlock = Effect.andThen(Deferred.succeed(letGo, undefined), Fiber.join(holder))
  return { plan, directory, id, writes, recorder, actor, clock, unlock, released: () => released }
})

type Run = Effect.Success<ReturnType<typeof startRun>>

const fileOf = (directory: string) => path.join(directory, ".opencode", "task", "status.json")

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))

const readStatus = Effect.fnUntraced(function* (directory: string) {
  return decodeStatus(yield* (yield* FileSystem.FileSystem).readFileString(fileOf(directory)))
})

const regionOf = (run: Run, region: string) =>
  Effect.map(run.actor.getSnapshot, (snapshot) => {
    const value: unknown = snapshot.value
    return JSON.stringify(value).match(new RegExp(`"${region}":"([a-z]+)"`))?.[1] ?? ""
  })

// The log messages of the effect and of every actor and fiber made inside it.
const logged = <A, E, R>(messages: Array<string>, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make<unknown, void>((options) => {
          messages.push(JSON.stringify(options.message))
        }),
      ]),
    ),
  )

// Given: a live run whose stale check is held on the checkout lock.
const givenHeld = Effect.fnUntraced(function* (run: Run) {
  expect((yield* run.recorder.actor.getSnapshot).status).toBe("active")
  expect(TaskEngineXState.view(yield* run.recorder.actor.getSnapshot).run.state).not.toBe("done")
  expect(yield* storedTypes(run.id)).toEqual(["run.started"])
  // The stale cadence fires after 1 s, and its check waits on the held lock.
  yield* run.clock.increment(1_000)
  yield* eventually(
    Effect.map(regionOf(run, "staleCadence"), (state) => state === "checking"),
    "the stale check waits on the checkout lock",
  )
})

it.live(
  "[SV5] with the stale check held on the checkout lock, 5 seconds touch the status file once with a newer heartbeat",
  () =>
    Effect.gen(function* () {
      const run = yield* startRun({})
      yield* givenHeld(run)
      yield* Effect.sleep(150)
      const before = run.writes.length
      const last = run.writes.at(-1)
      if (last === undefined) throw new Error("no write")
      expect((yield* readStatus(run.directory)).run.aliveAt).toBe(last.aliveAt)
      expect(yield* regionOf(run, "heartbeat")).toBe("beating")

      // When the clock advances by 5 seconds.
      yield* run.clock.increment(5_000)
      yield* eventually(
        Effect.sync(() => run.writes.length === before + 1),
        "the touch's write",
      )
      yield* Effect.sleep(300)
      // Then the status file is touched once: one write, of the same snapshot, with a newer heartbeat.
      expect(run.writes.length).toBe(before + 1)
      const touched = run.writes.at(-1)
      expect(touched?.status).toEqual(last.status)
      expect(touched?.aliveAt ?? 0).toBeGreaterThan(last.aliveAt)
      const file = yield* readStatus(run.directory)
      expect(file.run.aliveAt).toBe(touched?.aliveAt)
      expect(file.run.state).toBe(last.status.run.state)
      // The stale check still waits on the lock: the heartbeat did not wait for it, and it recorded nothing.
      expect(yield* regionOf(run, "staleCadence")).toBe("checking")
      expect(yield* storedTypes(run.id)).toEqual(["run.started"])

      // The heartbeat keeps its own cadence of 5 s from its last touch: 3 s more give nothing, 2 s more one touch.
      yield* run.clock.increment(3_000)
      yield* Effect.sleep(300)
      expect(run.writes.length).toBe(before + 1)
      yield* run.clock.increment(2_000)
      yield* eventually(
        Effect.sync(() => run.writes.length === before + 2),
        "the second touch's write",
      )
      expect(run.writes.at(-1)?.aliveAt ?? 0).toBeGreaterThan(touched?.aliveAt ?? Infinity)
      // Once the lock is free, the stale check that waited completes on its own region.
      yield* run.unlock
      yield* eventually(
        Effect.map(regionOf(run, "staleCadence"), (state) => state === "waiting"),
        "the stale check ends",
      )
      expect(yield* storedTypes(run.id)).toEqual(["run.started"])
    }),
  60_000,
)

it.live(
  "[SV5] a touch whose status write fails is logged and records no fact; the heartbeat goes on",
  () =>
    Effect.gen(function* () {
      const messages: Array<string> = []
      yield* logged(
        messages,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const run = yield* startRun({})
          yield* givenHeld(run)
          // The status file's path becomes a directory: the writer's rename onto it fails.
          yield* fs.remove(fileOf(run.directory))
          yield* fs.makeDirectory(path.join(fileOf(run.directory), "blocked"), { recursive: true })
          const before = run.writes.length
          yield* run.clock.increment(4_000)
          yield* eventually(
            Effect.sync(() => run.writes.length === before + 1),
            "the failing touch",
          )
          yield* eventually(
            Effect.sync(() => messages.some((message) => message.includes("task harness: the status write failed"))),
            "the failure logged",
          )
          // No fact, and the run and its heartbeat go on.
          expect(yield* storedTypes(run.id)).toEqual(["run.started"])
          expect((yield* run.recorder.actor.getSnapshot).status).toBe("active")
          yield* eventually(
            Effect.map(regionOf(run, "heartbeat"), (state) => state === "beating"),
            "the heartbeat beats again",
          )
          // With the path free again, the next touch writes the file.
          yield* fs.remove(fileOf(run.directory), { recursive: true })
          yield* run.clock.increment(5_000)
          yield* eventually(
            Effect.sync(() => run.writes.length === before + 2),
            "the next touch",
          )
          yield* eventually(
            Effect.map(fs.exists(fileOf(run.directory)), (exists) => exists),
            "status.json written again",
          )
          expect((yield* readStatus(run.directory)).run.aliveAt).toBe(run.writes.at(-1)?.aliveAt)
          expect(yield* storedTypes(run.id)).toEqual(["run.started"])
          yield* run.unlock
        }),
      )
    }),
  60_000,
)

it.live(
  "[SV5] a touch worker that fails is logged by the run supervisor, records no fact, and the heartbeat goes on",
  () =>
    Effect.gen(function* () {
      const messages: Array<string> = []
      let touches = 0
      const failing = fromEffect<{ run: TaskWorkers.Run }, void, TaskWorkers.WorkerError, never>(({ input }) =>
        Effect.gen(function* () {
          touches++
          return yield* new TaskWorkers.WorkerError({ message: `no touch for ${input.run.id}` })
        }),
      )
      yield* logged(
        messages,
        Effect.gen(function* () {
          const run = yield* startRun({ touch: failing })
          yield* givenHeld(run)
          for (const count of [1, 2, 3]) {
            yield* run.clock.increment(count === 1 ? 4_000 : 5_000)
            yield* eventually(
              Effect.sync(() => touches === count),
              `touch ${count}`,
            )
            yield* eventually(
              Effect.map(regionOf(run, "heartbeat"), (state) => state === "beating"),
              `the heartbeat beats again after touch ${count}`,
            )
          }
          expect(messages.filter((message) => message.includes("task harness: a heartbeat touch failed"))).toHaveLength(
            3,
          )
          expect(messages.filter((message) => message.includes(`no touch for ${run.id}`))).toHaveLength(3)
          expect(yield* storedTypes(run.id)).toEqual(["run.started"])
          expect((yield* run.actor.getSnapshot).status).toBe("active")
          expect(yield* regionOf(run, "staleCadence")).toBe("checking")
          yield* run.unlock
        }),
      )
    }),
  60_000,
)

it.live(
  "[SV5] the run wall clock records run.ended in state failed when it expires, while the stale check still waits",
  () =>
    Effect.gen(function* () {
      const limits: TaskLimits.Limits = { ...TaskLimits.scripted, runWallClock: Option.some(Duration.minutes(30)) }
      const run = yield* startRun({ limits })
      yield* givenHeld(run)
      expect(yield* regionOf(run, "wallClock")).toBe("counting")
      // One second short of the wall clock (1 s already passed): nothing ends.
      yield* run.clock.increment(Duration.toMillis(Duration.minutes(30)) - 2_000)
      yield* Effect.sleep(300)
      expect(yield* storedTypes(run.id)).toEqual(["run.started"])
      expect(yield* regionOf(run, "staleCadence")).toBe("checking")
      // The wall clock expires: run.ended in state failed, through the Recorder, while the stale check still waits.
      yield* run.clock.increment(1_000)
      yield* eventually(
        Effect.map(storedTypes(run.id), (types) => types.includes("run.ended")),
        "run.ended",
      )
      expect((yield* storedFacts(run.id)).map(({ at: _at, ...fact }) => fact)).toEqual([
        { type: "run.started", base: BASE, path: run.plan.path },
        { type: "run.ended", state: "failed", reason: "wall clock: the run took over 30 min" },
      ])
      // The Recorder stores a fact, then sends it to the run actor: the fold follows the store.
      yield* eventually(
        Effect.map(
          run.recorder.actor.getSnapshot,
          (snapshot) => TaskEngineXState.view(snapshot).run.state === "failed",
        ),
        "the run actor's run state failed",
      )
      expect((yield* run.recorder.actor.getSnapshot).status).toBe("done")
      // The run supervisor then stops its regions, waits for the writer's last write and closes; the file says failed.
      yield* eventually(
        Effect.map(run.actor.getSnapshot, (supervisor) => supervisor.status === "done"),
        "the run supervisor closed",
      )
      expect((yield* readStatus(run.directory)).run.state).toBe("failed")
      expect(run.released()).toBe(1)
      yield* run.unlock
    }),
  60_000,
)

import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Schema, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskEvents } from "@/task/core/events"
import type { Fact, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { createMachine } from "@jambudipa/xstate-effect"
import { facts, loadPlan, trustLeaf } from "./lib/machine"

// The Recorder (spine AD-9): the only way a fact enters a run. `record` stamps `at`, publishes the fact to the run's
// aggregate and sends it to the run actor, under one permit and uninterruptibly; the status writer writes
// `status.json` once per committed macrostep and on each touch. These tests use the real event store.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

let runs = 0
const runID = () => `task_recorder${(runs++).toString(16).padStart(4, "0")}`

// A recorder over a fresh run of `plan` in a temp directory, with the stored facts of its slice.
const open = Effect.fnUntraced(function* (
  plan: Plan,
  stored: ReadonlyArray<Fact> = [],
  machine = TaskMachine.machine(plan),
) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const events = yield* EventV2Bridge.Service
  const id = runID()
  const recorder = yield* TaskRecorder.make({ plan, runID: id, directory, stored, events, machine })
  return { recorder, directory, id, events }
})

const storedOf = Effect.fnUntraced(function* (id: string) {
  const db = yield* Database.Service
  return yield* TaskEvents.read(db.db, id)
})

const statusOf = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path.join(directory, ".opencode", "task", "status.json"))
  return Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(text)
})

// Waits until the writer has written a status that satisfies `ready` (the writer runs on its own fiber).
const written = Effect.fnUntraced(function* (directory: string, ready: (status: TaskStatus.Status) => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    const status = yield* statusOf(directory).pipe(Effect.option)
    if (Option.isSome(status) && ready(status.value)) return status.value
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(new Error("the status writer never wrote the expected status"))
})

describe("TaskRecorder.record", () => {
  it.live("stamps at from the clock, stores the fact on the run aggregate, then the run actor folds it", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const { recorder, id } = yield* open(plan)
      yield* recorder.record({ type: "run.started", path: plan.path })
      yield* recorder.record({
        type: "task.started",
        task: "T1.1",
        worktree: "/wt",
        branch: "b",
        base: "c",
        session: "s",
      })
      const stored = yield* storedOf(id)
      expect(stored.map((fact) => fact.type)).toEqual(["run.started", "task.started"])
      for (const fact of stored) expect(fact.at).toBeGreaterThan(1_000_000_000_000)
      const snapshot = yield* recorder.actor.getSnapshot
      expect(TaskEngineXState.unitState(snapshot, "T1.1")).toBe("building")
      expect(snapshot.context.log.map((entry) => entry.at)).toContain(stored[1]?.at ?? 0)
    }),
  )

  it.effect("keeps the store order and the fold order equal, and at never decreases, under concurrent records", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const { recorder, id } = yield* open(plan)
      yield* TestClock.setTime(5_000)
      yield* recorder.record({ type: "run.started" })
      // Two fibers race: each records its leaf's start while the clock moves on.
      yield* Effect.all(
        [
          recorder.record({ type: "task.started", task: "T1.1", worktree: "/a", branch: "a", base: "x", session: "a" }),
          TestClock.adjust(10).pipe(
            Effect.andThen(
              recorder.record({
                type: "task.started",
                task: "T1.2",
                worktree: "/b",
                branch: "b",
                base: "x",
                session: "b",
              }),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      )
      const stored = yield* storedOf(id)
      const log = (yield* recorder.actor.getSnapshot).context.log
      expect(stored.flatMap((fact) => ("task" in fact ? [fact.task] : []))).toEqual(
        log.filter((entry) => entry.unit === "T1.1" || entry.unit === "T1.2").map((entry) => entry.unit),
      )
      const times = stored.map((fact) => fact.at)
      expect(times).toEqual(times.toSorted((a, b) => a - b))
    }),
  )

  it.live("stores nothing once the run is done, and a record that waited on the permit stores nothing either", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const { recorder, id } = yield* open(plan)
      yield* recorder.record({ type: "run.started" })
      // A cancel makes the run done; a second record queued behind it on the permit must not follow it.
      yield* Effect.all(
        [recorder.record({ type: "run.cancelled", reason: "user stop" }), recorder.record({ type: "run.resumed" })],
        { concurrency: "unbounded" },
      )
      expect((yield* recorder.actor.getSnapshot).status).toBe("done")
      yield* recorder.record({ type: "run.resumed" })
      const stored = yield* storedOf(id)
      expect(stored.map((fact) => fact.type)).toEqual(["run.started", "run.cancelled"])
    }),
  )

  it.live("stores and folds a fact or neither when its caller is interrupted", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const { recorder, id } = yield* open(plan)
      yield* recorder.record({ type: "run.started" })
      const fiber = yield* Effect.forkChild(
        recorder.record({ type: "task.started", task: "T1.1", worktree: "/wt", branch: "b", base: "c", session: "s" }),
      )
      yield* Fiber.interrupt(fiber)
      const stored = yield* storedOf(id)
      const folded = TaskEngineXState.unitState(yield* recorder.actor.getSnapshot, "T1.1") === "building"
      expect(stored.some((fact) => fact.type === "task.started")).toBe(folded)
    }),
  )

  it.live("fails without a send when the store fails, and after the run scope closed stores nothing", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const events = yield* EventV2Bridge.Service
      const broken: EventV2.Interface = { ...events, publish: () => Effect.die(new Error("the store is down")) }
      const recorder = yield* TaskRecorder.make({ plan, runID: runID(), directory, stored: [], events: broken })
      const exit = yield* Effect.exit(recorder.record({ type: "run.started" }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* recorder.actor.getSnapshot).context.log).toEqual([])
      // A recorder whose scope has closed stores nothing and does not fail.
      const scope = yield* Scope.make()
      const id = runID()
      const closed = yield* TaskRecorder.make({ plan, runID: id, directory, stored: [], events }).pipe(
        Scope.provide(scope),
      )
      yield* Scope.close(scope, Exit.void)
      yield* closed.record({ type: "run.started" })
      expect(yield* storedOf(id)).toEqual([])
    }),
  )

  it.effect("stamps a resumed slice no earlier than its last stored fact, when the clock reads earlier", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const stored: ReadonlyArray<Fact> = [{ type: "run.started", at: 9_000 }]
      const { recorder, id } = yield* open(plan, stored)
      yield* TestClock.setTime(4_000)
      yield* recorder.record({ type: "run.resumed" })
      const facts = yield* storedOf(id)
      expect(facts.at(-1)).toMatchObject({ type: "run.resumed", at: 9_000 })
    }),
  )

  it.live("SV26 stores nothing, logs, and fails once the run actor has an error", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      // A copy of the config whose T1.1 building row reads an unknown state: the actor errors on task.started.
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
      const { recorder, id } = yield* open(plan, [], machine)
      yield* recorder.record({ type: "run.started" })
      yield* recorder.record({
        type: "task.started",
        task: "T1.1",
        worktree: "/wt",
        branch: "b",
        base: "c",
        session: "s",
      })
      expect((yield* recorder.actor.getSnapshot).status).toBe("error")
      const before = (yield* storedOf(id)).length
      const exit = yield* Effect.exit(recorder.record({ type: "task.ready", task: "T1.1", head: "h" }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* storedOf(id)).length).toBe(before)
    }),
  )
})

describe("the status writer", () => {
  it.live("writes once per committed macrostep, the done snapshot last, and nothing after it", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const { recorder, directory } = yield* open(plan)
      yield* recorder.record({ type: "run.started" })
      yield* written(directory, (status) => status.history.length === 1)
      // The builders stamp their own `at`; the recorder stamps every fact again from the clock.
      for (const fact of trustLeaf(plan, facts(), "T1.1")) yield* recorder.record(fact)
      yield* written(directory, (status) => status.tasks["T1.1"]?.state === "trusted")
      yield* recorder.record({ type: "run.cancelled", reason: "user stop" })
      const done = yield* written(directory, (status) => status.run.state === "cancelled")
      expect(done.run.tags).toEqual(["ended", "stopped"])
      yield* Fiber.await(recorder.writer)
      // The writer ended with the done snapshot: a touch now writes nothing.
      const fs = yield* FileSystem.FileSystem
      const file = path.join(directory, ".opencode", "task", "status.json")
      yield* fs.remove(file)
      yield* recorder.touch
      yield* Effect.sleep(50)
      expect(yield* fs.exists(file)).toBe(false)
    }),
  )

  it.live("rewrites the last snapshot on a touch, at most one pending write for a burst, stamping aliveAt", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const { recorder, directory } = yield* open(plan)
      // A touch before the first change never fails.
      yield* recorder.touch
      yield* recorder.record({ type: "run.started" })
      const first = yield* written(directory, (status) => status.history.length === 1)
      yield* Effect.sleep(5)
      yield* Effect.forEach(Array.from({ length: 100 }), () => recorder.touch, { discard: true })
      const touched = yield* written(directory, (status) => (status.run.aliveAt ?? 0) > (first.run.aliveAt ?? 0))
      expect({ ...touched, run: { ...touched.run, aliveAt: 0 } }).toEqual({
        ...first,
        run: { ...first.run, aliveAt: 0 },
      })
      expect(first.run.aliveAt).toBeGreaterThan(1_000_000_000_000)
    }),
  )

  it.live("logs a failed write and still writes the next macrostep", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const { recorder, directory } = yield* open(plan)
      const fs = yield* FileSystem.FileSystem
      // `.opencode` is a plain file, so a write fails.
      yield* fs.writeFileString(path.join(directory, ".opencode"), "not a folder")
      yield* recorder.record({ type: "run.started" })
      yield* Effect.sleep(50)
      yield* fs.remove(path.join(directory, ".opencode"))
      yield* recorder.record({
        type: "task.started",
        task: "T1.1",
        worktree: "/wt",
        branch: "b",
        base: "c",
        session: "s",
      })
      const status = yield* written(directory, (each) => each.tasks["T1.1"]?.state === "building")
      expect(status.history.length).toBeGreaterThan(1)
    }),
  )

  it.live("SV21 has stopped before a finalizer added to the run scope before the recorder runs", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const events = yield* EventV2Bridge.Service
      const scope = yield* Scope.make()
      const seen: Array<boolean> = []
      // The first finalizer of the run scope, as the lease release is (AD-19): it runs last.
      const writer = yield* Effect.gen(function* () {
        const holder: { fiber?: Fiber.Fiber<void> } = {}
        yield* Effect.addFinalizer(() => Effect.sync(() => seen.push(holder.fiber?.pollUnsafe() !== undefined)))
        const recorder = yield* TaskRecorder.make({ plan, runID: runID(), directory, stored: [], events })
        holder.fiber = recorder.writer
        yield* recorder.record({ type: "run.started" })
        return recorder.writer
      }).pipe(Scope.provide(scope))
      yield* Scope.close(scope, Exit.void)
      expect(seen).toEqual([true])
      expect(writer.pollUnsafe()).not.toBeUndefined()
    }),
  )
})

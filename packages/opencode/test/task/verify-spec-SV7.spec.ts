import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { createActor, SimulatedClock } from "@jambudipa/xstate-effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import type { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Fact, History, Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskSupervisor } from "@/task/core/supervise/task"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan } from "./lib/machine"
import {
  eventually,
  hang,
  move,
  prompted,
  type Run,
  runOf,
  sent,
  settle,
  storedFacts,
  type Turn,
  unitOf,
} from "./lib/supervise"

// Scenario SV7 (spec task-harness-feedback, AD-9, AD-5; task T2.4): facts enter only through the Recorder, in one
// order.
//
//   Given two supervisors that record facts at the same moment
//   When the Recorder stores and folds them
//   Then the store order equals the fold order and the recorded times never decrease
//   And a record after the run is done stores nothing
//   And an interrupted record leaves either the whole fact or nothing
//
// The Recorder, the event store and the run actor are real. The two supervisors are the real TaskSupervisor machines
// of T1.1 and T1.2, both building with turns that never end, on one SimulatedClock: one increment of the clock passes
// streamIdle for both at once, so both record task.stalled at the same moment through their real `record` workers.
// The test plays the run supervisor's part (`unit.moved` for each new entry). The interrupt tests hold the store write
// open with a wrapper of the event store's `publish` (an instrument at the store boundary; the Recorder is unchanged).

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const TASKS = ["T1.1", "T1.2"] as const

// T1.1 and T1.2 have no dependency: both are building once started.
const building = () => {
  const f = facts()
  return [f.runStarted(), f.started("T1.1"), f.started("T1.2")]
}

const taskOf = (plan: Plan, id: string) => {
  const task = plan.spec.tasks.find((each) => each.id === id)
  if (task === undefined) throw new Error(`no task ${id}`)
  return task
}

// The real task supervisor of `id`, spawned for the unit as the run actor holds it now.
const spawn = Effect.fnUntraced(function* (setup: Run, plan: Plan, id: string, clock: SimulatedClock) {
  const unit = unitOf(yield* setup.recorder.actor.getSnapshot, id)
  sent.set(`${setup.id}:${id}`, unit.entry)
  const actor = yield* createActor(TaskSupervisor.machine, {
    input: {
      run: setup.run,
      events: setup.events,
      task: taskOf(plan, id),
      spec: plan.spec,
      owner: `task:${setup.id}:${id}`,
      entry: unit.entry,
      tags: unit.tags,
      ...(unit.session === undefined ? {} : { session: unit.session }),
      runStart: 0,
    } satisfies TaskSupervisor.Input,
    clock,
  })
  yield* actor.start
  return actor
})

type Supervisor = Effect.Success<ReturnType<typeof spawn>>

const quiet = (actor: Supervisor, what: string) =>
  eventually(
    Effect.map(actor.getSnapshot, (snapshot) => snapshot.matches({ live: { work: "quiet" } })),
    `${what} is quiet`,
  )

// The log entries the run actor folded after the stored slice.
const foldedSince = (snapshot: { readonly context: { readonly log: ReadonlyArray<History> } }, from: number) =>
  snapshot.context.log.slice(from)

const unitOfFact = (fact: Fact) => ("task" in fact ? fact.task : "")
const reasonOfFact = (fact: Fact) => ("reason" in fact ? (fact.reason ?? "") : "")

// The store order equals the fold order: one log entry per stored stall, the same unit, reason and `at`, in order.
const sameOrder = (stored: ReadonlyArray<Fact>, folded: ReadonlyArray<History>) => {
  const stalls = stored.filter((fact) => fact.type === "task.stalled")
  expect(folded.map((entry) => entry.unit)).toEqual(stalls.map(unitOfFact))
  expect(folded.map((entry) => entry.reason)).toEqual(stalls.map(reasonOfFact))
  expect(folded.map((entry) => entry.at)).toEqual(stalls.map((fact) => fact.at))
}

const nonDecreasing = (times: ReadonlyArray<number>) => {
  for (let index = 1; index < times.length; index++)
    expect(times[index] ?? 0).toBeGreaterThanOrEqual(times[index - 1] ?? 0)
}

it.live(
  "[SV7] two supervisors that stall at the same moment: the store order equals the fold order and at never decreases",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const turns: ReadonlyArray<Turn> = Array.from({ length: 12 }, () => hang)
      const setup = yield* runOf({ plan, directory: "/root", stored: building(), turns })
      const from = (yield* setup.recorder.actor.getSnapshot).context.log.length
      const clock = new SimulatedClock()

      // Given two supervisors whose turns run on one clock.
      const supervisors = [yield* spawn(setup, plan, "T1.1", clock), yield* spawn(setup, plan, "T1.2", clock)]
      yield* prompted(setup.seen, 2)
      yield* settle
      for (let round = 1; round <= 3; round++) {
        // When one increment passes streamIdle for both: both record task.stalled at the same moment.
        yield* clock.increment(2_000)
        yield* eventually(
          Effect.map(storedFacts(setup.id), (stored) => stored.length === round * 2),
          `the two stalls of round ${round}`,
        )
        for (const [index, actor] of supervisors.entries()) yield* quiet(actor, `supervisor ${index + 1}`)
        // The run supervisor's part: each stall entry sends one continue prompt, so both turns run again.
        for (const [index, actor] of supervisors.entries()) yield* move(setup, actor, TASKS[index] ?? "")
        yield* prompted(setup.seen, 2 + round * 2)
        yield* settle
      }

      // Then the store order equals the fold order, and the recorded times never decrease.
      const stored = yield* storedFacts(setup.id)
      expect(stored).toHaveLength(6)
      expect(stored.every((fact) => fact.type === "task.stalled")).toBe(true)
      expect(stored.filter((fact) => unitOfFact(fact) === "T1.1")).toHaveLength(3)
      expect(stored.filter((fact) => unitOfFact(fact) === "T1.2")).toHaveLength(3)
      const folded = foldedSince(yield* setup.recorder.actor.getSnapshot, from)
      sameOrder(stored, folded)
      nonDecreasing(stored.map((fact) => fact.at))
      // Each stall was folded into its own entry: the supervisors' units are building again.
      for (const id of TASKS)
        expect(TaskEngineXState.unitState(yield* setup.recorder.actor.getSnapshot, id)).toBe("building")
    }),
  60_000,
)

it.live(
  "[SV7] forty records at once through the record worker keep one order in the store and the fold, at never decreasing",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const setup = yield* runOf({ plan, directory: "/root", stored: building() })
      const from = (yield* setup.recorder.actor.getSnapshot).context.log.length
      // Two supervisors' record workers, twenty facts each, all started at the same moment.
      yield* Effect.forEach(
        Array.from({ length: 40 }, (_, index) => index),
        (index) =>
          TaskWorkers.record(setup.run, {
            type: "task.stalled",
            task: TASKS[index % 2] ?? "",
            reason: `stall: burst ${index}`,
          }),
        { concurrency: "unbounded", discard: true },
      )
      const stored = yield* storedFacts(setup.id)
      expect(stored).toHaveLength(40)
      sameOrder(stored, foldedSince(yield* setup.recorder.actor.getSnapshot, from))
      nonDecreasing(stored.map((fact) => fact.at))
      // Every fact is there once.
      expect(new Set(stored.map(reasonOfFact)).size).toBe(40)
    }),
  60_000,
)

it.live(
  "[SV7] a record after the run is done stores nothing: not the supervisors' stalls, not a record that queued behind the end",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const turns: ReadonlyArray<Turn> = Array.from({ length: 6 }, () => hang)
      const setup = yield* runOf({ plan, directory: "/root", stored: building(), turns })
      const clock = new SimulatedClock()
      const supervisors = [yield* spawn(setup, plan, "T1.1", clock), yield* spawn(setup, plan, "T1.2", clock)]
      yield* prompted(setup.seen, 2)
      yield* settle

      // The run ends: run.cancelled (the cancel finalizer's fact) and a stall that queued behind it, at once.
      const [cancel, late] = yield* Effect.all(
        [
          Effect.exit(TaskWorkers.record(setup.run, { type: "run.cancelled", reason: "cancelled" })),
          Effect.exit(TaskWorkers.record(setup.run, { type: "task.stalled", task: "T1.1", reason: "stall: late" })),
        ],
        { concurrency: "unbounded" },
      )
      expect(Exit.isSuccess(cancel)).toBe(true)
      expect(Exit.isSuccess(late)).toBe(true)
      const done = yield* setup.recorder.actor.getSnapshot
      expect(done.status).toBe("done")
      expect(TaskEngineXState.view(done).run.state).toBe("cancelled")
      expect((yield* storedFacts(setup.id)).map((fact) => fact.type)).toEqual(["run.cancelled"])

      // Both supervisors' turns are still in flight: their stall timers pass, and their records store nothing.
      yield* clock.increment(2_000)
      for (const [index, actor] of supervisors.entries()) yield* quiet(actor, `supervisor ${index + 1}`)
      expect(setup.seen.cancels.toSorted()).toEqual(["ses_T1.1", "ses_T1.2"])
      // A record worker after the end returns without a failure, and stores nothing.
      const after = yield* Effect.exit(
        TaskWorkers.record(setup.run, { type: "task.failed", task: "T1.2", reason: "too late" }),
      )
      expect(Exit.isSuccess(after)).toBe(true)
      yield* settle
      expect((yield* storedFacts(setup.id)).map((fact) => fact.type)).toEqual(["run.cancelled"])
      expect((yield* setup.recorder.actor.getSnapshot).context.log).toEqual(done.context.log)
    }),
  60_000,
)

// The event store, with a publish that can be held open once it is armed: it signals `entered` and waits for `release`.
const heldStore = Effect.fnUntraced(function* () {
  const events = yield* EventV2Bridge.Service
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const state = { armed: false }
  const held: EventV2.Interface = {
    ...events,
    publish: (definition, data, options) =>
      Effect.gen(function* () {
        if (state.armed) {
          state.armed = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return yield* events.publish(definition, data, options)
      }),
  }
  return { events: held, entered, release, arm: Effect.sync(() => (state.armed = true)) }
})

let runs = 0

// A run of release-notes with T1.1 and T1.2 building, its Recorder over the held store.
const heldRun = Effect.fnUntraced(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const held = yield* heldStore()
  const id = `task_sv7held${(runs++).toString(16).padStart(4, "0")}`
  const recorder = yield* TaskRecorder.make({
    plan,
    runID: id,
    directory: "/root",
    stored: building(),
    events: held.events,
    write: () => Effect.void,
  })
  const from = (yield* recorder.actor.getSnapshot).context.log.length
  const stall = (reason: string) => recorder.record({ type: "task.stalled", task: "T1.1", reason: `stall: ${reason}` })
  const folded = Effect.map(recorder.actor.getSnapshot, (snapshot) =>
    foldedSince(snapshot, from).map((entry) => entry.reason ?? ""),
  )
  return { held, id, recorder, stall, folded }
})

it.live(
  "[SV7] an interrupted record leaves nothing when it waited on the permit, and the whole fact when it was storing",
  () =>
    Effect.gen(function* () {
      const run = yield* heldRun()

      // A record interrupted while it waits on the permit: nothing is stored and nothing is folded.
      yield* run.held.arm
      const holder = yield* Effect.forkChild(run.stall("holder"))
      yield* Deferred.await(run.held.entered)
      const queued = yield* Effect.forkChild(run.stall("queued"))
      yield* Effect.sleep(20)
      yield* Fiber.interrupt(queued)
      expect(Exit.hasInterrupts(yield* Fiber.await(queued))).toBe(true)
      yield* Deferred.succeed(run.held.release, undefined)
      yield* Fiber.join(holder)
      expect((yield* storedFacts(run.id)).map(reasonOfFact)).toEqual(["stall: holder"])
      expect(yield* run.folded).toEqual(["stall: holder"])

      // A record interrupted inside its store write: the interrupt waits, and the whole fact is stored and folded.
      const second = yield* heldStore()
      const recorder = yield* TaskRecorder.make({
        plan: yield* loadPlan("release-notes.spec"),
        runID: `${run.id}b`,
        directory: "/root",
        stored: building(),
        events: second.events,
        write: () => Effect.void,
      })
      const from = (yield* recorder.actor.getSnapshot).context.log.length
      yield* second.arm
      const storing = yield* Effect.forkChild(
        recorder.record({ type: "task.stalled", task: "T1.2", reason: "stall: storing" }),
      )
      yield* Deferred.await(second.entered)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(storing))
      yield* Effect.sleep(50)
      // The record is uninterruptible from its first step to its last: the interrupt has not finished.
      expect(interrupting.pollUnsafe()).toBeUndefined()
      expect(storing.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(second.release, undefined)
      yield* Fiber.join(interrupting).pipe(Effect.timeout(5_000))
      expect((yield* storedFacts(`${run.id}b`)).map(reasonOfFact)).toEqual(["stall: storing"])
      const folded = (yield* recorder.actor.getSnapshot).context.log.slice(from)
      expect(folded.map((entry) => [entry.unit, entry.reason])).toEqual([["T1.2", "stall: storing"]])
    }),
  60_000,
)

it.live(
  "[SV7] thirty records interrupted at random moments: each fact is stored and folded, or neither",
  () =>
    Effect.gen(function* () {
      const run = yield* heldRun()
      yield* Effect.forEach(
        Array.from({ length: 30 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(run.stall(`sweep ${index}`))
            yield* Effect.sleep(Math.floor(Math.random() * 4))
            yield* Fiber.interrupt(fiber)
          }),
        { concurrency: "unbounded", discard: true },
      )
      yield* settle
      const stored = (yield* storedFacts(run.id)).map(reasonOfFact)
      // The same facts in the same order: none is stored without its fold, none folded without being stored.
      expect(yield* run.folded).toEqual(stored)
      expect(stored.every((reason) => reason.startsWith("stall: sweep "))).toBe(true)
      expect(new Set(stored).size).toBe(stored.length)
      nonDecreasing((yield* storedFacts(run.id)).map((fact) => fact.at))
    }),
  60_000,
)

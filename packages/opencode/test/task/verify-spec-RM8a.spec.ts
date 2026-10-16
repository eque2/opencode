import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { git, jobsOf, runTask, seed, SPEC } from "./lib/command"
import { loadPlan, obligationsOf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario RM8a (spec task-harness-feedback, spine AD-4, AD-6, AD-10): an old slice that ended folds with its stop's
// state, and /task starts a new slice.
//
//   Given a stored slice written by the old engine, with run.started without a path and run.ended in state done
//   When the slice is folded through the new machine and /task runs on the whole spec
//   Then every stored fact decodes and folds, and the stored run.ended folds as a stop with its own state
//   And /task records run.started for a new slice, because the old slice ended
//
// The old engine (base 2c0214ab71) wrote 16 fact types; its run.started and run.resumed had no `path`. The store here
// holds two whole-spec slices in the old form: an earlier slice that the user stopped, and the latest slice, which ends
// with `run.ended { state: "done" }`. Together they hold every one of the 16 old fact types, so "every stored fact" is
// every kind the old engine could have stored. The facts go through the real event store (`TaskEvents.publish` and
// `read`, which decodes each through `FactSchema`), the real engine (`initial`, `apply`, the selectors, `view`), the
// real slice choice (`TaskCommand.sliceOf`) and the real `/task` (`TaskCommand.run`, through `./lib/command`), whose
// job records the first fact of the run on the harness.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState
const seeded = seed(SPEC)

// The fact types of the old engine's `FactSchema` (base 2c0214ab71, packages/opencode/src/task/core/events.ts).
const OLD_TYPES = [
  "run.started",
  "run.resumed",
  "outside.trusted",
  "task.started",
  "task.ready",
  "task.proved",
  "task.verified",
  "task.stalled",
  "task.repeated",
  "task.needs_human",
  "task.failed",
  "obligation.stale",
  "scenario.proved",
  "scenario.verified",
  "run.cancelled",
  "run.ended",
]

const decode = Schema.decodeUnknownSync(TaskEvents.FactSchema)

// The two stored old slices, in the old form: `run.started` and `run.resumed` carry a base and no path.
const oldSlices = (plan: Plan) => {
  let clock = 1_700_000_000_000
  const at = () => (clock += 1000)
  const started = (task: string): Fact => ({
    type: "task.started",
    at: at(),
    task,
    worktree: `/wt/${task}`,
    branch: `task/${task}`,
    base: "dev",
    session: `ses_${task}`,
  })
  // An earlier slice: T1.2 needs a human, T1.3 fails, and the user stops the run.
  const earlier: ReadonlyArray<Fact> = [
    { type: "run.started", at: at(), base: "dev" },
    started("T1.2"),
    { type: "task.needs_human", at: at(), task: "T1.2", reason: "the builder asked for a human" },
    { type: "task.failed", at: at(), task: "T1.3", reason: "the builder session died" },
    { type: "run.cancelled", at: at(), reason: "user stop" },
  ]
  // The latest slice: T1.1 is built (a stall, a repetition), proved, verified and trusted; the run is resumed once;
  // S2 is proved and trusted; a stale obligation reopens T1.1; then the old engine records run.ended done.
  const own = obligationsOf(plan, "T1.1")
  const latest: ReadonlyArray<Fact> = [
    { type: "run.started", at: at(), base: "dev" },
    { type: "outside.trusted", at: at(), id: "T9" },
    started("T1.1"),
    { type: "task.stalled", at: at(), task: "T1.1", reason: "no tool call for 10 minutes" },
    { type: "task.repeated", at: at(), task: "T1.1", reason: "the same tool call three times" },
    { type: "task.ready", at: at(), task: "T1.1", head: "head1" },
    { type: "task.proved", at: at(), task: "T1.1", results: own.map((id) => ({ id, status: "passed" as const })) },
    { type: "task.verified", at: at(), task: "T1.1", verdicts: [] },
    { type: "run.resumed", at: at(), base: "dev" },
    { type: "scenario.proved", at: at(), id: "S2", status: "passed" },
    { type: "scenario.verified", at: at(), verdict: { id: "S2", verdict: "trusted" } },
    { type: "obligation.stale", at: at(), id: own[0] ?? "", hash: "hash2" },
    { type: "run.ended", at: at(), state: "done" },
  ]
  return { earlier, latest, stored: [...earlier, ...latest] }
}

// The last item of a list that the test built non-empty.
const lastOf = <A>(list: ReadonlyArray<A>): A => {
  const item = list.at(-1)
  if (item === undefined) throw new Error("the list is empty")
  return item
}

// Each fact through `apply`, one at a time: every snapshot of the way.
const steps = (plan: Plan, list: ReadonlyArray<Fact>) =>
  list.reduce<ReadonlyArray<RunSnapshot>>(
    (snapshots, fact) => [...snapshots, engine.apply(plan, snapshots.at(-1) ?? engine.initial(plan), fact)],
    [engine.initial(plan)],
  )

it.live("[RM8a] the stored old slices: every old fact type, run.started without a path, and run.ended done last", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const { earlier, latest, stored } = oldSlices(plan)
    // Every fact type of the old engine is stored, and no other.
    expect([...new Set(stored.map((fact): string => fact.type))].toSorted()).toEqual(OLD_TYPES.toSorted())
    // No stored fact has a path: the old engine never wrote one.
    for (const fact of stored) expect(Object.keys(fact)).not.toContain("path")
    // The latest slice starts with run.started without a path and ends with run.ended in state done.
    expect(TaskEvents.slices(stored)).toEqual([earlier, latest])
    expect(Option.getOrThrow(TaskEvents.latestRun(stored))).toEqual(latest)
    expect(latest[0]).toEqual({ type: "run.started", at: latest[0]?.at ?? 0, base: "dev" })
    expect(lastOf(latest)).toEqual({ type: "run.ended", at: lastOf(latest).at, state: "done" })
    expect(latest.filter((fact) => fact.type === "run.ended" || fact.type === "run.cancelled")).toHaveLength(1)
    // Every stored fact decodes, as stored JSON, to itself with the current fact schema.
    for (const fact of stored) expect(decode(JSON.parse(JSON.stringify(fact)))).toEqual(fact)
  }),
)

it.live("[RM8a] every stored fact folds through the new machine: each one moves the snapshot, and none dies", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const { earlier, latest } = oldSlices(plan)
    for (const slice of [earlier, latest]) {
      const snapshots = steps(plan, slice)
      // Each fact meets a running machine and moves it: none is dropped as a fact the new machine cannot take.
      slice.forEach((fact, index) => {
        const before = snapshots[index]
        const after = snapshots[index + 1]
        expect(before?.status).toBe("active")
        expect(after).not.toBe(before)
        expect(["active", "done"]).toContain(after?.status ?? "missing")
      })
      // The slice's stop, its last fact, ends the run.
      expect(engine.ended(snapshots.at(-1) ?? engine.initial(plan))).toBe(true)
      // The harness's own fold of the slice reaches the same end.
      const folded = TaskEvents.fold(engine.XStateEngine, plan, slice)
      expect(engine.view(folded)).toEqual(engine.view(snapshots.at(-1) ?? engine.initial(plan)))
    }
  }),
)

it.live(
  "[RM8a] the stored run.ended folds as a stop with its own state: the run ends done, unfinished units cancelled",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const { latest } = oldSlices(plan)
      const end = lastOf(latest)
      const before = TaskEvents.fold(engine.XStateEngine, plan, latest.slice(0, -1))
      // Before the stop: the run is running; T1.1 proves again after the stale; S2 is trusted; the rest have not ended.
      expect(engine.ended(before)).toBe(false)
      expect(engine.view(before).run.state).toBe("running")
      expect(engine.unitState(before, "T1.1")).toBe("proving")
      expect(engine.unitState(before, "S2")).toBe("trusted")
      expect(Option.isNone(engine.stopOf(before))).toBe(true)

      const after = engine.apply(plan, before, end)
      // The stop is noted with the state of the stored run.ended, and the outcome takes that state.
      expect(engine.ended(after)).toBe(true)
      expect(engine.stopOf(after)).toEqual(Option.some({ state: "done" }))
      expect(engine.view(after).run.state).toBe("done")
      expect(engine.unitState(after, "run")).toBe("done")
      expect(engine.view(after).history.at(-1)).toMatchObject({ unit: "run", from: "running", to: "done" })
      // The units that had not ended are cancelled; the trusted scenario keeps its state.
      for (const task of plan.tasks) expect(engine.view(after).tasks[task.id]?.state).toBe("cancelled")
      expect(engine.unitState(after, "S2")).toBe("trusted")
      for (const scenario of plan.scenarios.filter((item) => item.id !== "S2"))
        expect(engine.unitState(after, scenario.id)).toBe("cancelled")

      // Its own state: the same slice with run.ended in state failed ends failed, with the stop's reason.
      const failed = engine.apply(plan, before, {
        type: "run.ended",
        at: end.at,
        state: "failed",
        reason: "wall clock",
      })
      expect(engine.stopOf(failed)).toEqual(Option.some({ state: "failed", reason: "wall clock" }))
      expect(engine.view(failed).run).toMatchObject({ state: "failed", reason: "wall clock" })
    }),
)

it.instance(
  "[RM8a] /task on the whole spec records run.started with the path for a new slice, because the stored old slice ended",
  () =>
    Effect.gen(function* () {
      const directory = yield* seeded
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const events = yield* EventV2Bridge.Service
      const db = yield* Database.Service
      const plan = yield* loadPlan("release-notes.spec")
      const { latest, stored } = oldSlices(plan)
      const id = TaskEvents.runID(directory, SPEC)
      for (const fact of stored) yield* TaskEvents.publish(events, id, fact)

      // Every stored fact decodes back from the event store as it was written.
      expect(yield* TaskEvents.read(db.db, id)).toEqual(stored)
      // The slice choice: the old slice ended, so /task starts a new slice. Without its run.ended it would resume,
      // as a whole-spec slice.
      expect(yield* TaskCommand.sliceOf(plan, stored, SPEC)).toEqual({ kind: "new", died: Option.none() })
      const open = stored.slice(0, -1)
      expect(yield* TaskCommand.sliceOf(plan, open, SPEC)).toEqual({ kind: "resume", facts: latest.slice(0, -1) })

      // /task on the whole spec: the reply is the run header alone (no note of a slice that could not resume).
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      jobs.mode = "run"
      expect(yield* runTask(harness, SPEC, jobs)).toEqual([
        "Implementing spec **Release notes from conventional commits**",
      ])
      yield* eventually(
        Effect.map(TaskEvents.read(db.db, id), (list) => list.length > stored.length),
        "the new slice's first fact",
      )
      const after = yield* TaskEvents.read(db.db, id)
      // The stored old facts stay as they were; the job appends a new slice that starts with run.started and the path.
      expect(after.slice(0, stored.length)).toEqual(stored)
      const added = after.slice(stored.length)
      expect(added[0]).toMatchObject({ type: "run.started", path: SPEC, base: branch })
      expect(added.filter((fact) => fact.type === "run.resumed")).toEqual([])
      expect(Option.getOrThrow(TaskEvents.latestRun(after))[0]).toEqual(added[0])
      expect(TaskEvents.slices(after)).toHaveLength(3)

      jobs.status = "cancelled"
      for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import type { TaskOps } from "@/task/core/ops"
import { TaskStatus } from "@/task/core/status"
import { testEffect } from "../lib/effect"
import { git, type Jobs, jobsOf, seed, services, SESSION, SPEC } from "./lib/command"
import { facts, fold, loadPlan, trustLeaf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario SV20 (spec task-harness-feedback, AD-8, AD-15, AD-19; tasks T2.5, T2.10, T2.11): /task trust reaches the
// live run once.
//
//   Given a live release-notes run with T1.5 waiting on T9
//   When /task trust T9 runs in the directory
//   Then outside.trusted T9 is stored on the directory aggregate and once on the run aggregate, and T1.5 becomes ready
//   And a trust of an id with no untrusted outside region records nothing on the run aggregate
//   And a trust recorded before the run started is applied once, directly after run.started
//
// Everything that runs is the real code, in a real instance (a git repository with a committed copy of the
// release-notes spec): `/task` and `/task trust` are `TaskCommand.run` with the services of lib/command, the harness
// root is real, and the background job runs the real `TaskCommand.job` on its own fiber: the Recorder over the real
// event store, the run supervisor spawned as `run:<runID>`, its task and scenario supervisors. The model side is
// scripted: the command's replies are recorded, and each model turn (a builder's or a judge's) runs until it is
// stopped, so the run stays live until the test cancels it.
//
// The live run resumes a stored slice of the same path in which T1.1 to T1.4 are trusted and each scenario that this
// makes ready has failed (so no scenario proof runs): T1.5 (`after: [T1.3, T1.4, T9]`) then waits only on the outside
// precondition T9, and the run stays live. The run ends by a cancel at the end of each test.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const seeded = seed(SPEC)
const RECORDED = (id: string) => `Task harness: recorded the outside precondition ${id} as trusted.`

/** The stored slice: run.started on the checkout's branch, T1.1 to T1.4 trusted, the scenarios they make ready failed. */
const sliceOf = (plan: Plan, branch: string): ReadonlyArray<Fact> => {
  const f = facts(1)
  const trusted: ReadonlyArray<Fact> = [
    { type: "run.started", at: 1, base: branch, path: SPEC },
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    ...trustLeaf(plan, f, "T1.3"),
    ...trustLeaf(plan, f, "T1.4"),
  ]
  const snapshot = fold(plan, trusted)
  const ready = plan.scenarios.filter((scenario) => snapshot.hasTag(`${scenario.id}:ready`))
  return [...trusted, ...ready.map((scenario) => f.scenarioProved(scenario.id, "failed", "not run in this test"))]
}

// `/task <args>` in the instance: the command's replies, one line per part. A model turn of the run never ends.
const runTask = (harness: TaskHarness.Interface, args: string, jobs: Jobs = jobsOf()) =>
  Effect.gen(function* () {
    const replies: Array<string> = []
    const ops: TaskOps.Ops = {
      prompt: (input) =>
        input.noReply === true
          ? Effect.sync(() => {
              replies.push(input.parts.map((part) => part.text).join("\n"))
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the command never reads the reply message, and a real WithParts needs a stored session
              return {} as SessionV1.WithParts
            })
          : Effect.never,
      cancel: () => Effect.void,
      currentModel: () => Effect.succeed({ providerID: "test", modelID: "test" }),
      say: () => Effect.void,
    }
    yield* TaskCommand.run({ sessionID: SESSION, arguments: args }, ops, harness).pipe(Effect.provide(services(jobs)))
    return replies
  })

const outsideTrusts = (list: ReadonlyArray<Fact>, id?: string) =>
  list.filter((fact) => fact.type === "outside.trusted" && (id === undefined || fact.id === id))

// The facts of an aggregate, and the latest slice of the run aggregate.
const factsOf = Effect.fnUntraced(function* (aggregate: string) {
  const db = yield* Database.Service
  return yield* TaskEvents.read(db.db, aggregate)
})
const latestSlice = (runID: string) =>
  Effect.map(factsOf(runID), (stored) => Option.getOrElse(TaskEvents.latestRun(stored), (): ReadonlyArray<Fact> => []))

// Ends the run by a cancel, as the job registry does.
const cancel = Effect.fnUntraced(function* (jobs: Jobs) {
  jobs.status = "cancelled"
  for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
})

// A live release-notes run of the instance, resumed from the stored slice, with T1.5 waiting on T9 only.
const liveRun = Effect.fnUntraced(function* () {
  const directory = yield* seeded
  const plan = yield* loadPlan("release-notes.spec")
  const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
  const events = yield* EventV2Bridge.Service
  const runID = TaskEvents.runID(directory, SPEC)
  const slice = sliceOf(plan, branch)
  for (const fact of slice) yield* TaskEvents.publish(events, runID, fact)
  const harness = yield* TaskHarness.make
  const jobs = jobsOf()
  jobs.mode = "run"
  const replies = yield* runTask(harness, SPEC, jobs)
  expect(replies[0]).toStartWith("Implementing spec **Release notes from conventional commits**")
  // The job resumed the slice: run.resumed is stored after the slice, and the run holds the directory's lease.
  yield* eventually(
    Effect.map(latestSlice(runID), (list) => list.some((fact) => fact.type === "run.resumed")),
    "run.resumed",
  )
  expect(yield* harness.live(directory)).toEqual(Option.some({ runID, spec: SPEC, path: SPEC }))
  expect(yield* harness.running(runID)).toBe(true)
  // T1.5 waits on T9 alone: T1.3 and T1.4 are trusted, the outside precondition T9 is not.
  const before = TaskStatus.project(plan, fold(plan, yield* latestSlice(runID)))
  expect(before.tasks["T1.5"]).toMatchObject({ state: "waiting", waitingOn: ["T9"], waitingOnOutside: ["T9"] })
  expect(before.outside["T9"]?.state).toBe("untrusted")
  expect(outsideTrusts(yield* latestSlice(runID))).toEqual([])
  return { directory, plan, runID, harness, jobs, directoryID: TaskEvents.directoryID(directory) }
})

it.instance(
  "[SV20] /task trust T9 is stored on the directory aggregate and once on the run aggregate, and T1.5 becomes ready",
  () =>
    Effect.gen(function* () {
      // Given a live release-notes run with T1.5 waiting on T9.
      const run = yield* liveRun()
      // When /task trust T9 runs in the directory.
      expect(yield* runTask(run.harness, "trust T9")).toEqual([RECORDED("T9")])
      // Then outside.trusted T9 is stored on the directory aggregate.
      const directoryFacts = yield* factsOf(run.directoryID)
      expect(directoryFacts.map((fact) => fact.type)).toEqual(["outside.trusted"])
      expect(TaskEvents.trustedOutside(directoryFacts)).toEqual(["T9"])
      // And on the run aggregate, once.
      yield* eventually(
        Effect.map(latestSlice(run.runID), (list) => outsideTrusts(list, "T9").length > 0),
        "outside.trusted T9 on the run aggregate",
      )
      // And T1.5 becomes ready: in the fold right after that fact it is tagged ready, and the live run starts it.
      const slice = yield* latestSlice(run.runID)
      const at = slice.findIndex((fact) => fact.type === "outside.trusted" && fact.id === "T9")
      const ready = fold(run.plan, slice.slice(0, at + 1))
      expect(ready.hasTag("T1.5:ready")).toBe(true)
      expect(fold(run.plan, slice.slice(0, at)).hasTag("T1.5:ready")).toBe(false)
      expect(TaskStatus.project(run.plan, ready).outside["T9"]?.state).toBe("trusted")
      yield* eventually(
        Effect.map(latestSlice(run.runID), (list) =>
          list.some((fact, index) => index > at && fact.type === "task.started" && fact.task === "T1.5"),
        ),
        "the live run starts T1.5",
      )
      // Once: the run aggregate holds T9 one time, also after the run went on.
      yield* Effect.sleep(1_000)
      expect(outsideTrusts(yield* factsOf(run.runID), "T9")).toHaveLength(1)
      yield* cancel(run.jobs)
    }),
  { git: true },
  120_000,
)

it.instance(
  "[SV20] a /task trust of an id with no untrusted outside region records nothing on the run aggregate",
  () =>
    Effect.gen(function* () {
      const run = yield* liveRun()
      expect(yield* runTask(run.harness, "trust T9")).toEqual([RECORDED("T9")])
      yield* eventually(
        Effect.map(latestSlice(run.runID), (list) => outsideTrusts(list, "T9").length === 1),
        "outside.trusted T9 on the run aggregate",
      )
      const settled = Effect.sleep(1_000)
      // A task of the run, an id the spec does not name, and T9 again (its region is now trusted). Each reply comes
      // after the forwarded trust's macrostep in the run supervisor.
      for (const id of ["T1.3", "T42", "T9"]) {
        expect(yield* runTask(run.harness, `trust ${id}`)).toEqual([RECORDED(id)])
        yield* settled
        expect({ id, trusts: TaskEvents.trustedOutside(yield* factsOf(run.runID)) }).toEqual({ id, trusts: ["T9"] })
      }
      // The directory aggregate recorded each command; only the run aggregate filters them.
      expect(TaskEvents.trustedOutside(yield* factsOf(run.directoryID))).toEqual(["T9", "T1.3", "T42", "T9"])
      // The forward still works: T8, an untrusted outside precondition, is recorded on the run aggregate once.
      expect(yield* runTask(run.harness, "trust T8")).toEqual([RECORDED("T8")])
      yield* eventually(
        Effect.map(factsOf(run.runID), (list) => outsideTrusts(list, "T8").length === 1),
        "outside.trusted T8 on the run aggregate",
      )
      yield* settled
      expect(TaskEvents.trustedOutside(yield* factsOf(run.runID))).toEqual(["T9", "T8"])
      yield* cancel(run.jobs)
    }),
  { git: true },
  120_000,
)

it.instance(
  "[SV20] a /task trust recorded before the run started is applied once, directly after run.started",
  () =>
    Effect.gen(function* () {
      const directory = yield* seeded
      const harness = yield* TaskHarness.make
      const runID = TaskEvents.runID(directory, SPEC)
      // A trust recorded while no run is live: the directory aggregate holds it, and no run aggregate exists yet.
      expect(yield* runTask(harness, "trust T9")).toEqual([RECORDED("T9")])
      expect(TaskEvents.trustedOutside(yield* factsOf(TaskEvents.directoryID(directory)))).toEqual(["T9"])
      expect(yield* factsOf(runID)).toEqual([])
      // Then /task starts a new run.
      const jobs = jobsOf()
      jobs.mode = "run"
      const replies = yield* runTask(harness, SPEC, jobs)
      expect(replies[0]).toStartWith("Implementing spec **Release notes from conventional commits**")
      yield* eventually(
        Effect.map(latestSlice(runID), (list) => list.length >= 3),
        "the new slice's first facts",
      )
      // The trust is applied directly after run.started, and once.
      yield* Effect.sleep(1_000)
      const slice = yield* latestSlice(runID)
      expect(slice.slice(0, 2)).toMatchObject([
        { type: "run.started", path: SPEC },
        { type: "outside.trusted", id: "T9" },
      ])
      expect(outsideTrusts(slice)).toHaveLength(1)
      expect(outsideTrusts(yield* factsOf(runID))).toHaveLength(1)
      // T9 is trusted in the run from that fact on.
      const plan = yield* loadPlan("release-notes.spec")
      expect(TaskStatus.project(plan, fold(plan, slice.slice(0, 2))).outside["T9"]?.state).toBe("trusted")
      expect(TaskStatus.project(plan, fold(plan, slice.slice(0, 1))).outside["T9"]?.state).toBe("untrusted")
      yield* cancel(jobs)
    }),
  { git: true },
  120_000,
)

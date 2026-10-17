import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { testEffect } from "../lib/effect"
import { type Facts, facts, fold, loadPlan, trustLeaf, unitState } from "./lib/machine"
import { jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF21 (spec task-harness-feedback, D13, AD-15, SD-13): a typed trust never stands in for a folder task's
// own trust.
//
//   Given /task trust T1.1 was typed, and no stored slice has T1.1 trusted
//   When /task runs on the T1.3 task folder
//   Then the run is refused with the R12 line for T1.3 and T1.1
//   And with an older slice where T1.1 is trusted and a newer slice where T1.1 ended cancelled, the run is refused
//   And with an old slice that has no path and T1.1 trusted, the run starts
//
// The spec is a committed copy of release-notes.spec in a git instance. `/task` (and `/task trust`) is the real
// `TaskCommand.run` with the real harness root, loader, event store and run machine; the ops only record the reply,
// and the job registry only records a start. The state of T1.1 in each stored slice is computed here with the pure
// machine transition, independently of the command.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T13_FOLDER = "T1-release-notes.task/T1.3-markdown-render.task"
const T13 = `${SPEC}/${T13_FOLDER}`
const R12 = `R12 ${T13_FOLDER}: T1.3 is after T1.1, which is outside this run and not trusted`
const REFUSED = [
  `Refused ${T13}: 1 failure. No work started.`,
  R12,
  "Run the whole spec, or a folder that holds T1.1.",
].join("\n")
const STARTED = "Implementing **T1.3 Render the release notes as Markdown** from spec"

// The facts of an aggregate, oldest first.
const factsOf = (aggregate: string) =>
  Effect.gen(function* () {
    const db = yield* Database.Service
    return yield* TaskEvents.read(db.db, aggregate)
  })

// Stored slices on the run's aggregate, oldest first.
const publish = (directory: string, ...slices: ReadonlyArray<ReadonlyArray<Fact>>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    for (const fact of slices.flat()) yield* TaskEvents.publish(events, TaskEvents.runID(directory, SPEC), fact)
  })

const textOf = (inputs: ReadonlyArray<{ readonly parts: ReadonlyArray<{ readonly text: string }> }>) =>
  inputs.map((input) => input.parts.map((part) => part.text).join("\n"))

// `/task <args>` in the instance: its replies and the jobs it started.
const task = (harness: TaskHarness.Interface, args: string) =>
  Effect.gen(function* () {
    const jobs = jobsOf()
    const replies = textOf(yield* runTaskInputs(harness, args, jobs))
    return { replies, jobs }
  })

// The release-notes spec seeded, and the plans of the whole spec and of the T1.3 subtree.
const given = Effect.gen(function* () {
  const directory = yield* seed(SPEC)
  const whole = yield* loadPlan("release-notes.spec")
  const subtree = yield* loadPlan("release-notes.spec", "T1.3")
  // T1.1 is a folder task outside the T1.3 subtree: an external region of its plan, not an outside precondition.
  expect(subtree.tasks.map((task) => task.id)).toEqual(["T1.3"])
  expect(subtree.external).toEqual(["T1.1"])
  expect("T1.1" in whole.spec.outside).toBe(false)
  expect(whole.tasks.some((task) => task.id === "T1.1")).toBe(true)
  return { directory, whole }
})

// The state of T1.1 when a whole-spec slice folds through the whole-spec plan.
const t11 = (whole: Plan, slice: ReadonlyArray<Fact>) => unitState(fold(whole, slice), "T1.1")

it.instance(
  "[VF21] /task trust T1.1 typed and no stored slice: /task on the T1.3 task folder is refused with the R12 line for T1.3 and T1.1",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* given
      const harness = yield* TaskHarness.make

      // Given /task trust T1.1 was typed: the reply, and the trust on the directory's aggregate.
      const trust = yield* task(harness, "trust T1.1")
      expect(trust.replies).toEqual(["Task harness: recorded the outside precondition T1.1 as trusted."])
      expect(TaskEvents.trustedOutside(yield* factsOf(TaskEvents.directoryID(directory)))).toEqual(["T1.1"])
      // And no stored slice: the run's aggregate is empty.
      expect(yield* factsOf(TaskEvents.runID(directory, SPEC))).toEqual([])

      // When /task runs on the T1.3 task folder.
      const run = yield* task(harness, T13)

      // Then it is refused at the start with the R12 line for T1.3 and T1.1.
      expect(run.replies).toEqual([REFUSED])
      expect(run.jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
      expect(yield* factsOf(TaskEvents.runID(directory, SPEC))).toEqual([])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: T13, reason: R12 })
    }),
  { git: true },
)

it.instance(
  "[VF21] /task trust T1.1 typed and a stored slice in which T1.1 is not trusted: the T1.3 run is still refused with the R12 line",
  () =>
    Effect.gen(function* () {
      const { directory, whole } = yield* given
      const f = facts()
      // A whole-spec slice in which T1.1 started and proved ready, but was never verified.
      const slice = [f.runStarted(SPEC), f.started("T1.1"), f.ready("T1.1")]
      expect(t11(whole, slice)).not.toBe("trusted")
      yield* publish(directory, slice)
      const harness = yield* TaskHarness.make
      expect((yield* task(harness, "trust T1.1")).replies).toEqual([
        "Task harness: recorded the outside precondition T1.1 as trusted.",
      ])

      const run = yield* task(harness, T13)

      expect(run.replies).toEqual([REFUSED])
      expect(run.jobs.starts).toEqual([])
    }),
  { git: true },
)

// A newer whole-spec slice in which T1.1 ends cancelled, two ways.
const CANCELLED: ReadonlyArray<{
  readonly name: string
  readonly slice: (whole: Plan, f: Facts) => ReadonlyArray<Fact>
}> = [
  {
    name: "T1.1 trusted again, reopened by a stale obligation, then the run cancelled",
    slice: (whole, f) => [
      f.runStarted(SPEC),
      ...trustLeaf(whole, f, "T1.1"),
      f.stale("T1.1.c1"),
      f.cancelled("user stop"),
    ],
  },
  {
    name: "T1.1 started, then the run cancelled",
    slice: (_whole, f) => [f.runStarted(SPEC), f.started("T1.1"), f.cancelled("user stop")],
  },
]

for (const item of CANCELLED) {
  it.instance(
    `[VF21] an older slice with T1.1 trusted and a newer slice where T1.1 ended cancelled (${item.name}): the T1.3 run is refused`,
    () =>
      Effect.gen(function* () {
        const { directory, whole } = yield* given
        const f = facts()
        const older = [f.runStarted(SPEC), ...trustLeaf(whole, f, "T1.1")]
        const newer = item.slice(whole, facts(100))
        // The older slice folds T1.1 trusted; the newer one folds it cancelled.
        expect(t11(whole, older)).toBe("trusted")
        expect(t11(whole, newer)).toBe("cancelled")
        yield* publish(directory, older, newer)
        expect(TaskEvents.slices(yield* factsOf(TaskEvents.runID(directory, SPEC)))).toHaveLength(2)

        const harness = yield* TaskHarness.make
        const run = yield* task(harness, T13)

        expect(run.replies).toEqual([REFUSED])
        expect(run.jobs.starts).toEqual([])
        expect(yield* harness.live(directory)).toEqual(Option.none())
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: T13, reason: R12 })
      }),
    { git: true },
  )
}

it.instance(
  "[VF21] control: the older slice with T1.1 trusted, stored alone, lets the T1.3 run start",
  () =>
    Effect.gen(function* () {
      const { directory, whole } = yield* given
      const f = facts()
      yield* publish(directory, [f.runStarted(SPEC), ...trustLeaf(whole, f, "T1.1")])

      const run = yield* task(yield* TaskHarness.make, T13)

      expect(run.replies).toHaveLength(1)
      expect(run.replies[0]).toStartWith(STARTED)
      expect(run.jobs.starts).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "[VF21] an old slice that has no path and T1.1 trusted counts as a whole-spec slice: the T1.3 run starts",
  () =>
    Effect.gen(function* () {
      const { directory, whole } = yield* given
      const f = facts()
      // A slice stored before run.started had a path: no path on its first fact; T1.1 trusted; the run ended done.
      const old = [f.runStarted(), ...trustLeaf(whole, f, "T1.1"), f.ended("done")]
      expect(t11(whole, old)).toBe("trusted")
      yield* publish(directory, old)
      const stored = yield* factsOf(TaskEvents.runID(directory, SPEC))
      expect(stored[0]?.type).toBe("run.started")
      expect(stored[0] !== undefined && "path" in stored[0] && stored[0].path !== undefined).toBe(false)

      const harness = yield* TaskHarness.make
      const run = yield* task(harness, T13)

      // The run starts: the start message, no R12 line, and the run's job.
      expect(run.replies).toHaveLength(1)
      expect(run.replies[0]).toStartWith(STARTED)
      expect(run.replies[0]).not.toContain("R12")
      expect(run.jobs.starts).toHaveLength(1)
      expect(run.jobs.starts[0]?.id).toBe(TaskEvents.runID(directory, SPEC))
    }),
  { git: true },
)

it.instance(
  "[VF21] control: the same old slice with no path but T1.1 not trusted is refused with the R12 line",
  () =>
    Effect.gen(function* () {
      const { directory, whole } = yield* given
      const f = facts()
      const old = [f.runStarted(), f.started("T1.1"), f.ended("done")]
      expect(t11(whole, old)).not.toBe("trusted")
      yield* publish(directory, old)

      const run = yield* task(yield* TaskHarness.make, T13)

      expect(run.replies).toEqual([REFUSED])
      expect(run.jobs.starts).toEqual([])
    }),
  { git: true },
)

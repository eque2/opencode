import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, fold, loadPlan, obligationsOf, trustLeaf, unitState } from "./lib/machine"
import { git, jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF20 (spec task-harness-feedback, D13, AD-15, SD-13, @ASSUMPTION:A3.a): the latest slice decides the trust
// of a folder task outside a subtree run.
//
//   Given a slice in which T1.1 ended trusted, then a later slice in which T1.1 is budget exhausted
//   When /task runs on the T1.3 task folder
//   Then it is refused with the R12 line that names T1.3 and T1.1
//
// The spec is a committed copy of release-notes.spec in a git instance. `/task` is the real `TaskCommand.run` with
// the real harness root, loader, event store and run machine; the ops only record the reply, and the job registry
// only records a start. The state of T1.1 in each stored slice is computed here with the pure machine transition,
// independently of the command.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T13_FOLDER = "T1-release-notes.task/T1.3-markdown-render.task"
const T13 = `${SPEC}/${T13_FOLDER}`
const R12 = `R12 ${T13_FOLDER}: T1.3 is after T1.1, which is outside this run and not trusted`
const HINT = "Run the whole spec, or a folder that holds T1.1."
const STARTED = "Implementing **T1.3 Render the release notes as Markdown** from spec"

// The facts stored on the run's aggregate for the seeded spec, oldest first.
const storedOf = (directory: string) =>
  Effect.gen(function* () {
    const db = yield* Database.Service
    return yield* TaskEvents.read(db.db, TaskEvents.runID(directory, SPEC))
  })

// Stored slices on the run's aggregate, oldest first.
const publish = (directory: string, ...slices: ReadonlyArray<ReadonlyArray<Fact>>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    for (const fact of slices.flat()) yield* TaskEvents.publish(events, TaskEvents.runID(directory, SPEC), fact)
  })

const textOf = (inputs: ReadonlyArray<{ readonly parts: ReadonlyArray<{ readonly text: string }> }>) =>
  inputs.map((input) => input.parts.map((part) => part.text).join("\n"))

// A whole-spec slice in which T1.1 is built, proved and verified: it ends trusted.
const trustedSlice = (whole: Plan): ReadonlyArray<Fact> => {
  const f = facts()
  return [f.runStarted(SPEC), ...trustLeaf(whole, f, "T1.1")]
}

// A later whole-spec slice in which T1.1 fails its proof on each of its three attempts: it ends budget exhausted.
const exhaustedSlice = (): ReadonlyArray<Fact> => {
  const f = facts(100)
  return [f.runStarted(SPEC), ...exhaustLeaf(f, "T1.1", "T1.1.c1")]
}

// The given: two whole-spec slices of the seeded spec, and what each folds T1.1 to.
const given = Effect.gen(function* () {
  const directory = yield* seed(SPEC)
  const loaded = yield* Blend.load(path.join(directory, SPEC))
  expect(loaded.failures).toEqual([])
  expect(loaded.spec?.tasks.find((task) => task.id === "T1.3")?.after).toEqual(["T1.1"])
  const whole = yield* loadPlan("release-notes.spec")
  const subtree = yield* loadPlan("release-notes.spec", "T1.3")
  // T1.1 is a folder task outside the T1.3 subtree: an external region of its plan, not an outside precondition.
  expect(subtree.tasks.map((task) => task.id)).toEqual(["T1.3"])
  expect(subtree.external).toEqual(["T1.1"])
  expect("T1.1" in subtree.spec.outside).toBe(false)
  // T1.1 has the obligation the exhausted slice fails, and a budget of three attempts.
  expect(obligationsOf(whole, "T1.1")).toContain("T1.1.c1")
  expect(whole.budget("T1.1")).toBe(3)

  const trusted = trustedSlice(whole)
  const exhausted = exhaustedSlice()
  // Each slice holds T1.1 in its own (whole-spec) plan; folded on its own, T1.1 ends trusted in the first and budget
  // exhausted in the second.
  expect(whole.tasks.some((task) => task.id === "T1.1")).toBe(true)
  expect(unitState(fold(whole, trusted), "T1.1")).toBe("trusted")
  expect(unitState(fold(whole, exhausted), "T1.1")).toBe("budget_exhausted")
  return { directory, trusted, exhausted }
})

it.instance(
  "[VF20] T1.1 trusted in one slice, then budget exhausted in a later slice: /task on the T1.3 task folder is refused with the R12 line naming T1.3 and T1.1",
  () =>
    Effect.gen(function* () {
      const { directory, trusted, exhausted } = yield* given
      yield* publish(directory, trusted, exhausted)

      // Two stored slices, oldest first: the trusted one, then the budget-exhausted one.
      const stored = yield* storedOf(directory)
      expect(stored).toHaveLength(trusted.length + exhausted.length)
      expect(TaskEvents.slices(stored)).toEqual([trusted, exhausted])
      const worktrees = yield* git(directory, "worktree", "list", "--porcelain")

      // When /task runs on the T1.3 task folder.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, T13, jobs)

      // Then: one session message with no model turn: the counted header, the one R12 line, then the hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      expect(textOf(inputs)).toEqual([[`Refused ${T13}: 1 failure. No work started.`, R12, HINT].join("\n")])
      // The R12 line has the form of assumption A3.a, and names T1.3's folder relative to the spec.
      const line = (textOf(inputs)[0] ?? "").split("\n")[1] ?? ""
      expect(line).toMatch(/^R12 (\S+): T1\.3 is after T1\.1, which is outside this run and not trusted$/)
      expect(line.slice(4, line.indexOf(": "))).toBe(
        path.relative(path.join(directory, SPEC), path.join(directory, T13)),
      )

      // Refused at the start: no job, no lease, no new fact, no worktree; the status file holds the R12 line.
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
      expect(yield* storedOf(directory)).toEqual(stored)
      expect(yield* git(directory, "worktree", "list", "--porcelain")).toBe(worktrees)
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: T13, reason: R12 })
    }),
  { git: true },
)

it.instance(
  "[VF20] the latest slice decides, not any slice: the same two slices stored in the other order let the T1.3 run start",
  () =>
    Effect.gen(function* () {
      const { directory, trusted, exhausted } = yield* given
      // The budget-exhausted slice first, then the trusted one: now the trusted slice is the latest.
      yield* publish(directory, exhausted, trusted)
      expect(TaskEvents.slices(yield* storedOf(directory))).toEqual([exhausted, trusted])

      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const replies = textOf(yield* runTaskInputs(harness, T13, jobs))

      // The latest slice holds T1.1 trusted: no refusal, and the run's job starts.
      expect(replies).toHaveLength(1)
      expect(replies[0]).toStartWith(STARTED)
      expect(replies[0]).not.toContain("R12")
      expect(jobs.starts).toHaveLength(1)
      expect(jobs.starts[0]?.id).toBe(TaskEvents.runID(directory, SPEC))
    }),
  { git: true },
)

it.instance(
  "[VF20] only the budget-exhausted slice stored: the T1.3 run is refused with the same R12 line",
  () =>
    Effect.gen(function* () {
      const { directory, exhausted } = yield* given
      yield* publish(directory, exhausted)

      const jobs = jobsOf()
      const replies = textOf(yield* runTaskInputs(yield* TaskHarness.make, T13, jobs))

      expect(replies).toEqual([[`Refused ${T13}: 1 failure. No work started.`, R12, HINT].join("\n")])
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
)

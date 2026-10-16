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
import { facts, fold, loadPlan, trustLeaf, unitState } from "./lib/machine"
import { git, jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF6 (spec task-harness-feedback, D13, AD-14, AD-15): a subtree run after an untrusted folder task outside
// it is refused at the start.
//
//   Given the release-notes spec with no stored run
//   When /task runs on the T1.3 task folder, which is after T1.1
//   Then the run is refused before any work
//   And the refusal line names T1.3 and T1.1 as "R12 <folder>: T1.3 is after T1.1, which is outside this run and not trusted"
//   And the trust of T1.1 is read by folding the stored slices through their own plans
//
// The spec is a committed copy of release-notes.spec in a git instance. `/task` is the real `TaskCommand.run` with
// the real harness root, loader, event store and run machine; the ops only record the reply, and the job registry
// only records a start. The expected trust of each stored slice is computed here by folding the slice through the
// plan of its own path with the pure machine transition, independently of the command.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T13_FOLDER = "T1-release-notes.task/T1.3-markdown-render.task"
const T13 = `${SPEC}/${T13_FOLDER}`
const R12 = `R12 ${T13_FOLDER}: T1.3 is after T1.1, which is outside this run and not trusted`
const HINT = "Run the whole spec, or a folder that holds T1.1."
const STARTED = "Implementing **T1.3 Render the release notes as Markdown** from spec"

// The facts stored on the run's aggregate for the seeded spec.
const storedOf = (directory: string) =>
  Effect.gen(function* () {
    const db = yield* Database.Service
    return yield* TaskEvents.read(db.db, TaskEvents.runID(directory, SPEC))
  })

const publish = (directory: string, slice: ReadonlyArray<Fact>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    for (const fact of slice) yield* TaskEvents.publish(events, TaskEvents.runID(directory, SPEC), fact)
  })

const textOf = (inputs: ReadonlyArray<{ readonly parts: ReadonlyArray<{ readonly text: string }> }>) =>
  inputs.map((input) => input.parts.map((part) => part.text).join("\n"))

it.instance(
  "[VF6] with no stored run, /task on the T1.3 task folder is refused before any work with the R12 line naming T1.3 and T1.1",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)

      // Given: the release-notes spec loads clean; T1.3 is after T1.1; T1.1 is a folder task outside the T1.3 subtree.
      const loaded = yield* Blend.load(path.join(directory, SPEC))
      expect(loaded.failures).toEqual([])
      expect(loaded.spec?.tasks.find((task) => task.id === "T1.3")?.after).toEqual(["T1.1"])
      const subtree = yield* loadPlan("release-notes.spec", "T1.3")
      expect(subtree.tasks.map((task) => task.id)).toEqual(["T1.3"])
      expect(subtree.external).toEqual(["T1.1"])
      expect("T1.1" in subtree.spec.outside).toBe(false)
      // No stored run.
      expect(yield* storedOf(directory)).toEqual([])
      const worktrees = yield* git(directory, "worktree", "list", "--porcelain")

      // When /task runs on the T1.3 task folder.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, T13, jobs)

      // Then: one session message, sent with no model turn: the counted header, one R12 line, then the hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      expect(textOf(inputs)).toEqual([[`Refused ${T13}: 1 failure. No work started.`, R12, HINT].join("\n")])
      // The R12 line has the Gherkin's form, and its folder is T1.3's folder relative to the spec.
      const line = (textOf(inputs)[0] ?? "").split("\n")[1] ?? ""
      expect(line).toMatch(/^R12 (\S+): T1\.3 is after T1\.1, which is outside this run and not trusted$/)
      expect(line.slice(4, line.indexOf(": "))).toBe(
        path.relative(path.join(directory, SPEC), path.join(directory, T13)),
      )

      // Refused before any work: no job, no lease, no fact on the run's aggregate, no worktree.
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
      expect(yield* storedOf(directory)).toEqual([])
      expect(yield* git(directory, "worktree", "list", "--porcelain")).toBe(worktrees)

      // The status file records the refusal: the reason is the R12 line alone.
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: T13, reason: R12 })
    }),
  { git: true },
)

// Stored slices that each hold T1.1, and how T1.1's trust folds through the plan of the slice's own path.
interface Case {
  readonly name: string
  /** The plan of the slice's own path: the whole spec, or the T1.3 subtree. */
  readonly own: "whole" | "T1.3"
  readonly slice: (plan: Plan, branch: string) => ReadonlyArray<Fact>
  readonly trusted: boolean
}

const CASES: ReadonlyArray<Case> = [
  {
    name: "a whole-spec slice in which T1.1 ended trusted",
    own: "whole",
    slice: (plan) => {
      const f = facts()
      return [f.runStarted(SPEC), ...trustLeaf(plan, f, "T1.1")]
    },
    trusted: true,
  },
  {
    name: "a whole-spec slice in which T1.1 was trusted, then its obligation went stale",
    own: "whole",
    slice: (plan) => {
      const f = facts()
      return [f.runStarted(SPEC), ...trustLeaf(plan, f, "T1.1"), f.stale("T1.1.c1")]
    },
    trusted: false,
  },
  {
    name: "a whole-spec slice with outside.trusted T1.1, which a task region does not take",
    own: "whole",
    slice: () => {
      const f = facts()
      return [f.runStarted(SPEC), f.outside("T1.1")]
    },
    trusted: false,
  },
  {
    name: "a T1.3-subtree slice with outside.trusted T1.1, which its external region takes",
    own: "T1.3",
    slice: (_plan, branch) => [
      { type: "run.started", at: 1, base: branch, path: T13 },
      { type: "outside.trusted", at: 2, id: "T1.1" },
    ],
    trusted: true,
  },
]

for (const item of CASES) {
  it.instance(
    `[VF6] the trust of T1.1 is read by folding each stored slice through its own plan: ${item.name}`,
    () =>
      Effect.gen(function* () {
        const directory = yield* seed(SPEC)
        const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
        const whole = yield* loadPlan("release-notes.spec")
        const own = item.own === "whole" ? whole : yield* loadPlan("release-notes.spec", "T1.3")
        const slice = item.slice(whole, branch.trim())

        // The slice's own plan holds T1.1, and the pure fold through that plan gives the expected trust.
        expect(own.tasks.some((task) => task.id === "T1.1") || own.external.includes("T1.1")).toBe(true)
        expect(unitState(fold(own, slice), "T1.1") === "trusted").toBe(item.trusted)
        yield* publish(directory, slice)
        expect(yield* storedOf(directory)).toHaveLength(slice.length)

        const jobs = jobsOf()
        const replies = textOf(yield* runTaskInputs(yield* TaskHarness.make, T13, jobs))

        if (item.trusted) {
          // T1.1 folds trusted: the run starts.
          expect(replies).toHaveLength(1)
          expect(replies[0]).toStartWith(STARTED)
          expect(jobs.starts).toHaveLength(1)
          return
        }
        // T1.1 does not fold trusted: refused at the start with the R12 line, before any work.
        expect(replies).toEqual([[`Refused ${T13}: 1 failure. No work started.`, R12, HINT].join("\n")])
        expect(jobs.starts).toEqual([])
        expect(yield* storedOf(directory)).toHaveLength(slice.length)
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: T13, reason: R12 })
      }),
    { git: true },
  )
}

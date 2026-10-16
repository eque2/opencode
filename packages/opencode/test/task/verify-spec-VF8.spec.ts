import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, runTaskInputs, SPEC, seed } from "./lib/command"

// Scenario VF8 (spec task-harness-feedback, D13, D17, AD-15): a subtree run names the scenarios it leaves out.
//
//   Given the release-notes spec
//   When /task runs on a task folder whose scenarios need tasks outside it
//   Then the run's first message names each left-out scenario
//   And the header metadata lists the same ids
//
// The spec is a committed copy of release-notes.spec in a git instance. `/task` is the real `TaskCommand.run` with
// the real harness root and loader; the ops record each message the command sends, and the job registry only records
// a start. The expected ids come from the scenarios' own `needs` in the loaded spec: a scenario is left out when it
// needs a task that is neither in the run nor an outside precondition. Each case also pins the ids read by hand from
// the acceptance files, so the test does not share the command's rule alone.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const TITLE = "Release notes from conventional commits"

interface Case {
  /** The task folder under the spec, or "" for the whole spec. */
  readonly folder: string
  /** The run's task ids, as the subtree holds them. */
  readonly tasks: ReadonlyArray<string>
  /** The folder task's title, from its TASK.md. */
  readonly title: string
  /** The left-out ids, read by hand from `acceptance/*.md` `needs`. */
  readonly leftOut: ReadonlyArray<string>
}

const CASES: ReadonlyArray<Case> = [
  {
    folder: "T1-release-notes.task/T1.1-commit-parser.task",
    tasks: ["T1.1"],
    title: "Parse a conventional-commit message",
    // S2 and S7 need only T1.1; every other scenario needs a task outside the T1.1 folder.
    leftOut: ["S1", "S3", "S4", "S5", "S6", "S8", "S9", "S10", "S11", "S12", "S13"],
  },
  {
    folder: "T1-release-notes.task/T1.2-version-bump.task",
    tasks: ["T1.2"],
    title: "Compute the next version",
    // Only S3 needs T1.2 alone.
    leftOut: ["S1", "S2", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"],
  },
]

// The scenarios of the loaded spec that need a task outside `tasks` that is not an outside precondition.
const leftOutOf = (directory: string, tasks: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const loaded = yield* Blend.load(path.join(directory, SPEC))
    const spec = loaded.spec
    if (spec === undefined) return yield* Effect.die(new Error("the release-notes spec did not load"))
    const outside = (id: string) => id in spec.outside
    return {
      all: spec.scenarios.map((scenario) => scenario.id),
      leftOut: spec.scenarios
        .filter((scenario) => scenario.needs.some((id) => !tasks.includes(id) && !outside(id)))
        .map((scenario) => scenario.id),
    }
  })

for (const item of CASES) {
  it.instance(
    `[VF8] /task on ${item.folder.split("/").at(-1)}: the first message names each left-out scenario and the header metadata lists the same ids`,
    () =>
      Effect.gen(function* () {
        const directory = yield* seed(SPEC)
        const typed = `${SPEC}/${item.folder}`

        // Given: the scenarios this folder leaves out, from their own `needs`; some are left out, some are kept.
        const { all, leftOut } = yield* leftOutOf(directory, item.tasks)
        expect(leftOut.toSorted()).toEqual([...item.leftOut].toSorted())
        expect(leftOut.length).toBeGreaterThan(0)
        expect(leftOut.length).toBeLessThan(all.length)
        const kept = all.filter((id) => !leftOut.includes(id))

        // When /task runs on the task folder: it is not refused, and its job starts.
        const jobs = jobsOf()
        const inputs = yield* runTaskInputs(yield* TaskHarness.make, typed, jobs)
        expect(jobs.starts).toHaveLength(1)

        // Then: the run's first message names each left-out scenario, and no scenario the run keeps.
        expect(inputs.length).toBeGreaterThanOrEqual(1)
        const first = inputs[0]
        expect(first?.noReply).toBe(true)
        expect(first?.parts).toHaveLength(1)
        const part = first?.parts[0]
        const lines = (part?.text ?? "").split("\n")
        const head = `Implementing **${item.tasks[0]} ${item.title}** from spec **${TITLE}**`
        expect(lines).toEqual([head, `Left out: ${leftOut.join(", ")} — they need tasks outside this run.`])
        const named = (lines[1] ?? "").replace(/^Left out: /, "").replace(/ — they need tasks outside this run\.$/, "")
        expect(named.split(", ").toSorted()).toEqual([...item.leftOut].toSorted())
        for (const id of kept) expect(named.split(", ")).not.toContain(id)

        // And the header metadata lists the same ids, in the same order as the message.
        expect(part?.metadata).toEqual({
          taskHarness: {
            header: {
              spec: { id: "release-notes.spec", title: TITLE },
              task: { id: item.tasks[0], title: item.title },
              leftOut,
            },
          },
        })
      }),
    { git: true },
  )
}

it.instance(
  "[VF8] control: the whole spec leaves no scenario out, so the first message has no Left out line and leftOut is empty",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const harness = yield* TaskHarness.make
      const tasks = (yield* Blend.load(path.join(directory, SPEC))).spec?.tasks.map((task) => task.id) ?? []
      expect((yield* leftOutOf(directory, tasks)).leftOut).toEqual([])

      const whole = yield* runTaskInputs(harness, SPEC, jobsOf())
      expect(whole[0]?.parts[0]?.text).toBe(`Implementing spec **${TITLE}**`)
      expect(whole[0]?.parts[0]?.metadata).toEqual({
        taskHarness: { header: { spec: { id: "release-notes.spec", title: TITLE }, leftOut: [] } },
      })
    }),
  { git: true },
)

it.instance(
  "[VF8] control: the T1 folder holds every task, so it leaves no scenario out",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const tasks = (yield* Blend.load(path.join(directory, SPEC))).spec?.tasks.map((task) => task.id) ?? []
      expect(tasks.every((id) => id === "T1" || id.startsWith("T1."))).toBe(true)
      expect((yield* leftOutOf(directory, tasks)).leftOut).toEqual([])

      const inputs = yield* runTaskInputs(yield* TaskHarness.make, `${SPEC}/T1-release-notes.task`, jobsOf())
      expect(inputs[0]?.parts[0]?.text).toBe(`Implementing **T1 Release notes tool** from spec **${TITLE}**`)
      expect(inputs[0]?.parts[0]?.metadata).toEqual({
        taskHarness: {
          header: {
            spec: { id: "release-notes.spec", title: TITLE },
            task: { id: "T1", title: "Release notes tool" },
            leftOut: [],
          },
        },
      })
    }),
  { git: true },
)

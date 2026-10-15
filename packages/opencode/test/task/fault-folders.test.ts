import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, refusalOf, runTask, seed } from "./lib/command"

// The fault folders (D14, AC 16), each refused by the real /task command on a committed copy in a git instance. The
// loader's lines for each folder are pinned in blend.test.ts; here the refusal must list exactly those lines.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const BLEND = "task-formats/blend"
// The rules each folder plants.
const PLANTED: Record<string, ReadonlyArray<string>> = {
  "example-format-faults.spec": ["R1", "R3", "R4"],
  "example-cycle.spec": ["R7"],
  "example-self-after.spec": ["R7"],
  "example-unknown-after.spec": ["R6"],
  "example-no-ensures.spec": ["R3"],
}

describe("the fault folders under /task (D14)", () => {
  for (const [name, rules] of Object.entries(PLANTED)) {
    it.instance(
      `${name} is refused with every planted rule and no other, and starts nothing`,
      () =>
        Effect.gen(function* () {
          const spec = `${BLEND}/${name}`
          const directory = yield* seed(spec)
          const loaded = yield* Blend.load(path.join(directory, spec))
          const lines = loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)
          expect(lines.map((line) => line.split(" ")[0])).toEqual([...rules])
          const harness = yield* TaskHarness.make
          const jobs = jobsOf()

          const replies = yield* runTask(harness, spec, jobs)

          const count = `${lines.length} ${lines.length === 1 ? "failure" : "failures"}`
          expect(replies).toEqual([
            [
              `Refused ${spec}: ${count}. No work started.`,
              ...lines,
              `Fix each line, then type /task ${spec} again.`,
            ].join("\n"),
          ])
          expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec, reason: lines.join("\n") })
          // A refusal resolves no session service: no job, no lease, no model request.
          expect(jobs.starts).toEqual([])
          expect(yield* harness.live(directory)).toEqual(Option.none())
        }),
      { git: true },
    )
  }

  it.instance(
    "example-outside-run.spec as the T1.2 subtree is refused with the R12 line naming T1.2 and T1.1 (VF14)",
    () =>
      Effect.gen(function* () {
        const spec = `${BLEND}/example-outside-run.spec`
        const subtree = `${spec}/T1-words.task/T1.2-shout.task`
        const directory = yield* seed(spec)
        const jobs = jobsOf()
        const line = "R12 T1-words.task/T1.2-shout.task: T1.2 is after T1.1, which is outside this run and not trusted"

        expect(yield* runTask(yield* TaskHarness.make, subtree, jobs)).toEqual([
          [
            `Refused ${subtree}: 1 failure. No work started.`,
            line,
            "Run the whole spec, or a folder that holds T1.1.",
          ].join("\n"),
        ])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec, path: subtree, reason: line })
        expect(jobs.starts).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "example-outside-run.spec as a whole spec is not refused: its job starts",
    () =>
      Effect.gen(function* () {
        const spec = `${BLEND}/example-outside-run.spec`
        yield* seed(spec)
        const jobs = jobsOf()
        const replies = yield* runTask(yield* TaskHarness.make, spec, jobs)
        expect(replies).toEqual([
          `Task harness: running ${spec} in the background. Its status is in .opencode/task/status.json.`,
        ])
        expect(jobs.starts).toHaveLength(1)
      }),
    { git: true },
  )
})

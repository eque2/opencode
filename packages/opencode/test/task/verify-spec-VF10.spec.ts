import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, refusalOf, runTaskInputs, seed } from "./lib/command"

// Scenario VF10 (spec task-harness-feedback, D10, D14, AC 16): the cycle folder is refused with the cycle named.
//
//   Given the example-cycle spec folder where T1.1 is after T1.2 and T1.2 is after T1.1
//   When /task runs on it
//   Then the refusal has an R7 line that names the cycle through T1.1 and T1.2
//
// The folder is a committed copy of task-formats/blend/example-cycle.spec in a git instance. `/task` is the real
// `TaskCommand.run` with the real harness root and the real loader; the ops only record the reply. The `after` keys
// are read from the files on disk, and the cycle the R7 line names is checked against them step by step.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC = "task-formats/blend/example-cycle.spec"
const T11 = "T1-words.task/T1.1-upper.task/TASK.md"
const T12 = "T1-words.task/T1.2-shout.task/TASK.md"
const R7 = `R7 ${T11}: order has a cycle: T1.1 → T1.2 → T1.1`

// The ids in a TASK.md's front-matter `after: [..]`.
const afterOf = (text: string) =>
  (/^after: \[([^\]]*)\]$/m.exec(text)?.[1] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")

// The cycle an R7 line names, as its ids in order.
const cycleOf = (line: string) => (/^R7 \S+: order has a cycle: (.+)$/.exec(line)?.[1] ?? "").split(" → ")

it.instance(
  "[VF10] the cycle folder is refused with one R7 line that names the cycle through T1.1 and T1.2",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)

      // Given: T1.1 is after T1.2 and T1.2 is after T1.1, in the files on disk.
      const after: Record<string, ReadonlyArray<string>> = {
        "T1.1": afterOf(yield* fs.readFileString(path.join(specDir, T11))),
        "T1.2": afterOf(yield* fs.readFileString(path.join(specDir, T12))),
      }
      expect(after).toEqual({ "T1.1": ["T1.2"], "T1.2": ["T1.1"] })
      // The loader finds that cycle and nothing else.
      const loaded = yield* Blend.load(specDir)
      expect(loaded.spec).toBeUndefined()
      expect(loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)).toEqual([R7])

      // When /task runs on it.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, SPEC, jobs)

      // Then: one message with no model turn: the counted header, the R7 line, then the hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      const message = (inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")
      expect(message).toEqual([
        `Refused ${SPEC}: 1 failure. No work started.`,
        R7,
        `Fix each line, then type /task ${SPEC} again.`,
      ])
      const lines = message.filter((line) => /^R\d+ /.test(line))
      expect(lines).toEqual([R7])

      // The R7 line names a closed cycle through exactly T1.1 and T1.2, and each step is an `after` of the file.
      const cycle = cycleOf(message[1] ?? "")
      expect(cycle).toEqual(["T1.1", "T1.2", "T1.1"])
      expect(cycle[0]).toBe(cycle.at(-1) ?? "")
      expect(new Set(cycle)).toEqual(new Set(["T1.1", "T1.2"]))
      for (const [index, id] of cycle.slice(0, -1).entries()) expect(after[id]).toContain(cycle[index + 1])

      // The status run reason is the R7 line; no job and no lease.
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: SPEC, reason: R7 })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

it.instance(
  "[VF10] /task on a task folder inside the cycle folder is refused with the same R7 line",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const typed = `${SPEC}/T1-words.task/T1.2-shout.task`
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, typed, jobs)
      expect(inputs).toHaveLength(1)
      expect((inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")).toEqual([
        `Refused ${typed}: 1 failure. No work started.`,
        R7,
        `Fix each line, then type /task ${typed} again.`,
      ])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: typed, reason: R7 })
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
)

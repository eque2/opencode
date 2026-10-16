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

// Scenario VF11 (spec task-harness-feedback, D10, D14, AC 16): the self-after folder is refused.
//
//   Given the example-self-after spec folder where T1.1 is after T1.1
//   When /task runs on it
//   Then the refusal has an R7 line that names the cycle T1.1 → T1.1
//
// The folder is a committed copy of task-formats/blend/example-self-after.spec in a git instance. `/task` is the real
// `TaskCommand.run` with the real harness root and the real loader; the ops only record the reply. The `after` keys
// are read from the files on disk, and the cycle the R7 line names is checked against them.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC = "task-formats/blend/example-self-after.spec"
const T11 = "T1-words.task/T1.1-upper.task/TASK.md"
const T12 = "T1-words.task/T1.2-shout.task/TASK.md"
const R7 = `R7 ${T11}: order has a cycle: T1.1 → T1.1`

// The ids in a TASK.md's front-matter `after: [..]`.
const afterOf = (text: string) =>
  (/^after: \[([^\]]*)\]$/m.exec(text)?.[1] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")

// The cycle an R7 line names, as its ids in order.
const cycleOf = (line: string) => (/^R7 \S+: order has a cycle: (.+)$/.exec(line)?.[1] ?? "").split(" → ")

it.instance(
  "[VF11] the self-after folder is refused with one R7 line that names the cycle T1.1 → T1.1",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)

      // Given: T1.1 is after T1.1, in the file on disk; T1.2 is after T1.1, which is no cycle.
      const after: Record<string, ReadonlyArray<string>> = {
        "T1.1": afterOf(yield* fs.readFileString(path.join(specDir, T11))),
        "T1.2": afterOf(yield* fs.readFileString(path.join(specDir, T12))),
      }
      expect(after).toEqual({ "T1.1": ["T1.1"], "T1.2": ["T1.1"] })
      // The loader finds that one-step cycle and nothing else.
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

      // The R7 line names the cycle T1.1 → T1.1: it starts and ends at T1.1, holds no other id, and its one step is
      // the `after` edge T1.1 → T1.1 of the file on disk.
      const cycle = cycleOf(message[1] ?? "")
      expect(cycle).toEqual(["T1.1", "T1.1"])
      expect(new Set(cycle)).toEqual(new Set(["T1.1"]))
      expect(after["T1.1"]).toContain(cycle[1])
      expect(message[1]).toStartWith(`R7 ${T11}:`)

      // The status run reason is the R7 line; no job and no lease.
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: SPEC, reason: R7 })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

it.instance(
  "[VF11] /task on a task folder inside the self-after folder is refused with the same R7 line",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const typed = `${SPEC}/T1-words.task/T1.1-upper.task`
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

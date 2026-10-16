import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, refusalOf, runTaskInputs, seed } from "./lib/command"

// Scenario VF14 (spec task-harness-feedback, D13, D14, AD-15, AC 15, AC 16, @ASSUMPTION:A3.a): the outside-run folder
// is refused when run as the T1.2 subtree.
//
//   Given the example-outside-run spec folder where T1.2 is after T1.1
//   When the whole spec loads
//   Then it has no failure
//   And /task on the T1.2 task folder is refused at the start with the R12 line that names T1.2 and T1.1
//
// The folder is a committed copy of task-formats/blend/example-outside-run.spec in a git instance with no stored run.
// The whole spec is loaded by the real loader; `/task` is the real `TaskCommand.run` with the real harness root, the
// real loader and the real D13 trust walk over the (empty) event store; the ops only record the reply.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC = "task-formats/blend/example-outside-run.spec"
const T11 = "T1-words.task/T1.1-upper.task"
const T12 = "T1-words.task/T1.2-shout.task"
const SUBTREE = `${SPEC}/${T12}`
const R12 = `R12 ${T12}: T1.2 is after T1.1, which is outside this run and not trusted`

// The ids in a TASK.md's front-matter `after: [..]`.
const afterOf = (text: string) =>
  (/^after: \[([^\]]*)\]$/m.exec(text)?.[1] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")

it.instance(
  "[VF14] the whole outside-run spec loads with no failure, and /task on the T1.2 folder is refused at the start with the R12 line naming T1.2 and T1.1",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const db = yield* Database.Service
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)

      // Given: T1.2 is after T1.1 in the files on disk, and T1.1's folder is not inside T1.2's.
      expect(afterOf(yield* fs.readFileString(path.join(specDir, T12, "TASK.md")))).toEqual(["T1.1"])
      expect(afterOf(yield* fs.readFileString(path.join(specDir, T11, "TASK.md")))).toEqual([])
      expect(path.relative(path.join(specDir, T12), path.join(specDir, T11))).toStartWith("..")

      // When the whole spec loads, then it has no failure: the plan holds T1, T1.1 and T1.2 after T1.1.
      const loaded = yield* Blend.load(specDir)
      expect(loaded.failures).toEqual([])
      const spec = loaded.spec
      if (!spec) throw new Error("example-outside-run.spec did not load")
      expect(spec.tasks.map((task) => [task.id, task.after])).toEqual([
        ["T1", []],
        ["T1.1", []],
        ["T1.2", ["T1.1"]],
      ])
      expect(spec.outside).toEqual({})

      // No stored run: nothing records T1.1 as trusted.
      const id = TaskEvents.runID(directory, SPEC)
      expect(yield* TaskEvents.read(db.db, id)).toEqual([])

      // And /task on the T1.2 task folder.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, SUBTREE, jobs)

      // It is refused: one message with no model turn: the counted header, the R12 line, then the subtree hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      const message = (inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")
      expect(message).toEqual([
        `Refused ${SUBTREE}: 1 failure. No work started.`,
        R12,
        "Run the whole spec, or a folder that holds T1.1.",
      ])
      const lines = message.filter((line) => /^R\d+ /.test(line))
      expect(lines).toEqual([R12])
      // The R12 line is on T1.2's folder and names T1.2 and T1.1.
      const named = /^R12 (\S+): (\S+) is after (\S+), which is outside this run and not trusted$/.exec(lines[0] ?? "")
      expect(named?.slice(1)).toEqual([T12, "T1.2", "T1.1"])

      // At the start: the status run is refused with that line, and no job, no lease and no run fact exist.
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: SUBTREE, reason: R12 })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
      expect(yield* TaskEvents.read(db.db, id)).toEqual([])
    }),
  { git: true },
)

it.instance(
  "[VF14] /task on the whole outside-run spec is not refused: its job starts",
  () =>
    Effect.gen(function* () {
      yield* seed(SPEC)
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, SPEC, jobs)
      expect(inputs).toHaveLength(1)
      const text = inputs[0]?.parts.map((part) => part.text).join("\n") ?? ""
      expect(text).not.toContain("Refused")
      expect(text).toStartWith("Implementing spec **Word helpers (a subtree run with a folder task outside it)**")
      expect(jobs.starts).toHaveLength(1)
    }),
  { git: true },
)

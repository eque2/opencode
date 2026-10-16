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

// Scenario VF12 (spec task-harness-feedback, D10, D14, AC 16): the unknown-after folder is refused.
//
//   Given the example-unknown-after spec folder whose after names T7, which does not exist
//   When /task runs on it
//   Then the refusal has an R6 line that names T7
//
// The folder is a committed copy of task-formats/blend/example-unknown-after.spec in a git instance. `/task` is the
// real `TaskCommand.run` with the real harness root and the real loader; the ops only record the reply. That T7 does
// not exist is read from the files on disk: no `.task` folder has that id and SPEC.md declares no `outside` task.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC = "task-formats/blend/example-unknown-after.spec"
const T11 = "T1-words.task/T1.1-upper.task/TASK.md"
const R6 = `R6 ${T11}: after names unknown task T7`

// The ids in a TASK.md's front-matter `after: [..]`.
const afterOf = (text: string) =>
  (/^after: \[([^\]]*)\]$/m.exec(text)?.[1] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")

// The front matter of a file: the lines between the first two `---` lines.
const frontOf = (text: string) => /^---\n([\s\S]*?)\n?---\n/.exec(text)?.[1] ?? ""

it.instance(
  "[VF12] the unknown-after folder is refused with one R6 line that names T7",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)

      // Given: T1.1's `after` names T7, in the file on disk.
      expect(afterOf(yield* fs.readFileString(path.join(specDir, T11)))).toEqual(["T7"])
      // T7 does not exist: the spec's task folders are T1, T1.1 and T1.2, and SPEC.md declares no outside task.
      const entries = yield* fs.readDirectory(specDir, { recursive: true })
      const ids = entries
        .map((entry) => /^(T\d+(?:\.\d+)*)-[^/]*\.task$/.exec(path.basename(entry))?.[1])
        .filter((id): id is string => id !== undefined)
        .toSorted()
      expect(ids).toEqual(["T1", "T1.1", "T1.2"])
      expect(ids).not.toContain("T7")
      const front = frontOf(yield* fs.readFileString(path.join(specDir, "SPEC.md")))
      expect(front).toContain("format: task-spec/1")
      expect(front).not.toMatch(/^outside:/m)
      // The loader finds that one unknown reference and nothing else.
      const loaded = yield* Blend.load(specDir)
      expect(loaded.spec).toBeUndefined()
      expect(loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)).toEqual([R6])

      // When /task runs on it.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, SPEC, jobs)

      // Then: one message with no model turn: the counted header, the R6 line, then the hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      const message = (inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")
      expect(message).toEqual([
        `Refused ${SPEC}: 1 failure. No work started.`,
        R6,
        `Fix each line, then type /task ${SPEC} again.`,
      ])
      const lines = message.filter((line) => /^R\d+ /.test(line))
      expect(lines).toEqual([R6])
      // The R6 line is on T1.1's TASK.md and names T7 as the unknown task.
      expect(lines[0]).toStartWith(`R6 ${T11}:`)
      expect(/unknown task (\S+)$/.exec(lines[0] ?? "")?.[1]).toBe("T7")

      // The status run reason is the R6 line; no job and no lease.
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: SPEC, reason: R6 })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

it.instance(
  "[VF12] /task on a task folder inside the unknown-after folder is refused with the same R6 line",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const typed = `${SPEC}/T1-words.task/T1.2-shout.task`
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, typed, jobs)
      expect(inputs).toHaveLength(1)
      expect((inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")).toEqual([
        `Refused ${typed}: 1 failure. No work started.`,
        R6,
        `Fix each line, then type /task ${typed} again.`,
      ])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: typed, reason: R6 })
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
)

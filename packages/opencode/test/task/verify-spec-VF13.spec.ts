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

// Scenario VF13 (spec task-harness-feedback, D11, D14, AC 13, AC 16): the no-ensures folder is refused.
//
//   Given the example-no-ensures spec folder with a leaf VERIFY.md that has no ensures
//   When /task runs on it
//   Then the refusal has an R3 line for that VERIFY.md
//
// The folder is a committed copy of task-formats/blend/example-no-ensures.spec in a git instance. `/task` is the real
// `TaskCommand.run` with the real harness root and the real loader; the ops only record the reply. Which VERIFY.md
// lacks `ensures`, and that its task is a leaf, is read from the files on disk.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC = "task-formats/blend/example-no-ensures.spec"
const LEAF = "T1-words.task/T1.2-shout.task"
const VERIFY = `${LEAF}/VERIFY.md`
const R3 = `R3 ${VERIFY}: (root): 'ensures' is a required property`

// The top-level keys of a file's front matter.
const keysOf = (text: string) =>
  [...(/^---\n([\s\S]*?)\n?---\n/.exec(text)?.[1] ?? "").matchAll(/^([A-Za-z][\w-]*):/gm)].map((match) => match[1])

it.instance(
  "[VF13] the no-ensures folder is refused with one R3 line for the leaf VERIFY.md that has no ensures",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)

      // Given: of the spec's VERIFY.md files, only T1.2's has no `ensures` key in its front matter.
      const entries = yield* fs.readDirectory(specDir, { recursive: true })
      const verifies = entries.filter((entry) => path.basename(entry) === "VERIFY.md").toSorted()
      expect(verifies).toEqual(
        ["T1-words.task/T1.1-upper.task/VERIFY.md", VERIFY, "T1-words.task/VERIFY.md"].toSorted(),
      )
      const keys: Record<string, ReadonlyArray<string | undefined>> = {}
      for (const file of verifies) keys[file] = keysOf(yield* fs.readFileString(path.join(specDir, file)))
      expect(verifies.filter((file) => !keys[file]?.includes("ensures"))).toEqual([VERIFY])
      expect(keys[VERIFY]).toEqual(["hint", "gates"])
      // T1.2 is a leaf: its folder holds TASK.md and VERIFY.md and no child `.task` folder.
      expect((yield* fs.readDirectory(path.join(specDir, LEAF))).toSorted()).toEqual(["TASK.md", "VERIFY.md"])
      // The loader finds that one schema failure and nothing else.
      const loaded = yield* Blend.load(specDir)
      expect(loaded.spec).toBeUndefined()
      expect(loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)).toEqual([R3])

      // When /task runs on it.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, SPEC, jobs)

      // Then: one message with no model turn: the counted header, the R3 line, then the hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      const message = (inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")
      expect(message).toEqual([
        `Refused ${SPEC}: 1 failure. No work started.`,
        R3,
        `Fix each line, then type /task ${SPEC} again.`,
      ])
      const lines = message.filter((line) => /^R\d+ /.test(line))
      expect(lines).toEqual([R3])
      // The R3 line is for that VERIFY.md, and it names the missing `ensures`.
      expect(/^R3 (\S+): /.exec(lines[0] ?? "")?.[1]).toBe(VERIFY)
      expect(lines[0]).toContain("'ensures'")

      // The status run reason is the R3 line; no job and no lease.
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: SPEC, reason: R3 })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

it.instance(
  "[VF13] /task on the T1.1 task folder of the no-ensures folder is refused with the same R3 line",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const typed = `${SPEC}/T1-words.task/T1.1-upper.task`
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, typed, jobs)
      expect(inputs).toHaveLength(1)
      expect((inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")).toEqual([
        `Refused ${typed}: 1 failure. No work started.`,
        R3,
        `Fix each line, then type /task ${typed} again.`,
      ])
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: typed, reason: R3 })
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
)

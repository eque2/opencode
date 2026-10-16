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

// Scenario VF9 (spec task-harness-feedback, D10, D14, AC 16; spec.md defect 6): the format-faults folder is refused
// with all three faults listed.
//
//   Given the example-format-faults spec folder with a stray file, a TASK.md with no title and an unknown front-matter key
//   When /task runs on it
//   Then the refusal lists an R1 line, an R3 line and an R4 line, in the loader's rule order
//
// The folder is a committed copy of task-formats/blend/example-format-faults.spec in a git instance. `/task` is the
// real `TaskCommand.run` with the real harness root and the real loader; the ops only record the reply. The three
// faults are checked on disk first, and the expected lines are pinned as text and compared with the loader's own list.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC = "task-formats/blend/example-format-faults.spec"
const STRAY = "notes.txt"
const UNKNOWN_KEY = "T1-words.task/T1.1-upper.task/TASK.md"
const NO_TITLE = "T1-words.task/T1.2-shout.task/TASK.md"

const R1 = `R1 ${STRAY}: a \`.spec\` folder holds only SPEC.md, acceptance/ and \`.task\` folders`
const R3 = `R3 ${UNKNOWN_KEY}: (root): Additional properties are not allowed ('colour' was unexpected)`
const R4 = `R4 ${NO_TITLE}: body does not start with \`# <title>\``

// The front matter of a TASK.md, and its body after the front matter.
const split = (text: string) => {
  const match = /^---\n([\s\S]*?)\n?---\n([\s\S]*)$/.exec(text)
  return { front: match?.[1] ?? "", body: match?.[2] ?? "" }
}
const keysOf = (front: string) => [...front.matchAll(/^([A-Za-z][\w-]*):/gm)].map((match) => match[1])

it.instance(
  "[VF9] the format-faults folder is refused with an R1, an R3 and an R4 line, in the loader's rule order, and nothing else",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)

      // Given: the three planted faults, on disk in the committed copy.
      // A stray file at the spec root: not SPEC.md, not acceptance/, not a `.task` folder.
      const root = yield* fs.readDirectory(specDir)
      expect(root.toSorted()).toEqual(["SPEC.md", STRAY, "T1-words.task"].toSorted())
      // A TASK.md with no title: its body does not start with `# `; its sibling's TASK.md does.
      expect(split(yield* fs.readFileString(path.join(specDir, NO_TITLE))).body.trimStart()).not.toMatch(/^# /)
      expect(split(yield* fs.readFileString(path.join(specDir, UNKNOWN_KEY))).body.trimStart()).toMatch(/^# \S/)
      // An unknown front-matter key: `colour` sits in T1.1's TASK.md and in no other TASK.md of the spec.
      const t11 = keysOf(split(yield* fs.readFileString(path.join(specDir, UNKNOWN_KEY))).front)
      const t12 = keysOf(split(yield* fs.readFileString(path.join(specDir, NO_TITLE))).front)
      expect(t11).toContain("colour")
      expect(t12).not.toContain("colour")

      // The loader's own list: exactly the three lines, ordered by rule; the path order would differ.
      const loaded = yield* Blend.load(specDir)
      expect(loaded.spec).toBeUndefined()
      const lines = loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)
      expect(lines).toEqual([R1, R3, R4])
      expect(loaded.failures.map((failure) => failure.path).toSorted()).not.toEqual([STRAY, UNKNOWN_KEY, NO_TITLE])

      // When /task runs on it.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, SPEC, jobs)

      // Then: one message with no model turn: the counted header, R1, R3, R4 in that order, then the hint.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      const message = (inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")
      expect(message).toEqual([
        `Refused ${SPEC}: 3 failures. No work started.`,
        R1,
        R3,
        R4,
        `Fix each line, then type /task ${SPEC} again.`,
      ])
      expect(message.slice(1, 4).map((line) => line.split(" ")[0])).toEqual(["R1", "R3", "R4"])
      expect(message.slice(1, 4)).toEqual(lines)

      // The status run reason holds the same three lines; no job and no lease.
      expect(yield* refusalOf(directory)).toMatchObject({
        state: "refused",
        spec: SPEC,
        path: SPEC,
        reason: [R1, R3, R4].join("\n"),
      })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

it.instance(
  "[VF9] /task on a task folder inside the format-faults folder lists the same three lines in the same order",
  () =>
    Effect.gen(function* () {
      const directory = yield* seed(SPEC)
      const typed = `${SPEC}/T1-words.task/T1.2-shout.task`
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(yield* TaskHarness.make, typed, jobs)
      expect(inputs).toHaveLength(1)
      expect((inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")).toEqual([
        `Refused ${typed}: 3 failures. No work started.`,
        R1,
        R3,
        R4,
        `Fix each line, then type /task ${typed} again.`,
      ])
      expect(yield* refusalOf(directory)).toMatchObject({
        state: "refused",
        path: typed,
        reason: [R1, R3, R4].join("\n"),
      })
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
)

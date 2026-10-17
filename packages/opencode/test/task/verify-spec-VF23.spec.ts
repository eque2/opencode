import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import { readFileSync } from "node:fs"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF23 (spec task-harness-feedback, D10, AD-14, @ASSUMPTION:A3.a): a format fault hides the graph faults
// until every file passes.
//
//   Given a spec with an R3 front-matter fault and an R7 cycle
//   When /task runs on it
//   Then the refusal lists only the R3 line, because R5 to R13 run only once every file passes R1 to R4
//   And the blend README's Validation section states the two stages
//
// The spec is a copy of release-notes.spec in a git instance, edited in place. `/task` is the real
// `TaskCommand.run` with the real harness root, loader and event store; the ops only record the reply, and the job
// registry only records a start. The loader's own lines are read with the real `Blend.load`.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const T11 = "T1-release-notes.task/T1.1-commit-parser.task/TASK.md"
const T12 = "T1-release-notes.task/T1.2-version-bump.task/TASK.md"
const T13 = "T1-release-notes.task/T1.3-markdown-render.task/TASK.md"
const HINT = `Fix each line, then type /task ${SPEC} again.`

// The first line of a front matter, after which a key is added.
const OPEN = "---\n"

const FILE_RULES = ["R1", "R2", "R3", "R4", "R11"]
const GRAPH_RULES = ["R5", "R6", "R7", "R8", "R9", "R10", "R13"]

const textOf = (inputs: ReadonlyArray<{ readonly parts: ReadonlyArray<{ readonly text: string }> }>) =>
  inputs.map((input) => input.parts.map((part) => part.text).join("\n"))

const ruleOf = (line: string) => line.split(" ")[0] ?? ""

it.instance(
  "[VF23] a spec with an R3 front-matter fault and an R7 cycle: /task lists only the R3 line, and the R7 line appears once the R3 fault is fixed",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* seed(SPEC)
      const specDir = path.join(directory, SPEC)
      const file = (name: string) => path.join(specDir, name)
      const read = (name: string) => fs.readFileString(file(name))
      const write = (name: string, text: string) => fs.writeFileString(file(name), text)
      const lines = Effect.map(Blend.load(specDir), (loaded) =>
        loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`),
      )
      const original = yield* read(T13)
      expect(yield* lines).toEqual([])

      // The R3 fault alone: an unknown key in T1.3's front matter gives R3 lines only.
      const faulty = original.replace(OPEN, `${OPEN}owner: someone\n`)
      expect(faulty).not.toBe(original)
      yield* write(T13, faulty)
      const r3 = yield* lines
      expect(r3.length).toBeGreaterThan(0)
      expect(r3.map(ruleOf).every((rule) => rule === "R3")).toBe(true)
      expect(r3.every((line) => line.startsWith(`R3 ${T13}: `))).toBe(true)
      yield* write(T13, original)

      // The R7 cycle alone: T1.1 after T1.2 and T1.2 after T1.1 give graph-rule lines, with an R7 cycle line.
      yield* write(T11, (yield* read(T11)).replace(OPEN, `${OPEN}after: [T1.2]\n`))
      yield* write(T12, (yield* read(T12)).replace(OPEN, `${OPEN}after: [T1.1]\n`))
      const graph = yield* lines
      expect(graph.length).toBeGreaterThan(0)
      expect(graph.map(ruleOf).every((rule) => GRAPH_RULES.includes(rule))).toBe(true)
      const r7 = graph.filter((line) => ruleOf(line) === "R7")
      expect(r7.some((line) => /cycle/.test(line) && line.includes("T1.1") && line.includes("T1.2"))).toBe(true)

      // Given: the spec with both the R3 fault and the R7 cycle. The loader reports only the R3 lines.
      yield* write(T13, faulty)
      expect(yield* lines).toEqual(r3)

      // When /task runs on it.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      const inputs = yield* runTaskInputs(harness, SPEC, jobs)

      // Then the refusal lists only the R3 line(s): no graph-rule line, no R7.
      const count = r3.length === 1 ? "1 failure" : `${r3.length} failures`
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      expect(textOf(inputs)).toEqual([[`Refused ${SPEC}: ${count}. No work started.`, ...r3, HINT].join("\n")])
      const body = (textOf(inputs)[0] ?? "").split("\n").slice(1, -1)
      expect(body.map(ruleOf).every((rule) => FILE_RULES.includes(rule))).toBe(true)
      expect(body.some((line) => ruleOf(line) === "R7")).toBe(false)
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, reason: r3.join("\n") })
      expect(jobs.starts).toEqual([])
      expect(yield* harness.live(directory)).toEqual(Option.none())
      const db = yield* Database.Service
      expect(yield* TaskEvents.read(db.db, TaskEvents.runID(directory, SPEC))).toEqual([])

      // Once every file passes R1-R4 again (the R3 fault fixed, the cycle kept), the R7 line is reported: the cycle
      // was held back by the stage order, not lost.
      yield* write(T13, original)
      expect(yield* lines).toEqual(graph)
      const again = textOf(yield* runTaskInputs(harness, SPEC, jobs))
      const graphCount = graph.length === 1 ? "1 failure" : `${graph.length} failures`
      expect(again).toEqual([[`Refused ${SPEC}: ${graphCount}. No work started.`, ...graph, HINT].join("\n")])
      expect(jobs.starts).toEqual([])
    }),
  { git: true },
)

// The text of a `## ` section of the blend README, up to the next `## ` heading.
const README = readFileSync(path.resolve(import.meta.dir, "../../../../task-formats/blend/README.md"), "utf8")
const section = (heading: string) => {
  const start = README.indexOf(`\n## ${heading}\n`)
  if (start < 0) return ""
  const next = README.indexOf("\n## ", start + 1)
  return README.slice(start, next < 0 ? README.length : next)
}

test("[VF23] the blend README's Validation section states the two rule stages", () => {
  const validation = section("Validation")
  expect(validation).not.toBe("")
  // The paragraph that states the stages.
  const stages = validation.split("\n\n").find((paragraph) => paragraph.includes("two stages")) ?? ""
  expect(stages).toStartWith("The rules run in two stages.")
  // Stage 1: R1-R4 check each file on its own.
  expect(stages).toContain("R1–R4 (and R11) check each file on its own")
  // Stage 2: the whole-spec rules of R5-R13 run only once every file passes R1-R4.
  expect(stages).toContain("R5–R13")
  expect(stages).toContain("run only once every file passes R1–R4")
  // The case of this scenario.
  expect(stages.replace(/\s+/g, " ")).toContain(
    "a spec with an R3 fault and an R7 cycle reports only the R3 line until the R3 fault is fixed",
  )
  // The rule table agrees: the whole-spec rules run at load, after R1-R4.
  const rows = validation.split("\n")
  for (const rule of GRAPH_RULES)
    expect(rows.find((line) => line.startsWith(`| ${rule} |`)) ?? "").toContain("load, after R1–R4")
  for (const rule of ["R1", "R2", "R3", "R4"])
    expect(rows.find((line) => line.startsWith(`| ${rule} |`)) ?? "").toMatch(/\| load \|$/)
})

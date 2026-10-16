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
import { jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF1 (spec task-harness-feedback, D10, AD-14, EXPERIENCE "Refusal"): a refused /task lists every failure.
//
//   Given a spec folder with three loader failures
//   When /task runs on it
//   Then the session message has the header "Refused <path>: 3 failures. No work started."
//   And the next lines are each failure as "<rule> <path>: <message>" in loader order, then the hint line
//   And the status run reason holds exactly those failure lines
//
// The spec folder is a committed copy of the release-notes spec in a git instance, with three faults planted in three
// files: a stray file (R1), an unknown front-matter key (R3) and a TASK.md with no `## Goal` section (R4). The faults
// sit so that the loader's order (by rule) is not the order of the file paths. `/task` is the real `TaskCommand.run`
// with the real harness root and the real loader; the ops only record the reply. The expected lines are built from
// the loader's own failure list, and the status reason is read back from the status file on disk.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const STRAY = "draft.txt"
const T11_TASK = "T1-release-notes.task/T1.1-commit-parser.task/TASK.md"
const T14_TASK = "T1-release-notes.task/T1.4-command-line.task/TASK.md"

// Three faults in three files of the seeded spec: R4 in T1.1 (the first path), R3 in T1.4, R1 at the spec root.
const plantThree = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spec = path.join(directory, SPEC)
    const rewrite = (file: string, change: (text: string) => string) =>
      Effect.gen(function* () {
        const target = path.join(spec, file)
        const before = yield* fs.readFileString(target)
        const after = change(before)
        expect(after).not.toBe(before)
        yield* fs.writeFileString(target, after)
      })
    yield* rewrite(T11_TASK, (text) => text.replace("\n## Goal\n", "\n## Aim\n"))
    yield* rewrite(T14_TASK, (text) => text.replace("---\n", "---\ncolour: red\n"))
    yield* fs.writeFileString(path.join(spec, STRAY), "a note that does not belong in a spec folder\n")
  })

// The loader's failures for the seeded spec, each as the line the refusal must show.
const loaderFailures = (directory: string) =>
  Effect.map(Blend.load(path.join(directory, SPEC)), (loaded) => loaded.failures)

const lineOf = (failure: { readonly rule: string; readonly path: string; readonly message: string }) =>
  `${failure.rule} ${failure.path}: ${failure.message}`

// `/task <typed>` on the faulty spec: the one reply's text, the status file's run, and what the run started.
const refuse = (typed: string) =>
  Effect.gen(function* () {
    const directory = yield* seed(SPEC)
    yield* plantThree(directory)
    const failures = yield* loaderFailures(directory)
    const harness = yield* TaskHarness.make
    const jobs = jobsOf()
    const inputs = yield* runTaskInputs(harness, typed, jobs)
    return {
      directory,
      failures,
      inputs,
      run: yield* refusalOf(directory),
      starts: jobs.starts.length,
      live: yield* harness.live(directory),
    }
  })

it.instance(
  "[VF1] a spec folder with three loader failures: the reply is the counted header, each failure line in loader order, then the hint",
  () =>
    Effect.gen(function* () {
      const { failures, inputs, starts, live } = yield* refuse(SPEC)

      // Given: the loader finds exactly the three planted faults, ordered by rule, not by file path.
      expect(failures.map((failure) => [failure.rule, failure.path])).toEqual([
        ["R1", STRAY],
        ["R3", T14_TASK],
        ["R4", T11_TASK],
      ])
      expect(failures.map((failure) => failure.path)).not.toEqual(failures.map((failure) => failure.path).toSorted())
      const lines = failures.map(lineOf)

      // When /task runs: one session message, sent with no model turn.
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.noReply).toBe(true)
      expect(inputs[0]?.parts).toHaveLength(1)
      const message = (inputs[0]?.parts[0]?.text ?? "").split("\n")

      // Then: the header, the three failure lines in loader order, then the hint, and nothing else.
      expect(message).toHaveLength(5)
      expect(message[0]).toBe(`Refused ${SPEC}: 3 failures. No work started.`)
      expect(message.slice(1, 4)).toEqual(lines)
      for (const line of message.slice(1, 4)) expect(line).toMatch(/^R\d+ \S+: \S.*$/)
      expect(message[1]).toStartWith(`R1 ${STRAY}: `)
      expect(message[2]).toStartWith(`R3 ${T14_TASK}: `)
      expect(message[3]).toBe(`R4 ${T11_TASK}: no \`## Goal\` section`)
      expect(message[4]).toBe(`Fix each line, then type /task ${SPEC} again.`)

      // No work started: no job, no lease.
      expect(starts).toBe(0)
      expect(live).toEqual(Option.none())
    }),
  { git: true },
)

it.instance(
  "[VF1] the status run reason holds exactly the three failure lines: no header, no hint",
  () =>
    Effect.gen(function* () {
      const { failures, run } = yield* refuse(SPEC)
      const lines = failures.map(lineOf)
      expect(lines).toHaveLength(3)

      expect(run.state).toBe("refused")
      expect(run.spec).toBe(SPEC)
      expect(run.path).toBe(SPEC)
      expect(run.reason).toBe(lines.join("\n"))
      expect(String(run.reason).split("\n")).toEqual(lines)
      expect(run.reason).not.toContain("Refused")
      expect(run.reason).not.toContain("Fix each line")
    }),
  { git: true },
)

it.instance(
  "[VF1] the header and the hint name the path as typed; the lines and the run reason are the same three failures",
  () =>
    Effect.gen(function* () {
      // A task folder inside the faulty spec: the loader still loads the whole spec and refuses it.
      const typed = `${SPEC}/T1-release-notes.task/T1.2-version-bump.task`
      const { failures, inputs, run, starts } = yield* refuse(typed)
      const lines = failures.map(lineOf)

      expect(inputs).toHaveLength(1)
      expect((inputs[0]?.parts[0]?.text ?? "").split("\n")).toEqual([
        `Refused ${typed}: 3 failures. No work started.`,
        ...lines,
        `Fix each line, then type /task ${typed} again.`,
      ])
      expect(run).toMatchObject({ state: "refused", spec: SPEC, path: typed, reason: lines.join("\n") })
      expect(starts).toBe(0)
    }),
  { git: true },
)

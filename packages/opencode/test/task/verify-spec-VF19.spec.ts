import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskHarness } from "@/task/core/harness"
import { testEffect } from "../lib/effect"
import { jobsOf, refusalOf, runTaskInputs, seed } from "./lib/command"

// Scenario VF19 (spec task-harness-feedback, D10, D13, AD-14, AD-19, EXPERIENCE "Refusal (D10, D13)"): every refusal
// form reads as the UX document sets.
//
//   Given a spec with one loader failure, a subtree run with an untrusted folder task outside it, and a checkout with
//     an uncommitted change
//   When /task runs on each
//   Then the first reads "Refused <path>: 1 failure. No work started.", its line, then the hint "Fix each line, then
//     type /task <path> again."
//   And the subtree refusal ends with the hint "Run the whole spec, or a folder that holds T1.1."
//   And the checkout refusal reads "Refused <path>. No work started." and one plain line, with no hint
//
// Each case is a committed copy of the spec folders in a git instance with no stored run. `/task` is the real
// `TaskCommand.run` with the real harness root, loader, git readiness check and D13 trust walk over the (empty) event
// store; the ops only record the reply. EXPERIENCE: `<path>` is the `/task` argument as the user typed it.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const UNKNOWN_AFTER = "task-formats/blend/example-unknown-after.spec"
const OUTSIDE_RUN = "task-formats/blend/example-outside-run.spec"
const RELEASE_NOTES = "task-formats/blend/release-notes.spec"

// `/task <typed>` in the instance: the one reply as lines. A refusal is one message with no model turn and no job.
const refusal = (directory: string, typed: string) =>
  Effect.gen(function* () {
    const harness = yield* TaskHarness.make
    const jobs = jobsOf()
    const inputs = yield* runTaskInputs(harness, typed, jobs)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.noReply).toBe(true)
    expect(jobs.starts).toEqual([])
    expect(yield* harness.live(directory)).toEqual(Option.none())
    return (inputs[0]?.parts.map((part) => part.text).join("\n") ?? "").split("\n")
  })

describe("[VF19] every refusal form reads as the UX document sets", () => {
  it.instance(
    "[VF19] a spec with one loader failure: the counted header, its one line, then the fix hint",
    () =>
      Effect.gen(function* () {
        const directory = yield* seed(UNKNOWN_AFTER)
        const line = "R6 T1-words.task/T1.1-upper.task/TASK.md: after names unknown task T7"
        const message = yield* refusal(directory, UNKNOWN_AFTER)
        expect(message).toEqual([
          `Refused ${UNKNOWN_AFTER}: 1 failure. No work started.`,
          line,
          `Fix each line, then type /task ${UNKNOWN_AFTER} again.`,
        ])
        // The hint is not in `run.reason`: it holds only the failure line.
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: UNKNOWN_AFTER, reason: line })
      }),
    { git: true },
  )

  it.instance(
    "[VF19] the loader-failure refusal names the path as the user typed it, in the header and in the hint",
    () =>
      Effect.gen(function* () {
        const directory = yield* seed(UNKNOWN_AFTER)
        const typed = `./${UNKNOWN_AFTER}/`
        const message = yield* refusal(directory, typed)
        expect(message).toEqual([
          `Refused ${typed}: 1 failure. No work started.`,
          "R6 T1-words.task/T1.1-upper.task/TASK.md: after names unknown task T7",
          `Fix each line, then type /task ${typed} again.`,
        ])
      }),
    { git: true },
  )

  it.instance(
    "[VF19] a subtree run with an untrusted folder task outside it ends with the hint to run the whole spec or a folder that holds T1.1",
    () =>
      Effect.gen(function* () {
        const directory = yield* seed(OUTSIDE_RUN)
        const subtree = `${OUTSIDE_RUN}/T1-words.task/T1.2-shout.task`
        const line = "R12 T1-words.task/T1.2-shout.task: T1.2 is after T1.1, which is outside this run and not trusted"
        const message = yield* refusal(directory, subtree)
        expect(message.at(-1)).toBe("Run the whole spec, or a folder that holds T1.1.")
        expect(message).toEqual([
          `Refused ${subtree}: 1 failure. No work started.`,
          line,
          "Run the whole spec, or a folder that holds T1.1.",
        ])
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", path: subtree, reason: line })
      }),
    { git: true },
  )

  it.instance(
    "[VF19] a subtree run with two untrusted folder tasks outside it names both in the hint, joined by and",
    () =>
      Effect.gen(function* () {
        const directory = yield* seed(RELEASE_NOTES)
        const subtree = `${RELEASE_NOTES}/T1-release-notes.task/T1.4-command-line.task`
        const folder = "T1-release-notes.task/T1.4-command-line.task"
        const message = yield* refusal(directory, subtree)
        expect(message).toEqual([
          `Refused ${subtree}: 2 failures. No work started.`,
          `R12 ${folder}: T1.4 is after T1.2, which is outside this run and not trusted`,
          `R12 ${folder}: T1.4 is after T1.3, which is outside this run and not trusted`,
          "Run the whole spec, or a folder that holds T1.2 and T1.3.",
        ])
      }),
    { git: true },
  )

  it.instance(
    "[VF19] a checkout with an uncommitted change: the plain header and one plain line, with no hint",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* seed(OUTSIDE_RUN)
        // A tracked file changed and not committed.
        yield* fs.writeFileString(path.join(directory, "app.ts"), "export const app = 2\n")
        const line = "the checkout has uncommitted changes or untracked files: app.ts"
        const message = yield* refusal(directory, OUTSIDE_RUN)
        expect(message).toEqual([`Refused ${OUTSIDE_RUN}. No work started.`, line])
        expect(message.some((each) => each.startsWith("Fix each line") || each.startsWith("Run the whole spec"))).toBe(
          false,
        )
        expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: OUTSIDE_RUN, reason: line })
      }),
    { git: true },
  )
})

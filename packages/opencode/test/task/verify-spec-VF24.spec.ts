import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer, Option } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact } from "@/task/core/model"
import { TaskWorkers } from "@/task/core/workers"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, fold, loadPlan, trustLeaf, unitState } from "./lib/machine"
import { git, jobsOf, refusalOf, runTaskInputs, seed, SPEC } from "./lib/command"

// Scenario VF24 (spec task-harness-feedback, D13, AD-15, SD-13): a stored slice that does not load blocks a subtree
// run only when it is newer than the deciding slice.
//
//   Given a newer whole-spec slice in which T1.1 is trusted and an older subtree slice whose path no longer loads
//   When /task runs on the T1.3 task folder
//   Then the trust walk starts at the newest slice, stops at the first slice that loads and holds T1.1, and the run
//     starts
//   And when the slice that does not load is the newest, the run is refused with one plain line that names its path
//     and says "run the whole spec once to record a newer run"
//
// The spec is a committed copy of release-notes.spec in a git instance. A stored slice ran the T1.2 subtree at the
// folder `T1.2-version-bump.task`; the folder is then renamed (and the rename committed), so the spec still loads but
// that slice's path names no task folder of it. `/task` is the real `TaskCommand.run` with the real harness root,
// loader, event store and run machine; the ops only record the reply, and the job registry only records a start. The
// state of T1.1 in each loadable slice is computed here with the pure machine transition, independently of the
// command.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const PARENT = "T1-release-notes.task"
const T13 = `${SPEC}/${PARENT}/T1.3-markdown-render.task`
const T14 = `${SPEC}/${PARENT}/T1.4-command-line.task`
// The T1.2 folder before and after the rename.
const OLD_T12 = `${PARENT}/T1.2-version-bump.task`
const NEW_T12 = `${PARENT}/T1.2-next-version.task`
/** The path of the older subtree slice, which no longer loads after the rename. */
const GONE = `${SPEC}/${OLD_T12}`
const STARTED = "Implementing **T1.3 Render the release notes as Markdown** from spec"
const BLOCKED = `the stored run of /task ${GONE} no longer loads; run the whole spec once to record a newer run`

const textOf = (inputs: ReadonlyArray<{ readonly parts: ReadonlyArray<{ readonly text: string }> }>) =>
  inputs.map((input) => input.parts.map((part) => part.text).join("\n"))

// The facts stored on the run's aggregate for the seeded spec, oldest first.
const storedOf = (directory: string) =>
  Effect.gen(function* () {
    const db = yield* Database.Service
    return yield* TaskEvents.read(db.db, TaskEvents.runID(directory, SPEC))
  })

const publish = (directory: string, ...slices: ReadonlyArray<ReadonlyArray<Fact>>) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    for (const fact of slices.flat()) yield* TaskEvents.publish(events, TaskEvents.runID(directory, SPEC), fact)
  })

// The path a stored slice ran: its first fact's.
const pathOf = (slice: ReadonlyArray<Fact>) => {
  const first = slice[0]
  return first?.type === "run.started" ? first.path : undefined
}

// The seeded spec after the T1.2 folder was renamed, and the stored slices of the scenario, each checked.
const given = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* seed(SPEC)
  const specDir = path.join(directory, SPEC)
  const whole = yield* loadPlan("release-notes.spec")

  // The T1.2 subtree slice, stored while the folder had its old name: its path then named T1.2's folder.
  const before = yield* Blend.load(specDir)
  expect(before.spec && TaskWorkers.folderOf(before.spec, "T1.2")).toBe(OLD_T12)
  const f = facts()
  const gone = [f.runStarted(GONE), f.started("T1.2")]

  // The folder is renamed and the rename committed: the spec still loads, but no task folder has the old path.
  yield* git(directory, "mv", path.join(specDir, OLD_T12), path.join(specDir, NEW_T12))
  yield* git(directory, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "rename")
  const after = yield* Blend.load(specDir)
  expect(after.failures).toEqual([])
  const spec = after.spec
  expect(spec).toBeDefined()
  expect(spec && TaskWorkers.folderOf(spec, "T1.2")).toBe(NEW_T12)
  expect(yield* fs.exists(path.join(directory, GONE))).toBe(false)
  expect(yield* fs.exists(path.join(directory, T13))).toBe(true)
  // The T1.3 subtree plan has T1.1 as its external region; the T1.4 subtree plan holds no T1.1 region.
  const t13 = yield* loadPlan("release-notes.spec", "T1.3")
  expect(t13.external).toEqual(["T1.1"])
  const t14 = yield* loadPlan("release-notes.spec", "T1.4")
  expect(t14.tasks.some((task) => task.id === "T1.1") || t14.external.includes("T1.1")).toBe(false)

  // A whole-spec slice in which T1.1 is trusted, one in which it is budget exhausted, and a T1.4 subtree slice.
  const g = facts(100)
  const trusted = [g.runStarted(SPEC), ...trustLeaf(whole, g, "T1.1")]
  expect(unitState(fold(whole, trusted), "T1.1")).toBe("trusted")
  const h = facts(200)
  const exhausted = [h.runStarted(SPEC), ...exhaustLeaf(h, "T1.1", "T1.1.c1")]
  expect(unitState(fold(whole, exhausted), "T1.1")).toBe("budget_exhausted")
  const other = [facts(300).runStarted(T14)]
  return { directory, gone, trusted, exhausted, other }
})

// `/task` on the T1.3 task folder, after the slices were stored oldest first.
const runT13 = (directory: string, ...slices: ReadonlyArray<ReadonlyArray<Fact>>) =>
  Effect.gen(function* () {
    yield* publish(directory, ...slices)
    const stored = yield* storedOf(directory)
    // Each slice is stored as one slice, in order, with its own path.
    expect(TaskEvents.slices(stored).map(pathOf)).toEqual(slices.map(pathOf))
    const harness = yield* TaskHarness.make
    const jobs = jobsOf()
    const inputs = yield* runTaskInputs(harness, T13, jobs)
    return { harness, jobs, inputs, replies: textOf(inputs), stored }
  })

it.instance(
  "[VF24] a newer whole-spec slice with T1.1 trusted and an older subtree slice whose path no longer loads: the newer slice decides and the T1.3 run starts",
  () =>
    Effect.gen(function* () {
      const { directory, gone, trusted } = yield* given

      const run = yield* runT13(directory, gone, trusted)

      expect(run.replies).toHaveLength(1)
      expect(run.replies[0]).toStartWith(STARTED)
      expect(run.replies[0]).not.toContain("no longer loads")
      expect(run.replies[0]).not.toContain("R12")
      expect(run.jobs.starts).toHaveLength(1)
      expect(run.jobs.starts[0]?.id).toBe(TaskEvents.runID(directory, SPEC))
    }),
  { git: true },
)

it.instance(
  "[VF24] the trust walk starts at the newest slice: an older slice that does not load, and an older one with T1.1 budget exhausted, are never reached",
  () =>
    Effect.gen(function* () {
      const { directory, gone, trusted, exhausted } = yield* given

      const run = yield* runT13(directory, exhausted, gone, trusted)

      expect(run.replies).toHaveLength(1)
      expect(run.replies[0]).toStartWith(STARTED)
      expect(run.jobs.starts).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  "[VF24] the walk stops at the first slice that loads and holds T1.1: a newest T1.4 subtree slice without T1.1 is passed over, and the older slice that does not load is never reached",
  () =>
    Effect.gen(function* () {
      const { directory, gone, trusted, other } = yield* given

      const run = yield* runT13(directory, gone, trusted, other)

      expect(run.replies).toHaveLength(1)
      expect(run.replies[0]).toStartWith(STARTED)
      expect(run.jobs.starts).toHaveLength(1)
    }),
  { git: true },
)

it.instance(
  '[VF24] when the slice that does not load is the newest, the T1.3 run is refused with one plain line that names its path and says "run the whole spec once to record a newer run"',
  () =>
    Effect.gen(function* () {
      const { directory, gone, trusted } = yield* given
      const worktrees = yield* git(directory, "worktree", "list", "--porcelain")

      const run = yield* runT13(directory, trusted, gone)

      // One session message, sent with no model turn: the plain header and the one line, with no count and no hint.
      expect(run.inputs).toHaveLength(1)
      expect(run.inputs[0]?.noReply).toBe(true)
      expect(run.replies).toEqual([`Refused ${T13}. No work started.\n${BLOCKED}`])
      const line = (run.replies[0] ?? "").split("\n")[1] ?? ""
      expect(line).toContain(GONE)
      expect(line).toEndWith("run the whole spec once to record a newer run")
      // Refused at the start: no job, no lease, no new fact, no worktree; the status file holds the one line.
      expect(run.jobs.starts).toEqual([])
      expect(yield* run.harness.live(directory)).toEqual(Option.none())
      expect(yield* storedOf(directory)).toEqual(run.stored)
      expect(yield* git(directory, "worktree", "list", "--porcelain")).toBe(worktrees)
      expect(yield* refusalOf(directory)).toMatchObject({ state: "refused", spec: SPEC, path: T13, reason: BLOCKED })
    }),
  { git: true },
)

it.instance(
  "[VF24] a slice that does not load still blocks when it is newer than the deciding slice, even if a newer slice without T1.1 follows it",
  () =>
    Effect.gen(function* () {
      const { directory, gone, trusted, other } = yield* given

      const run = yield* runT13(directory, trusted, gone, other)

      expect(run.replies).toEqual([`Refused ${T13}. No work started.\n${BLOCKED}`])
      expect(run.jobs.starts).toEqual([])
    }),
  { git: true },
)

it.instance(
  "[VF24] the trust walk itself: TaskCommand.folderTrust over the stored slices gives trusted, or blocked with the path",
  () =>
    Effect.gen(function* () {
      const { directory, gone, trusted, exhausted, other } = yield* given
      const loaded = yield* Blend.load(path.join(directory, SPEC))
      const spec = loaded.spec
      expect(spec).toBeDefined()
      if (!spec) return
      const walk = (...slices: ReadonlyArray<ReadonlyArray<Fact>>) =>
        TaskCommand.folderTrust(spec, SPEC, slices.flat(), "T1.1")

      expect(yield* walk(gone, trusted)).toEqual({ kind: "trusted" })
      expect(yield* walk(exhausted, gone, trusted)).toEqual({ kind: "trusted" })
      expect(yield* walk(gone, trusted, other)).toEqual({ kind: "trusted" })
      expect(yield* walk(gone, exhausted)).toEqual({ kind: "untrusted" })
      expect(yield* walk(trusted, gone)).toEqual({ kind: "blocked", path: GONE })
      expect(yield* walk(trusted, gone, other)).toEqual({ kind: "blocked", path: GONE })
    }),
  { git: true },
)

import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option, Path, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { git, jobsOf, runTask, seed, SPEC } from "./lib/command"
import { loadPlan, obligationsOf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario RM8b (spec task-harness-feedback, spine AD-6, AD-10, owner ruling 3): an old slice with no end and no path
// resumes on /task of the whole spec.
//
//   Given a stored slice written by the old engine, with run.started without a path, no run.ended, and a fold that
//     is not done
//   When /task runs on the whole spec, also when the path is written ./<spec>/
//   Then the slice counts as a whole-spec slice and the run resumes
//   And the resume records only run.resumed with the path, a fact type that already exists
//
// The old engine (base 2c0214ab71) wrote `run.started` and `run.resumed` with an optional base and no path. The stored
// slice here is in that form: the run started on the checkout's branch, T1.1 became trusted, and nothing ended the
// run. The facts go through the real event store (`TaskEvents.publish`, `read`), the real slice choice
// (`TaskCommand.sliceOf`, `normalizedPath`) and the real `/task` (`TaskCommand.run`, through `./lib/command`), whose
// job records the first fact of the run on the harness. Each form of the path runs in its own instance.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState
const seeded = seed(SPEC)

// The fact types of the old engine's `FactSchema` (base 2c0214ab71, packages/opencode/src/task/core/events.ts).
const OLD_TYPES = [
  "run.started",
  "run.resumed",
  "outside.trusted",
  "task.started",
  "task.ready",
  "task.proved",
  "task.verified",
  "task.stalled",
  "task.repeated",
  "task.needs_human",
  "task.failed",
  "obligation.stale",
  "scenario.proved",
  "scenario.verified",
  "run.cancelled",
  "run.ended",
]

const SUBTREE = `${SPEC}/T1-release-notes.task/T1.5-issue-links.task`

const decode = Schema.decodeUnknownSync(TaskEvents.FactSchema)

// The stored old slice, on the branch `base`: run.started with no path, T1.1 built, proved and trusted, no end.
const oldSlice = (plan: Plan, base: string): ReadonlyArray<Fact> => {
  let clock = 1_700_000_000_000
  const at = () => (clock += 1000)
  return [
    { type: "run.started", at: at(), base },
    {
      type: "task.started",
      at: at(),
      task: "T1.1",
      worktree: "/wt/T1.1",
      branch: "task/T1.1",
      base,
      session: "ses_T1.1",
    },
    { type: "task.ready", at: at(), task: "T1.1", head: "head1" },
    {
      type: "task.proved",
      at: at(),
      task: "T1.1",
      results: obligationsOf(plan, "T1.1").map((id) => ({ id, status: "passed" as const })),
    },
    { type: "task.verified", at: at(), task: "T1.1", verdicts: [] },
  ]
}

// `/task <written>` in a seeded instance that stores the old slice: the facts before and after, and the reply.
const resumeWith = (written: string) =>
  Effect.gen(function* () {
    const directory = yield* seeded
    const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
    const events = yield* EventV2Bridge.Service
    const db = yield* Database.Service
    const plan = yield* loadPlan("release-notes.spec")
    const stored = oldSlice(plan, branch)
    const id = TaskEvents.runID(directory, SPEC)
    for (const fact of stored) yield* TaskEvents.publish(events, id, fact)
    expect(yield* TaskEvents.read(db.db, id)).toEqual(stored)

    const harness = yield* TaskHarness.make
    const jobs = jobsOf()
    jobs.mode = "run"
    const replies = yield* runTask(harness, written, jobs)
    yield* eventually(
      Effect.map(TaskEvents.read(db.db, id), (list) => list.length > stored.length),
      "the resumed run's first fact",
    )
    const after = yield* TaskEvents.read(db.db, id)
    const live = yield* harness.live(directory)
    jobs.status = "cancelled"
    for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
    expect(yield* harness.live(directory)).toEqual(Option.none())
    return { branch, stored, after, replies, live, jobs, id }
  })

// What the resume recorded: the old facts unchanged, then run.resumed with the path, and no new run.started.
const expectResumed = (result: Effect.Success<ReturnType<typeof resumeWith>>) => {
  const { branch, stored, after, replies, live, jobs, id } = result
  // The run starts on the harness as a resume: the header alone, the job of the run id, the lease on the spec path.
  expect(replies).toEqual(["Implementing spec **Release notes from conventional commits**"])
  expect(jobs.starts.map((start) => start.id)).toEqual([id])
  expect(live).toEqual(Option.some({ runID: id, spec: SPEC, path: SPEC }))
  // The stored facts stay as they were.
  expect(after.slice(0, stored.length)).toEqual([...stored])
  const added = after.slice(stored.length)
  // The first fact the job records is run.resumed with the normalised whole-spec path, and its base.
  expect(added[0]).toEqual({ type: "run.resumed", at: added[0]?.at ?? 0, base: branch, path: SPEC })
  // Only run.resumed marks the resume: no new run.started, so the same slice goes on.
  expect(added.filter((fact) => fact.type === "run.started")).toEqual([])
  expect(added.filter((fact) => fact.type === "run.resumed")).toHaveLength(1)
  expect(TaskEvents.slices(after)).toHaveLength(1)
  expect(Option.getOrThrow(TaskEvents.latestRun(after))[0]).toEqual(stored[0])
  // run.resumed is a fact type that already exists: the old engine wrote it, and it decodes as stored.
  expect(OLD_TYPES).toContain("run.resumed")
  expect(decode(JSON.parse(JSON.stringify(added[0])))).toEqual(added[0])
}

it.live("[RM8b] the stored old slice: run.started without a path, no run.ended, and a fold that is not done", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const stored = oldSlice(plan, "dev")
    expect(stored[0]).toEqual({ type: "run.started", at: stored[0]?.at ?? 0, base: "dev" })
    for (const fact of stored) {
      expect(Object.keys(fact)).not.toContain("path")
      expect(OLD_TYPES).toContain(fact.type)
      expect(decode(JSON.parse(JSON.stringify(fact)))).toEqual(fact)
    }
    expect(stored.filter((fact) => fact.type === "run.ended" || fact.type === "run.cancelled")).toEqual([])
    const snapshot = TaskEvents.fold(engine.XStateEngine, plan, stored)
    expect(engine.ended(snapshot)).toBe(false)
    expect(snapshot.status).toBe("active")
    expect(engine.view(snapshot).run.state).toBe("running")
    expect(engine.unitState(snapshot, "T1.1")).toBe("trusted")
    expect(engine.unitState(snapshot, "T1.2")).toBe("waiting")
  }),
)

it.live("[RM8b] the slice counts as a whole-spec slice, for every way the whole-spec path is written", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const stored = oldSlice(plan, "dev")
    // A slice with no path is the whole spec's: /task of the spec resumes it, and /task of a subtree does not.
    expect(yield* TaskCommand.sliceOf(plan, stored, SPEC)).toEqual({ kind: "resume", facts: stored })
    const subtree = yield* loadPlan("release-notes.spec", "T1.5")
    expect(yield* TaskCommand.sliceOf({ ...subtree, path: SUBTREE }, stored, SUBTREE)).toEqual({
      kind: "new",
      died: Option.none(),
    })
    // `<spec>`, `<spec>/`, `./<spec>` and `./<spec>/` name the one whole-spec path.
    const paths = yield* Path.Path
    const directory = "/repo"
    for (const written of [SPEC, `${SPEC}/`, `./${SPEC}`, `./${SPEC}/`])
      expect(TaskCommand.normalizedPath(paths, directory, paths.resolve(directory, written))).toBe(SPEC)
  }),
)

it.instance(
  "[RM8b] /task <spec> resumes the old slice and records only run.resumed with the path",
  () =>
    Effect.gen(function* () {
      expectResumed(yield* resumeWith(SPEC))
    }),
  { git: true },
)

it.instance(
  "[RM8b] /task ./<spec>/ resumes the old slice and records only run.resumed with the normalised path",
  () =>
    Effect.gen(function* () {
      expectResumed(yield* resumeWith(`./${SPEC}/`))
    }),
  { git: true },
)

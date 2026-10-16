import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Plan } from "@/task/core/model"
import { TaskRecorder } from "@/task/core/recorder"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { loadPlan, observed } from "./lib/machine"

// Scenario RM24 (spec task-harness-feedback, AD-20, AD-5, T1.12): during phase 1 the status file shows a blocked task
// with its cause.
//
//   Given a phase-1 run that folds the observed facts
//   When the status file is written
//   Then T1.5 and T1 have the state blocked and the reason "blocked by T1.4: budget exhausted"
//   And the status file keeps every field it had before the change
//
// The plan is the release-notes plan from the real loader (`loadPlan`); the facts are the fixture's observed facts
// (`observed`: run.started, T1.1 to T1.3 trusted, T1.4 failing its proof on each of its three attempts, budget 3).
// Two runs write the file, and the test reads each `status.json` back from disk:
// - the phase-1 path (AD-20): the facts folded with the engine (`initial`, `apply`), projected with
//   `TaskStatus.project` and written with `TaskStatus.write`;
// - the run's status writer today: the real `TaskRecorder` (real event store) records the facts, and its writer
//   writes the file.
//
// "Before the change" is the status file of the harness before this goal: `src/task/core/status.ts` at a1fca940ca
// (the parent of the goal's first change to it, b517ebb3f3), copied below as `Before` with only the state sets
// widened by the state names the spec adds (T1.12: tasks gain `blocked`; scenarios gain `blocked` and `cancelled`).
// The status file packages/tui/test/task-ui/fixture-status.json was written by that harness (last changed 753835377c,
// before this goal); it anchors `Before`: `Before` decodes it with excess keys refused, so `Before` names every field
// that the old file had.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState

const REASON = "blocked by T1.4: budget exhausted"
const CAUSE = { id: "T1.4", state: "budget_exhausted" }
const SPEC = "task-formats/blend/release-notes.spec"

// --- the status file before the change (status.ts at a1fca940ca) --------------------------------------------------

const Text = Schema.String
const Reason = Schema.optional(Schema.String)
const Before = Schema.Struct({
  run: Schema.Struct({
    state: Schema.Literals([
      "running",
      "refused",
      "waiting",
      "done",
      "cancelled",
      "needs_human",
      "budget_exhausted",
      "failed",
    ]),
    reason: Reason,
    spec: Text,
    path: Text,
  }),
  tasks: Schema.Record(
    Text,
    Schema.Struct({
      state: Schema.Literals([
        "waiting",
        "building",
        "proving",
        "verifying",
        "trusted",
        "stalled",
        "needs_human",
        "budget_exhausted",
        "cancelled",
        "failed",
        // added by the change (T1.12)
        "blocked",
      ]),
      attempts: Schema.Number,
      waitingOn: Schema.Array(Text),
      worktree: Reason,
      reason: Reason,
    }),
  ),
  obligations: Schema.Record(
    Text,
    Schema.Struct({
      state: Schema.Literals(["pending", "passed", "failed", "trusted", "rejected", "stale"]),
      reason: Reason,
    }),
  ),
  scenarios: Schema.Record(
    Text,
    Schema.Struct({
      state: Schema.Literals([
        "waiting",
        "pending",
        "trusted",
        "rejected",
        "failed",
        // added by the change (T1.12)
        "blocked",
        "cancelled",
      ]),
      waitingOn: Schema.Array(Text),
      reason: Reason,
    }),
  ),
  history: Schema.Array(Schema.Struct({ at: Schema.Number, unit: Text, from: Reason, to: Text, reason: Reason })),
})

const OLD_FILE = path.resolve(import.meta.dir, "../../../tui/test/task-ui/fixture-status.json")

// --- the two runs ----------------------------------------------------------------------------------------------------

const statusFile = (directory: string) => path.join(directory, ".opencode", "task", "status.json")

/** The status file of `directory`, as text and as parsed JSON. */
const readStatus = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(statusFile(directory))
  const parsed: unknown = JSON.parse(text)
  return { text, parsed }
})

/** The phase-1 path: the facts folded through the engine, projected, and written. */
const phaseOne = Effect.fnUntraced(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const snapshot = observed(plan).reduce((each, fact) => engine.apply(plan, each, fact), engine.initial(plan))
  yield* TaskStatus.write(directory, TaskStatus.project(plan, snapshot))
  return yield* readStatus(directory)
})

let runs = 0
/** Today's run writer: the Recorder records the facts; its writer writes the file. */
const recorded = Effect.fnUntraced(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  const events = yield* EventV2Bridge.Service
  const runID = `task_rm24${(runs++).toString(16).padStart(4, "0")}${Date.now().toString(16)}`
  const recorder = yield* TaskRecorder.make({ plan, runID, directory, stored: [], events })
  for (const fact of observed(plan)) yield* recorder.record(fact)
  // The writer runs on its own fiber: wait until it has written the last macrostep (T1.4 exhausted).
  for (let tries = 0; tries < 3_000; tries++) {
    const found = yield* readStatus(directory).pipe(Effect.option)
    if (Option.isSome(found) && decodedNow(found.value.text).tasks["T1.4"]?.state === "budget_exhausted")
      return found.value
    yield* Effect.sleep(10)
  }
  return yield* Effect.die(new Error("the status writer never wrote T1.4 budget exhausted"))
})

const decodedNow = (text: string) => Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(text)

// The Then of the first step, on one written file.
const expectBlocked = (text: string) => {
  const status = decodedNow(text)
  expect(status.run).toMatchObject({ spec: SPEC, path: SPEC })
  expect(status.tasks["T1.4"]).toMatchObject({ state: "budget_exhausted", attempts: 3 })
  for (const id of ["T1.1", "T1.2", "T1.3"]) expect(status.tasks[id]?.state).toBe("trusted")
  for (const id of ["T1.5", "T1"]) {
    expect(status.tasks[id]).toMatchObject({ state: "blocked", reason: REASON, blockedBy: CAUSE })
    expect(status.history.filter((entry) => entry.unit === id && entry.to === "blocked")).toMatchObject([
      { from: "waiting", reason: REASON },
    ])
  }
}

// The Then of the second step, on one written file.
const expectOldFields = (parsed: unknown) => {
  // Every field the old file had is there, with its old type: the old schema decodes the file.
  const exit = Schema.decodeUnknownExit(Before)(parsed)
  expect(Exit.isSuccess(exit) ? "decodes" : String(exit.cause)).toBe("decodes")
  if (Exit.isFailure(exit)) return
  const before = exit.value
  // The old optional fields are written wherever the run has their value.
  for (const id of ["T1.1", "T1.2", "T1.3", "T1.4"]) expect(before.tasks[id]?.worktree).toBe(`/wt/${id}`)
  expect(before.tasks["T1.4"]?.reason).toBeDefined()
  expect(before.obligations["T1.4.c7"]).toMatchObject({ state: "failed" })
  expect(before.obligations["T1.4.c7"]?.reason).toBeDefined()
  expect(before.scenarios["S1"]).toMatchObject({ state: "blocked", reason: REASON })
  expect(before.history.length).toBeGreaterThan(0)
  expect(before.history.filter((entry) => entry.from !== undefined).length).toBeGreaterThan(0)
  expect(before.history.filter((entry) => entry.reason !== undefined).length).toBeGreaterThan(0)
  // The old record sets are all there: every task, obligation and scenario of the plan.
  expect(Object.keys(before.tasks).toSorted()).toEqual(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
}

it.live("[RM24] the old schema names every field of a status file written before the change", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const old: unknown = JSON.parse(yield* fs.readFileString(OLD_FILE))
    // Excess keys refused: the old file has no field that `Before` leaves out, and `Before` requires what it had.
    const exit = Schema.decodeUnknownExit(Before, { onExcessProperty: "error" })(old)
    expect(Exit.isSuccess(exit) ? "decodes" : String(exit.cause)).toBe("decodes")
    // The old file is the observed stuck run: T1.5 waits for ever, with no reason.
    expect(old).toMatchObject({ tasks: { "T1.5": { state: "waiting", waitingOn: ["T1.4"] } } })
  }),
)

it.live(
  '[RM24] a phase-1 fold of the observed facts writes status.json with T1.5 and T1 blocked, reason "blocked by T1.4: budget exhausted"',
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const written = yield* phaseOne(plan)
      expect(written.text.endsWith("\n")).toBe(true)
      expectBlocked(written.text)
    }),
)

it.live("[RM24] the status.json of the phase-1 fold keeps every field it had before the change", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    expectOldFields((yield* phaseOne(plan)).parsed)
  }),
)

it.live(
  '[RM24] the run\'s status writer, recording the observed facts, writes T1.5 and T1 blocked, reason "blocked by T1.4: budget exhausted"',
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const written = yield* recorded(plan)
      expectBlocked(written.text)
    }),
  60_000,
)

it.live(
  "[RM24] the status.json of the run's status writer keeps every field it had before the change",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      expectOldFields((yield* recorded(plan)).parsed)
    }),
  60_000,
)

import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import path from "path"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskCommand } from "@/task/core/command"
import { TaskRunner } from "@/task/core/runner"
import type { Plan, ScenarioState, State, TaskState } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"

// The status projection of the task harness (harness contract, section 3): `waitingOn` and the projected
// `waiting` run state, on the real release-notes and T2 specs. No server, no model.

const it = testEffect(NodeServices.layer)

const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const RELEASE_NOTES = "task-formats/blend/release-notes.spec"
const T2_SPEC = "task-formats/blend/provider-ordering-admin.spec"

const load = Effect.fnUntraced(function* (name: string) {
  const loaded = yield* Blend.load(path.join(formatDir, name))
  expect(loaded.failures).toEqual([])
  if (!loaded.spec) return yield* Effect.die(new Error(`${name} did not load`))
  return loaded.spec
})

// The plan of `/task <spec>`, or of `/task <spec>/<folder>` whose task is `root`.
const planOf = (spec: BlendModel.Spec, specPath: string, sub?: { folder: string; root: string }): Plan =>
  TaskCommand.plan({
    spec,
    specPath,
    path: sub ? `${specPath}/${sub.folder}` : specPath,
    root: Option.fromNullishOr(sub?.root),
  })

const withTasks = (state: State, tasks: Record<string, TaskState>): State => ({
  ...state,
  tasks: Object.fromEntries(
    Object.entries(state.tasks).map(([id, task]) => [id, { ...task, state: tasks[id] ?? task.state }]),
  ),
})

const withScenarios = (state: State, scenarios: Record<string, ScenarioState>): State => ({
  ...state,
  scenarios: Object.fromEntries(
    Object.entries(state.scenarios).map(([id, scenario]) => [id, { ...scenario, state: scenarios[id] ?? scenario.state }]),
  ),
})

const project = (plan: Plan, state: State, outside: ReadonlyArray<string> = []) =>
  TaskStatus.project({ plan, state, outside })

describe("the status projection", () => {
  it.live("a new run waits, and each task waits on its untrusted dependencies, outside ids included", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const status = project(plan, TaskEngineXState.XStateEngine.initial(plan))
      expect(status.run).toEqual({ state: "waiting", spec: RELEASE_NOTES, path: RELEASE_NOTES })
      expect(status.tasks["T1.1"]).toEqual({ state: "waiting", attempts: 0, waitingOn: [] })
      expect(status.tasks["T1.2"]?.waitingOn).toEqual([])
      expect(status.tasks["T1.3"]?.waitingOn).toEqual(["T1.1"])
      expect(status.tasks["T1.4"]?.waitingOn).toEqual(["T1.2", "T1.3"])
      expect(status.tasks["T1.5"]?.waitingOn).toEqual(["T1.3", "T1.4", "T9"])
      expect(status.scenarios["S13"]).toEqual({ state: "waiting", waitingOn: ["T1.4", "T8"] })
      expect(status.scenarios["S1"]?.waitingOn).toEqual(["T1.1", "T1.2", "T1.3", "T1.4"])
      expect(Object.keys(status.obligations)).toHaveLength(31)
      expect(status.obligations["T1.1.c1"]).toEqual({ state: "pending" })
      expect(status.history).toEqual([])
    }),
  )

  it.live("trusted tasks and trusted outside ids leave waitingOn; an untrusted outside id stays", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const trusted = Object.fromEntries(["T1.1", "T1.2", "T1.3", "T1.4"].map((id): [string, TaskState] => [id, "trusted"]))
      const status = project(plan, withTasks(TaskEngineXState.XStateEngine.initial(plan), trusted), ["T9"])
      expect(status.tasks["T1.5"]?.waitingOn).toEqual([])
      expect(status.scenarios["S13"]?.waitingOn).toEqual(["T8"])
      expect(status.scenarios["S1"]?.waitingOn).toEqual([])
      expect(status.scenarios["S5"]?.waitingOn).toEqual(["T1.5"])
    }),
  )

  it.live("the run is running while a task builds, proves or verifies, or a scenario is judged", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const initial = TaskEngineXState.XStateEngine.initial(plan)
      for (const busy of ["building", "proving", "verifying"] as const) {
        expect(project(plan, withTasks(initial, { "T1.1": busy })).run.state).toBe("running")
      }
      const judged = project(plan, withScenarios(initial, { S2: "verifying" }))
      expect(judged.run.state).toBe("running")
      // The contract has no `verifying` scenario: one under judgement shows `pending`.
      expect(judged.scenarios["S2"]?.state).toBe("pending")
      // Trusted everywhere and nothing left waiting: still running until the runner records the end.
      const allTrusted = withTasks(
        withScenarios(initial, Object.fromEntries(Object.keys(initial.scenarios).map((id): [string, ScenarioState] => [id, "trusted"]))),
        Object.fromEntries(Object.keys(initial.tasks).map((id): [string, TaskState] => [id, "trusted"])),
      )
      expect(project(plan, allTrusted).run.state).toBe("running")
    }),
  )

  it.live("an ended run is shown as stored", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const initial = TaskEngineXState.XStateEngine.initial(plan)
      const stopped: State = { ...initial, run: { ...initial.run, state: "budget_exhausted", reason: "T1.1" } }
      expect(project(plan, stopped).run).toEqual({
        state: "budget_exhausted",
        reason: "T1.1",
        spec: RELEASE_NOTES,
        path: RELEASE_NOTES,
      })
    }),
  )

  it.live("a task folder plans its subtree; a dependency outside the plan and not outside is not trusted", () =>
    Effect.gen(function* () {
      const spec = yield* load("release-notes.spec")
      const plan = planOf(spec, RELEASE_NOTES, {
        folder: "T1-release-notes.task/T1.3-markdown-render.task",
        root: "T1.3",
      })
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1.3"])
      // S4 and S12 need T1.3 alone; S1 also needs T1.1, T1.2 and T1.4, which are not in the plan.
      expect(plan.scenarios.map((scenario) => scenario.id)).toEqual(["S4", "S12"])
      expect(plan.budget("T1.3")).toBe(3)
      const status = project(plan, TaskEngineXState.XStateEngine.initial(plan))
      expect(status.tasks["T1.3"]?.waitingOn).toEqual(["T1.1"])
      expect(Object.keys(status.tasks)).toEqual(["T1.3"])
    }),
  )

  it.live("T2 waits only on its outside preconditions and its own siblings", () =>
    Effect.gen(function* () {
      const spec = yield* load("provider-ordering-admin.spec")
      const plan = planOf(spec, T2_SPEC, { folder: "T2-services.task", root: "T2" })
      const ids = ["T2.1", "T2.2", "T2.3", "T2.4", "T2.5", "T2.6"]
      expect(plan.tasks.map((task) => task.id)).toEqual(["T2", ...ids])
      const status = project(plan, TaskEngineXState.XStateEngine.initial(plan))
      const outside = Object.keys(spec.outside)
      for (const id of ids) {
        const task = status.tasks[id]
        expect(task?.state).toBe("waiting")
        expect(task?.waitingOn.length).toBeGreaterThan(0)
        expect(task?.waitingOn.every((wait) => outside.includes(wait) || ids.includes(wait))).toBe(true)
      }
      expect(ids.some((id) => status.tasks[id]?.waitingOn.some((wait) => outside.includes(wait)))).toBe(true)
      expect(status.run.state).toBe("waiting")
    }),
  )

  it.live("a refused status names the rule and has no records", () =>
    Effect.sync(() => {
      const status = TaskStatus.refused({ spec: RELEASE_NOTES, path: RELEASE_NOTES, reason: "R7 .: cycle" })
      expect(status).toEqual({
        run: { state: "refused", reason: "R7 .: cycle", spec: RELEASE_NOTES, path: RELEASE_NOTES },
        tasks: {},
        obligations: {},
        scenarios: {},
        history: [],
      })
    }),
  )

  it.live("write replaces the status file atomically, leaves no temp file, and makes the folder ignore itself", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      yield* TaskStatus.write(directory, TaskStatus.refused({ spec: "x", path: "x", reason: "R1" }))
      yield* TaskStatus.write(directory, project(plan, TaskEngineXState.XStateEngine.initial(plan)))
      const folder = path.join(directory, ".opencode", "task")
      expect((yield* fs.readDirectory(folder)).toSorted()).toEqual([".gitignore", "status.json"])
      expect(yield* fs.readFileString(path.join(folder, ".gitignore"))).toBe("*\n")
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(
        yield* fs.readFileString(path.join(folder, "status.json")),
      )
      expect(decoded.run.state).toBe("waiting")
      expect(decoded.tasks["T1.5"]?.waitingOn).toEqual(["T1.3", "T1.4", "T9"])
    }),
  )

  it.live("a proving pass makes its log at .opencode/task/proofs/<name>.log and empties it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const file = path.join(directory, ".opencode", "task", "proofs", "T1.4.log")
      expect(TaskStatus.proofLogFile(yield* Path.Path, directory, "T1.4")).toBe(file)
      expect(yield* TaskRunner.proofLog(directory, "T1.4")).toBe(file)
      expect(yield* fs.readFileString(file)).toBe("")
      // The next pass starts from an empty file, never from the previous pass's output.
      yield* fs.writeFileString(file, "$ bun test\nexit 1\n")
      yield* TaskRunner.proofLog(directory, "T1.4")
      expect(yield* fs.readFileString(file)).toBe("")
    }),
  )
})

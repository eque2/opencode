import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect"
import path from "path"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskCommand } from "@/task/core/command"
import { TaskRunner } from "@/task/core/runner"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, observed, trustLeaf } from "./lib/machine"

// The status projection of the task harness (harness contract, section 3), through the run machine's snapshot
// (AD-20): `waitingOn`, the run state and the blocked tasks, on the real release-notes and T2 specs. No server, no
// model. The expectations that the machine changes are re-baselined: a new run with ready tasks is running, a
// scenario whose needs are trusted shows pending, and a hand-built State is now a fold of real facts.

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

// The facts of a run of the plan, folded through the engine.
const foldOf = (plan: Plan, list: ReadonlyArray<Fact>) =>
  list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), TaskEngineXState.initial(plan))

const project = (plan: Plan, list: ReadonlyArray<Fact> = []) => TaskStatus.project(plan, foldOf(plan, list))

describe("the status projection", () => {
  it.live("a new run is running its ready tasks, and each unit waits on its untrusted dependencies", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const status = project(plan)
      // Re-baselined: T1.1 and T1.2 are ready, so the machine's outcome is running.
      // Re-baselined (AD-13): every record gains its tags and the contract's fields, so these name the fields they check.
      expect(status.run).toMatchObject({ state: "running", tags: ["active"], spec: RELEASE_NOTES, path: RELEASE_NOTES })
      expect(status.tasks["T1.1"]).toMatchObject({ state: "waiting", tags: ["waiting"], attempts: 0, waitingOn: [] })
      expect(status.tasks["T1.2"]?.waitingOn).toEqual([])
      expect(status.tasks["T1.3"]?.waitingOn).toEqual(["T1.1"])
      expect(status.tasks["T1.4"]?.waitingOn).toEqual(["T1.2", "T1.3"])
      expect(status.tasks["T1.5"]?.waitingOn).toEqual(["T1.3", "T1.4", "T9"])
      expect(status.tasks["T1"]?.waitingOn).toEqual(["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
      expect(status.scenarios["S13"]).toMatchObject({ state: "waiting", waitingOn: ["T1.4", "T8"] })
      expect(status.scenarios["S1"]?.waitingOn).toEqual(["T1.1", "T1.2", "T1.3", "T1.4"])
      expect(Object.keys(status.obligations)).toHaveLength(31)
      expect(status.obligations["T1.1.c1"]).toEqual({ state: "pending", tags: ["waiting"] })
      expect(status.history).toEqual([])
    }),
  )

  it.live("trusted tasks and trusted outside ids leave waitingOn; an untrusted outside id stays", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const f = facts()
      const status = project(plan, [
        f.runStarted(),
        ...["T1.1", "T1.2", "T1.3", "T1.4"].flatMap((id) => trustLeaf(plan, f, id)),
        f.outside("T9"),
      ])
      expect(status.tasks["T1.5"]?.waitingOn).toEqual([])
      expect(status.scenarios["S13"]).toMatchObject({ state: "waiting", waitingOn: ["T8"] })
      // A scenario whose needs are trusted is ready to prove: it shows pending and waits on nothing.
      expect(status.scenarios["S1"]).toMatchObject({ state: "pending", waitingOn: [] })
      expect(status.scenarios["S5"]?.waitingOn).toEqual(["T1.5"])
    }),
  )

  it.live("the run is running while a task builds, proves or verifies, or a scenario is judged", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const f = facts()
      const steps = [f.runStarted(), f.started("T1.1"), f.ready("T1.1"), f.proved("T1.1", [])]
      for (const length of [2, 3, 4]) expect(project(plan, steps.slice(0, length)).run.state).toBe("running")
      const judged = project(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.scenarioProved("S2", "passed")])
      expect(judged.run.state).toBe("running")
      // The contract has no `verifying` scenario: one under judgement shows `pending`.
      expect(judged.scenarios["S2"]?.state).toBe("pending")
      // Re-baselined: every task trusted no longer ends the run; it runs on while the scenarios are proved (D3).
      const tasks = [
        f.runStarted(),
        ...["T1.1", "T1.2", "T1.3", "T1.4"].flatMap((id) => trustLeaf(plan, f, id)),
        f.outside("T9"),
        ...trustLeaf(plan, f, "T1.5"),
        f.proved("T1", []),
        f.verified(
          "T1",
          plan.spec.obligations
            .filter((item) => item.task === "T1")
            .map((item) => ({ id: item.id, verdict: "trusted" as const })),
        ),
      ]
      const trusted = project(plan, tasks)
      expect(Object.values(trusted.tasks).map((task) => task.state)).toEqual(Array(6).fill("trusted"))
      expect(trusted.run.state).toBe("running")
      expect(trusted.scenarios["S1"]?.state).toBe("pending")
    }),
  )

  it.live("an ended run is shown with its outcome and reason", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const f = facts()
      const cancelled = project(plan, [f.runStarted(), f.cancelled("user stop")])
      expect(cancelled.run).toMatchObject({
        state: "cancelled",
        tags: ["ended", "stopped"],
        reason: "user stop",
        spec: RELEASE_NOTES,
        path: RELEASE_NOTES,
      })
      // The cancel cancels every unfinished scenario too, and the contract's schema carries `cancelled` both ways.
      expect(Object.values(cancelled.scenarios).map((scenario) => scenario.state)).toEqual(Array(13).fill("cancelled"))
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(
        Schema.encodeSync(Schema.fromJsonString(TaskStatus.Status))(cancelled),
      )
      expect(decoded.scenarios["S13"]?.state).toBe("cancelled")
      expect(decoded.tasks["T1.5"]?.state).toBe("cancelled")
    }),
  )

  it.live("RM24 the observed facts project T1.5 and T1 as blocked, with the cause as their reason", () =>
    Effect.gen(function* () {
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      const status = project(plan, observed(plan))
      expect(status.tasks["T1.4"]).toMatchObject({ state: "budget_exhausted", attempts: 3 })
      for (const id of ["T1.5", "T1"])
        expect(status.tasks[id]).toMatchObject({
          state: "blocked",
          tags: ["ended", "stopped", "blocked"],
          attempts: 0,
          waitingOn: [],
          reason: "blocked by T1.4: budget exhausted",
          blockedBy: { id: "T1.4", state: "budget_exhausted" },
        })
      expect(status.scenarios["S1"]).toMatchObject({ state: "blocked", reason: "blocked by T1.4: budget exhausted" })
      expect(status.history.filter((entry) => entry.to === "blocked").map((entry) => entry.unit)).toContain("T1.5")
    }),
  )

  // Re-baselined (AD-13): the contract adds required fields (tags, spec id, title, spans, outside, external), so a
  // status file written before it no longer decodes with the harness's schema. Readers decode it with the TUI's open
  // schema, whose new fields are optional (packages/tui test "SV17 decodes the shared projected status ...").
  it.live("a status file written before the contract does not decode with the contract's schema", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const old = yield* fs.readFileString(
        path.resolve(import.meta.dir, "../../../tui/test/task-ui/fixture-status.json"),
      )
      expect(Option.isNone(Schema.decodeUnknownOption(Schema.fromJsonString(TaskStatus.Status))(old))).toBe(true)
    }),
  )

  it.live("a task folder plans its subtree; a folder task outside it is an external region it waits on", () =>
    Effect.gen(function* () {
      const spec = yield* load("release-notes.spec")
      const plan = planOf(spec, RELEASE_NOTES, {
        folder: "T1-release-notes.task/T1.3-markdown-render.task",
        root: "T1.3",
      })
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1.3"])
      expect(plan.external).toEqual(["T1.1"])
      // S4 and S12 need T1.3 alone; S1 also needs T1.1, T1.2 and T1.4, which are not in the plan.
      expect(plan.scenarios.map((scenario) => scenario.id)).toEqual(["S4", "S12"])
      expect(plan.budget("T1.3")).toBe(3)
      const status = project(plan)
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
      const status = project(plan)
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
        run: {
          state: "refused",
          tags: ["ended", "stopped"],
          reason: "R7 .: cycle",
          spec: RELEASE_NOTES,
          specId: "release-notes.spec",
          path: RELEASE_NOTES,
          title: "release-notes.spec",
        },
        tasks: {},
        obligations: {},
        scenarios: {},
        outside: {},
        external: {},
        history: [],
      })
    }),
  )

  it.live("write replaces the status file atomically and leaves no temp file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const plan = planOf(yield* load("release-notes.spec"), RELEASE_NOTES)
      yield* TaskStatus.write(directory, TaskStatus.refused({ spec: "x", path: "x", reason: "R1" }))
      yield* TaskStatus.write(directory, project(plan))
      const folder = path.join(directory, ".opencode", "task")
      expect(yield* fs.readDirectory(folder)).toEqual(["status.json"])
      const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(TaskStatus.Status))(
        yield* fs.readFileString(path.join(folder, "status.json")),
      )
      expect(decoded.run.state).toBe("running")
      expect(decoded.tasks["T1.5"]?.waitingOn).toEqual(["T1.3", "T1.4", "T9"])
    }),
  )

  it.live("a status write that fails is logged, not raised, and writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      // `.opencode` is a plain file, so the status folder cannot be made.
      yield* fs.writeFileString(path.join(directory, ".opencode"), "not a folder")
      const exit = yield* Effect.exit(
        TaskStatus.write(directory, TaskStatus.refused({ spec: "x", path: "x", reason: "R1" })),
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* fs.readFileString(path.join(directory, ".opencode"))).toBe("not a folder")
      expect(yield* fs.readDirectory(directory)).toEqual([".opencode"])
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

import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option } from "effect"
import path from "path"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts } from "./lib/machine"

// Scenario RM11 (spec task-harness-feedback, D2, D3, AC 4, SD-18, T1.4): the outcome is the state of the task that
// died first, and the reason lists every dead and blocked task.
//
//   Given a run where T1.1 needs a human first, T1.2 fails later, and T1.3 is blocked by T1.1
//   When every region is final
//   Then the run outcome is needs human
//   And the run reason has one line for T1.1, one line for T1.2, then one line "T1.3 blocked by T1.1"
//
// The plan is a spec folder written to a temporary directory and loaded by the real loader (`Blend.load`, then
// `TaskCommand.plan`): the parent T1 that rule R2 requires, leaves T1.1 and T1.2 with no `after`, and leaf T1.3
// after T1.1. The facts fold through the engine API (`initial`, `apply`); the run is read through the status
// projection (`TaskStatus.project`, the status file) and the engine's `ended`. The parent T1 waits on its children,
// so it is blocked too, and the reason lists it as a blocked task (the title's "every dead and blocked task").

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const leafTask = (title: string, file: string, after: ReadonlyArray<string>) =>
  [
    "---",
    ...(after.length === 0 ? [] : [`after: [${after.join(", ")}]`]),
    "touches:",
    `  - path: src/${file}.ts`,
    "    change: new",
    `    what: "the ${file} function"`,
    "refs: [EX-D1]",
    "---",
    "",
    `# ${title}`,
    "",
    "## Goal",
    "",
    `Add ${title.toLowerCase()}.`,
    "",
  ].join("\n")

const leafVerify = (file: string, text: string) =>
  [
    "---",
    `hint: test/${file}.test.ts`,
    "ensures:",
    "  c1:",
    "    category: happy-path",
    `    text: "${text}"`,
    "---",
    "",
    "# Verify",
    "",
    "Each obligation is proved by a passing test whose title starts with its qualified id.",
    "",
  ].join("\n")

// The scenario's spec folder: T1.3 comes after T1.1; T1.1 and T1.2 are independent.
const FILES: Readonly<Record<string, string>> = {
  "SPEC.md": [
    "---",
    "format: task-spec/1",
    "policy:",
    "  redFirst: true",
    "  proofBinding: title-tag",
    "  structural: touches-plus-tests",
    "  review: parent-diff",
    "  trust: independent-verifier",
    "  acceptance: after-all-needs-trusted",
    "  evidence: [exit-code, counts, run-id, commit]",
    "  budgets: {taskAttempts: 3, retries: 2}",
    "  judges:",
    "    test: [runner, verifier]",
    "    gate: [runner]",
    "    unchanged: [engine]",
    "    review: [reviewer]",
    "gates:",
    "  BUILD-1:",
    '    title: "Type check passes"',
    '    command: "bun run typecheck"',
    '    requires: "Bun 1.3"',
    "refs:",
    '  EX-D1: "Plain TypeScript with no runtime dependency."',
    "---",
    "",
    "# Three helpers, one after another",
    "",
    "T1.3 comes after T1.1; T1.2 depends on nothing.",
    "",
  ].join("\n"),
  "T1-helpers.task/TASK.md": ["---", "---", "", "# Helpers", "", "## Goal", "", "Three small helpers.", ""].join("\n"),
  "T1-helpers.task/VERIFY.md": [
    "---",
    "ensures:",
    "  e1:",
    '    text: "The T1 diff passes one independent review once every child is trusted."',
    "    proof: review",
    "---",
    "",
    "# Verify",
    "",
    "A parent is trusted when every child is trusted and its own obligations are met.",
    "",
  ].join("\n"),
  "T1-helpers.task/T1.1-sum.task/TASK.md": leafTask("A sum of numbers", "sum", []),
  "T1-helpers.task/T1.1-sum.task/VERIFY.md": leafVerify("sum", "`sum([1, 2, 3])` is `6`."),
  "T1-helpers.task/T1.2-clamp.task/TASK.md": leafTask("A clamp of a number", "clamp", []),
  "T1-helpers.task/T1.2-clamp.task/VERIFY.md": leafVerify("clamp", "`clamp(5, 0, 3)` is `3`."),
  "T1-helpers.task/T1.3-mean.task/TASK.md": leafTask("A mean of numbers", "mean", ["T1.1"]),
  "T1-helpers.task/T1.3-mean.task/VERIFY.md": leafVerify("mean", "`mean([1, 2, 3, 4])` is `2.5`."),
}

// The plan of `/task example-first-death.spec`, from the folder written to a scoped temporary directory.
const loadFirstDeath = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const dir = path.join(root, "example-first-death.spec")
  for (const [file, text] of Object.entries(FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
    yield* fs.writeFileString(path.join(dir, file), text)
  }
  const loaded = yield* Blend.load(dir)
  expect(loaded.failures).toEqual([])
  if (!loaded.spec) return yield* Effect.die("the RM11 spec folder did not load")
  return TaskCommand.plan({
    spec: loaded.spec,
    specPath: "example-first-death.spec",
    path: "example-first-death.spec",
    root: Option.none(),
  })
})

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const HUMAN = "spend cap: $5.00 reached"
const DIED = "the builder session died"

// Every task region is final: each task carries the `ended` class tag in the status file.
const everyTaskEnded = (plan: Plan, snapshot: RunSnapshot) =>
  Object.values(TaskStatus.project(plan, snapshot).tasks).every((task) => task.tags.includes("ended"))

// Every task that the status file shows as dead or blocked.
const deadOrBlocked = (plan: Plan, snapshot: RunSnapshot) =>
  Object.entries(TaskStatus.project(plan, snapshot).tasks)
    .filter(([, task]) => task.tags.includes("dead") || task.tags.includes("blocked"))
    .map(([id]) => id)

it.live(
  "[RM11] T1.1 needs a human first and T1.2 fails later: once every region is final the outcome is needs human, and the reason lists every dead and blocked task",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadFirstDeath()
      expect(plan.tasks.map((task) => [task.id, task.afterEffective])).toEqual([
        ["T1", []],
        ["T1.1", []],
        ["T1.2", []],
        ["T1.3", ["T1.1"]],
      ])
      const f = facts()
      const building = fold(plan, [f.runStarted(), f.started("T1.1"), f.started("T1.2")])
      expect(["T1.1", "T1.2", "T1.3"].map((id) => engine.unitState(building, id))).toEqual([
        "building",
        "building",
        "waiting",
      ])

      // Given: T1.1 needs a human first, and T1.3, which comes after it, is blocked by it at once.
      const human = engine.apply(plan, building, f.needsHuman("T1.1", HUMAN))
      expect(engine.unitState(human, "T1.1")).toBe("needs_human")
      expect(engine.unitState(human, "T1.3")).toBe("blocked")
      expect(engine.blockedBy(human, "T1.3")).toEqual({ id: "T1.1", state: "needs_human" })
      const t13 = TaskStatus.project(plan, human).tasks["T1.3"]
      expect(t13?.blockedBy).toEqual({ id: "T1.1", state: "needs_human" })
      expect(t13?.reason).toBe("blocked by T1.1: needs human")
      // T1.2 still builds, so not every region is final and the run has not settled.
      expect(engine.unitState(human, "T1.2")).toBe("building")
      expect(everyTaskEnded(plan, human)).toBe(false)
      expect(engine.ended(human)).toBe(false)
      expect(TaskStatus.project(plan, human).run.state).toBe("running")
      expect(TaskStatus.project(plan, human).run.reason).toBeUndefined()

      // When: T1.2 fails later, and every region is final.
      const settled = engine.apply(plan, human, f.failed("T1.2", DIED))
      expect(engine.unitState(settled, "T1.2")).toBe("failed")
      expect(everyTaskEnded(plan, settled)).toBe(true)
      expect(engine.ended(settled)).toBe(true)
      // T1.1 died before T1.2 in the history.
      const log = settled.context.log
      const firstDeath = log.findIndex((entry) => entry.unit === "T1.1" && entry.to === "needs_human")
      const laterDeath = log.findIndex((entry) => entry.unit === "T1.2" && entry.to === "failed")
      expect(firstDeath).toBeGreaterThan(-1)
      expect(laterDeath).toBeGreaterThan(firstDeath)

      // Then: the outcome is needs human, the state of the task that died first.
      const run = TaskStatus.project(plan, settled).run
      expect(run.state).toBe("needs_human")
      expect(engine.view(settled).run.state).toBe("needs_human")
      expect(run.tags).toEqual(["ended", "stopped"])

      // And: the reason has one line for T1.1, one for T1.2, then the line "T1.3 blocked by T1.1".
      const lines = (run.reason ?? "").split("\n")
      expect(lines.filter((line) => line.startsWith("T1.1 "))).toEqual(["T1.1 needs human"])
      expect(lines.filter((line) => line.startsWith("T1.2 "))).toEqual(["T1.2 failed"])
      expect(lines.filter((line) => line === "T1.3 blocked by T1.1")).toHaveLength(1)
      expect(lines.indexOf("T1.1 needs human")).toBeLessThan(lines.indexOf("T1.2 failed"))
      expect(lines.indexOf("T1.2 failed")).toBeLessThan(lines.indexOf("T1.3 blocked by T1.1"))
      // Every dead and blocked task has exactly one line, and there is no other line: the dead tasks first, then
      // the blocked ones (the R2 parent T1 is blocked by its child T1.1 too), each group in natural id order.
      expect(deadOrBlocked(plan, settled)).toEqual(["T1", "T1.1", "T1.2", "T1.3"])
      for (const id of deadOrBlocked(plan, settled))
        expect(lines.filter((line) => line.startsWith(`${id} `))).toHaveLength(1)
      expect(lines).toEqual(["T1.1 needs human", "T1.2 failed", "T1 blocked by T1.1", "T1.3 blocked by T1.1"])
    }),
)

it.live("[RM11] the order of the deaths decides the outcome: when T1.2 fails first, the outcome is failed", () =>
  Effect.gen(function* () {
    const plan = yield* loadFirstDeath()
    const f = facts()
    const building = fold(plan, [f.runStarted(), f.started("T1.1"), f.started("T1.2")])
    // The same two deaths in the other order: T1.2 fails first, then T1.1 needs a human.
    const failed = engine.apply(plan, building, f.failed("T1.2", DIED))
    expect(engine.ended(failed)).toBe(false)
    const settled = engine.apply(plan, failed, f.needsHuman("T1.1", HUMAN))
    expect(engine.ended(settled)).toBe(true)
    const run = TaskStatus.project(plan, settled).run
    expect(run.state).toBe("failed")
    // The lines keep the natural id order; T1 is blocked by T1.2, the first child that died.
    expect((run.reason ?? "").split("\n")).toEqual([
      "T1.1 needs human",
      "T1.2 failed",
      "T1 blocked by T1.2",
      "T1.3 blocked by T1.1",
    ])
  }),
)

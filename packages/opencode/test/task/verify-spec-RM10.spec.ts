import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option } from "effect"
import path from "path"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, fail, judge, trust } from "./lib/machine"

// Scenario RM10 (spec task-harness-feedback, D3, AD-4, T1.4 and T1.11): independent work runs to its end before the
// run settles.
//
//   Given a plan with two independent leaves T1.1 and T1.2, both building
//   When T1.1 is budget exhausted
//   Then the run keeps running while T1.2 builds, proves and is verified
//   And the run settles only when T1.2 reaches a final state
//   And the run outcome is then budget exhausted
//
// The plan is a spec folder written to a temporary directory and loaded by the real loader (`Blend.load`, then
// `TaskCommand.plan`): the parent T1 that rule R2 requires, and its two leaves T1.1 and T1.2 with no `after`, each
// with one test obligation, budget 3. The facts fold through the engine API (`initial`, `apply`). The run is read
// through the status projection (`TaskStatus.project`, the status file), the engine's `ended` and the run
// supervisor's choice of the units it supervises (`RunSupervisor.supervised`).

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const POLICY = [
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
]

const leaf = (title: string, file: string, text: string) => ({
  task: [
    "---",
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
  ].join("\n"),
  verify: [
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
  ].join("\n"),
})

const SUM = leaf("A sum of numbers", "sum", "`sum([1, 2, 3])` is `6`.")
const CLAMP = leaf("A clamp of a number", "clamp", "`clamp(5, 0, 3)` is `3`.")

// The scenario's spec folder: two independent leaves under one parent.
const FILES: Readonly<Record<string, string>> = {
  "SPEC.md": [
    "---",
    "format: task-spec/1",
    ...POLICY,
    "gates:",
    "  BUILD-1:",
    '    title: "Type check passes"',
    '    command: "bun run typecheck"',
    '    requires: "Bun 1.3"',
    "refs:",
    '  EX-D1: "Plain TypeScript with no runtime dependency."',
    "---",
    "",
    "# Two independent helpers",
    "",
    "T1.1 and T1.2 do not depend on each other.",
    "",
  ].join("\n"),
  "T1-helpers.task/TASK.md": ["---", "---", "", "# Helpers", "", "## Goal", "", "Two small helpers.", ""].join("\n"),
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
  "T1-helpers.task/T1.1-sum.task/TASK.md": SUM.task,
  "T1-helpers.task/T1.1-sum.task/VERIFY.md": SUM.verify,
  "T1-helpers.task/T1.2-clamp.task/TASK.md": CLAMP.task,
  "T1-helpers.task/T1.2-clamp.task/VERIFY.md": CLAMP.verify,
}

// The plan of `/task example-independent.spec`, from the folder written to a scoped temporary directory.
const loadIndependent = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const dir = path.join(root, "example-independent.spec")
  for (const [file, text] of Object.entries(FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
    yield* fs.writeFileString(path.join(dir, file), text)
  }
  const loaded = yield* Blend.load(dir)
  expect(loaded.failures).toEqual([])
  if (!loaded.spec) return yield* Effect.die("the RM10 spec folder did not load")
  return TaskCommand.plan({
    spec: loaded.spec,
    specPath: "example-independent.spec",
    path: "example-independent.spec",
    root: Option.none(),
  })
})

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

interface RunView {
  readonly ended: boolean
  readonly state: string
  readonly tags: ReadonlyArray<string>
  readonly reason: string | undefined
}

// The run as the status file shows it, and whether the engine counts it as ended.
const runOf = (plan: Plan, snapshot: RunSnapshot): RunView => {
  const run = TaskStatus.project(plan, snapshot).run
  return { ended: engine.ended(snapshot), state: run.state, tags: run.tags, reason: run.reason }
}

const RUNNING = { ended: false, state: "running", tags: ["active"], reason: undefined }

const PROOF_FAILS = "the test asserts only that the function exists"

// The run with T1.1 and T1.2 both building, and T1.1 one failing proof short of its budget of 3.
const beforeExhaustion = (plan: Plan, f: ReturnType<typeof facts>) =>
  fold(plan, [
    f.runStarted(),
    f.started("T1.1"),
    f.started("T1.2"),
    f.ready("T1.1"),
    f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]),
    f.ready("T1.1"),
    f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]),
    f.ready("T1.1"),
  ])

it.live("[RM10] the plan holds two independent leaves T1.1 and T1.2, and both are building", () =>
  Effect.gen(function* () {
    const plan = yield* loadIndependent()
    // R2 makes every top-level id T<n>: the two leaves sit under the parent T1, and neither waits on the other.
    expect(plan.tasks.map((task) => [task.id, task.children, task.afterEffective])).toEqual([
      ["T1", ["T1.1", "T1.2"], []],
      ["T1.1", [], []],
      ["T1.2", [], []],
    ])
    expect(plan.scenarios).toEqual([])
    expect(plan.budget("T1.1")).toBe(3)
    const f = facts()
    const started = fold(plan, [f.runStarted()])
    // Both leaves are ready at once: neither waits on the other.
    expect(RunSupervisor.supervised(plan, started)).toEqual({ "T1.1": "task", "T1.2": "task" })
    const building = fold(plan, [f.started("T1.1"), f.started("T1.2")], started)
    expect(["T1.1", "T1.2"].map((id) => engine.unitState(building, id))).toEqual(["building", "building"])
    expect(runOf(plan, building)).toEqual(RUNNING)
  }),
)

it.live(
  "[RM10] after T1.1 is budget exhausted the run keeps running while T1.2 builds, proves and is verified, and settles budget exhausted only when T1.2 is final",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadIndependent()
      const f = facts()
      const before = beforeExhaustion(plan, f)
      expect(engine.unitState(before, "T1.1")).toBe("proving")
      expect(engine.view(before).tasks["T1.1"]?.attempts).toBe(3)

      // When: the third failing proof exhausts the budget of T1.1.
      const exhausted = engine.apply(plan, before, f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]))
      expect(engine.unitState(exhausted, "T1.1")).toBe("budget_exhausted")
      expect(engine.unitState(exhausted, "T1")).toBe("blocked")
      expect(engine.blockedBy(exhausted, "T1")).toEqual({ id: "T1.1", state: "budget_exhausted" })

      // Then: the run keeps running, and the run supervisor still supervises T1.2, in each phase of T1.2.
      const live = (snapshot: RunSnapshot, phase: string) => {
        expect(engine.unitState(snapshot, "T1.2")).toBe(phase)
        expect(runOf(plan, snapshot)).toEqual(RUNNING)
        expect(RunSupervisor.supervised(plan, snapshot)).toEqual({ "T1.2": "task" })
        return snapshot
      }
      const building = live(exhausted, "building")
      const proving = live(engine.apply(plan, building, f.ready("T1.2")), "proving")
      const lastLive = live(engine.apply(plan, proving, f.proved("T1.2", [judge("T1.2.c1")])), "verifying")
      // No outcome entry is written while T1.2 is still in hand.
      expect(lastLive.context.log.filter((entry) => entry.unit === "run").map((entry) => entry.to)).toEqual(["running"])

      // And: the verdict makes T1.2 trusted, its final state, and only then does the run settle.
      const done = engine.apply(plan, lastLive, f.verified("T1.2", [trust("T1.2.c1")]))
      expect(engine.unitState(done, "T1.2")).toBe("trusted")
      expect(runOf(plan, done)).toEqual({
        ended: true,
        state: "budget_exhausted",
        tags: ["ended", "stopped"],
        reason: ["T1.1 budget exhausted", "T1 blocked by T1.1"].join("\n"),
      })
      expect(RunSupervisor.supervised(plan, done)).toEqual({})
      // The run's outcome entry is the last move of the run, after the entry that made T1.2 final.
      const log = done.context.log
      const finalT12 = log.findIndex((entry) => entry.unit === "T1.2" && entry.to === "trusted")
      const settled = log.findIndex((entry) => entry.unit === "run" && entry.to === "budget_exhausted")
      expect(finalT12).toBeGreaterThan(-1)
      expect(settled).toBeGreaterThan(finalT12)
      expect(log.filter((entry) => entry.unit === "run").map((entry) => entry.to)).toEqual([
        "running",
        "budget_exhausted",
      ])
      // A fact after the run settled changes nothing.
      expect(engine.apply(plan, done, f.failed("T1.2", "late"))).toBe(done)
    }),
)

it.live(
  "[RM10] the run settles on whichever final state T1.2 reaches, and the outcome stays the budget exhaustion of T1.1",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadIndependent()
      const f = facts()
      const exhausted = engine.apply(plan, beforeExhaustion(plan, f), f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]))
      expect(runOf(plan, exhausted)).toEqual(RUNNING)

      // T1.2 fails while it builds: final, so the run settles, in the state of the task that died first.
      const failed = engine.apply(plan, exhausted, f.failed("T1.2", "the builder session died"))
      expect(engine.unitState(failed, "T1.2")).toBe("failed")
      expect(runOf(plan, failed)).toEqual({
        ended: true,
        state: "budget_exhausted",
        tags: ["ended", "stopped"],
        reason: ["T1.1 budget exhausted", "T1.2 failed", "T1 blocked by T1.1"].join("\n"),
      })

      // T1.2 needs a human while it proves: the run waits for it in proving, then settles the same way.
      const proving = engine.apply(plan, exhausted, f.ready("T1.2"))
      expect(runOf(plan, proving)).toEqual(RUNNING)
      const human = engine.apply(plan, proving, f.needsHuman("T1.2", "spend cap: $5.00 reached"))
      expect(engine.unitState(human, "T1.2")).toBe("needs_human")
      expect(runOf(plan, human)).toEqual({
        ended: true,
        state: "budget_exhausted",
        tags: ["ended", "stopped"],
        reason: ["T1.1 budget exhausted", "T1.2 needs human", "T1 blocked by T1.1"].join("\n"),
      })
    }),
)

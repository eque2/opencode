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
import { facts, fail } from "./lib/machine"

// Scenario RM27 (spec task-harness-feedback, AC 4, default 4, SD-18, T1.4 and T1.7): a task that died before a stop
// gives the end state, and the stop cancels unfinished units.
//
//   Given T1.1 budget exhausted, T1.4 blocked by T1.1, an independent T1.2 building, and S1 waiting
//   When run.cancelled is applied with the reason "user stop"
//   Then the run outcome is budget exhausted, the state of the task that died first
//   And the run reason holds the line for T1.1, then the line "T1.4 blocked by T1.1", then the line "user stop"
//   And T1.2 and S1 are cancelled, and T1.1 stays budget exhausted
//
// The plan is a spec folder written to a temporary directory and loaded by the real loader (`Blend.load`, then
// `TaskCommand.plan`): the parent T1 that rule R2 requires, its leaves T1.1, T1.2 and T1.4 (T1.4 after T1.1), each
// with one test obligation, budget 3, and the scenario S1 that needs T1.2. The facts fold through the engine API
// (`initial`, `apply`); the run is read through `view`, the selectors, the history and the status projection.

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

const leaf = (title: string, file: string, text: string, after: ReadonlyArray<string> = []) => ({
  task: [
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
const MEAN = leaf("A mean of numbers", "mean", "`mean([1, 2, 3])` is `2`.", ["T1.1"])

// The scenario's spec folder: T1.4 waits on T1.1; T1.2 and S1 do not depend on T1.1.
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
    "# Number helpers",
    "",
    "T1.4 builds on T1.1; T1.2 is independent, and the scenario S1 needs only T1.2.",
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
  "T1-helpers.task/T1.1-sum.task/TASK.md": SUM.task,
  "T1-helpers.task/T1.1-sum.task/VERIFY.md": SUM.verify,
  "T1-helpers.task/T1.2-clamp.task/TASK.md": CLAMP.task,
  "T1-helpers.task/T1.2-clamp.task/VERIFY.md": CLAMP.verify,
  "T1-helpers.task/T1.4-mean.task/TASK.md": MEAN.task,
  "T1-helpers.task/T1.4-mean.task/VERIFY.md": MEAN.verify,
  "acceptance/S1.md": [
    "---",
    "needs: [T1.2]",
    'category: "Core Business Outcomes"',
    "---",
    "",
    "```gherkin",
    "@core",
    "Scenario: S1 A number is clamped to its range",
    "  Given the number 5 and the range 0 to 3",
    "  When the maintainer clamps it",
    "  Then the result is 3",
    "```",
    "",
  ].join("\n"),
}

const SPEC = "example-stop.spec"

// The plan of `/task example-stop.spec`, from the folder written to a scoped temporary directory.
const loadStop = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const dir = path.join(root, SPEC)
  for (const [file, text] of Object.entries(FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
    yield* fs.writeFileString(path.join(dir, file), text)
  }
  const loaded = yield* Blend.load(dir)
  expect(loaded.failures).toEqual([])
  if (!loaded.spec) return yield* Effect.die("the RM27 spec folder did not load")
  return TaskCommand.plan({ spec: loaded.spec, specPath: SPEC, path: SPEC, root: Option.none() })
})

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const PROOF_FAILS = "the test asserts only that the function exists"
const REASON = "user stop"

// The Given: T1.2 building, then T1.1 built and failing its proof on each of its three attempts.
const given = (plan: Plan, f: ReturnType<typeof facts>) =>
  fold(plan, [
    f.runStarted(),
    f.started("T1.2"),
    f.started("T1.1"),
    f.ready("T1.1"),
    f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]),
    f.ready("T1.1"),
    f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]),
    f.ready("T1.1"),
    f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]),
  ])

const states = (snapshot: RunSnapshot) => {
  const view = engine.view(snapshot)
  return {
    run: view.run.state,
    T1: view.tasks.T1?.state,
    "T1.1": view.tasks["T1.1"]?.state,
    "T1.2": view.tasks["T1.2"]?.state,
    "T1.4": view.tasks["T1.4"]?.state,
    S1: view.scenarios.S1?.state,
  }
}

it.live("[RM27] the plan: T1.4 after T1.1, an independent T1.2, and S1 needing T1.2", () =>
  Effect.gen(function* () {
    const plan = yield* loadStop()
    expect(plan.tasks.map((task) => [task.id, task.afterEffective, task.children])).toEqual([
      ["T1", [], ["T1.1", "T1.2", "T1.4"]],
      ["T1.1", [], []],
      ["T1.2", [], []],
      ["T1.4", ["T1.1"], []],
    ])
    expect(plan.scenarios.map((scenario) => [scenario.id, scenario.needs])).toEqual([["S1", ["T1.2"]]])
    expect(plan.budget("T1.1")).toBe(3)
  }),
)

it.live("[RM27] given T1.1 budget exhausted, T1.4 blocked by T1.1, T1.2 building and S1 waiting", () =>
  Effect.gen(function* () {
    const plan = yield* loadStop()
    const before = given(plan, facts())
    expect(before.status).toBe("active")
    expect(states(before)).toEqual({
      run: "running",
      T1: "blocked",
      "T1.1": "budget_exhausted",
      "T1.2": "building",
      "T1.4": "blocked",
      S1: "waiting",
    })
    expect(engine.view(before).tasks["T1.1"]?.attempts).toBe(3)
    expect(engine.blockedBy(before, "T1.4")).toEqual({ id: "T1.1", state: "budget_exhausted" })
    expect(engine.waitingOn(before, "S1")).toEqual(["T1.2"])
    // The run has not settled: T1.2 still builds and S1 still waits.
    expect(engine.ended(before)).toBe(false)
    expect(engine.stopOf(before)).toEqual(Option.none())
  }),
)

it.live(
  '[RM27] run.cancelled "user stop" ends the run budget exhausted, the state of the task that died first (AC 4)',
  () =>
    Effect.gen(function* () {
      const plan = yield* loadStop()
      const f = facts()
      const before = given(plan, f)
      const stop = f.cancelled(REASON)
      const after = engine.apply(plan, before, stop)
      expect(after.status).toBe("done")
      expect(engine.ended(after)).toBe(true)
      expect(engine.view(after).run.state).toBe("budget_exhausted")
      expect(engine.stopOf(after)).toEqual(Option.some({ state: "cancelled", reason: REASON }))
      // The run's history entry: from running to the dead task's state, at the stop's time.
      expect(after.context.log.filter((entry) => entry.unit === "run").at(-1)).toMatchObject({
        at: stop.at,
        from: "running",
        to: "budget_exhausted",
      })
      // The status file says the same.
      expect(TaskStatus.project(plan, after).run).toMatchObject({
        state: "budget_exhausted",
        tags: ["ended", "stopped"],
      })
    }),
)

it.live('[RM27] the run reason holds the T1.1 line, then "T1.4 blocked by T1.1", then "user stop"', () =>
  Effect.gen(function* () {
    const plan = yield* loadStop()
    const f = facts()
    const after = engine.apply(plan, given(plan, f), f.cancelled(REASON))
    const reason = engine.view(after).run.reason ?? ""
    // The dead task's line, each blocked task's line in natural id order, then the stop's reason line.
    expect(reason).toBe(["T1.1 budget exhausted", "T1 blocked by T1.1", "T1.4 blocked by T1.1", REASON].join("\n"))
    const lines = reason.split("\n")
    const dead = lines.indexOf("T1.1 budget exhausted")
    const blocked = lines.indexOf("T1.4 blocked by T1.1")
    const stop = lines.indexOf(REASON)
    expect(dead).toBeGreaterThanOrEqual(0)
    expect(blocked).toBeGreaterThan(dead)
    expect(stop).toBeGreaterThan(blocked)
    expect(stop).toBe(lines.length - 1)
    expect(TaskStatus.project(plan, after).run.reason).toBe(reason)
  }),
)

it.live("[RM27] T1.2 and S1 are cancelled, T1.1 stays budget exhausted, and the blocked tasks stay blocked", () =>
  Effect.gen(function* () {
    const plan = yield* loadStop()
    const f = facts()
    const before = given(plan, f)
    const stop = f.cancelled(REASON)
    const after = engine.apply(plan, before, stop)
    expect(states(after)).toEqual({
      run: "budget_exhausted",
      T1: "blocked",
      "T1.1": "budget_exhausted",
      "T1.2": "cancelled",
      "T1.4": "blocked",
      S1: "cancelled",
    })
    const view = engine.view(after)
    expect(view.tasks["T1.2"]?.reason).toBe(REASON)
    expect(view.scenarios.S1?.reason).toBe(REASON)
    // T1.1 keeps its state, attempts and reason from before the stop.
    expect(view.tasks["T1.1"]).toEqual(engine.view(before).tasks["T1.1"])
    // The stop's entries: T1.2 and S1 move to cancelled with the stop's reason; T1.1 has no entry after its death.
    const moves = after.context.log.slice(before.context.log.length)
    expect(
      moves.filter((entry) => entry.unit !== "run").map(({ unit, from, to, reason }) => ({ unit, from, to, reason })),
    ).toEqual([
      { unit: "T1.2", from: "building", to: "cancelled", reason: REASON },
      { unit: "S1", from: "waiting", to: "cancelled", reason: REASON },
    ])
    expect(moves.some((entry) => entry.unit === "T1.1")).toBe(false)
  }),
)

it.live("[RM27] the same stop with no dead task ends cancelled with the stop's reason (rule 2)", () =>
  Effect.gen(function* () {
    const plan = yield* loadStop()
    const f = facts()
    // T1.1 is still in its last proof round: no task has died.
    const going = fold(plan, [
      f.runStarted(),
      f.started("T1.2"),
      f.started("T1.1"),
      f.ready("T1.1"),
      f.proved("T1.1", [fail("T1.1.c1", PROOF_FAILS)]),
      f.ready("T1.1"),
    ])
    const after = engine.apply(plan, going, f.cancelled(REASON))
    expect(states(after)).toEqual({
      run: "cancelled",
      T1: "cancelled",
      "T1.1": "cancelled",
      "T1.2": "cancelled",
      "T1.4": "cancelled",
      S1: "cancelled",
    })
    expect(engine.view(after).run.reason).toBe(REASON)
  }),
)

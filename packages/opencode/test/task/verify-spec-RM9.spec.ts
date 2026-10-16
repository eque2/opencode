import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem, Option, Path } from "effect"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts } from "./lib/machine"

// Scenario RM9 (spec task-harness-feedback, spine AD-3, AD-5): the cascade is transitive and names the first dead
// dependency.
//
//   Given a plan where T3 is after T2, T2 is after T1, and scenario S1 needs T3
//   When T1 fails
//   Then T2 is blocked by T1 and T3 is blocked by T2 in the same fold step
//   And S1 is blocked by T3
//   And a task with two dead dependencies names the first one in dependency order
//
// The test writes a small blend spec folder in a temporary directory and loads it with the real loader (`Blend.load`,
// then `TaskCommand.plan`), so the dependency order is the loader's. Leaves T1 to T6 are top-level tasks: T2 is after
// T1, T3 after T2, and S1 needs T3. For the last step, T4 is also after T1, so T2 and T4 die in the same microstep; T5
// is after [T4, T2] and T6 after [T2, T4], each written in that order, so the first dependency in dependency order is
// not the first in id order for T5. The facts go through the engine API (`initial`, one `apply` for the failure, the
// selectors, `view`) and the status projection (`TaskStatus.project`).

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const POLICY = `format: task-spec/1
policy:
  redFirst: true
  proofBinding: title-tag
  structural: touches-plus-tests
  review: parent-diff
  trust: independent-verifier
  acceptance: after-all-needs-trusted
  evidence: [exit-code, counts, run-id, commit]
  budgets: {taskAttempts: 3, retries: 1}
  judges:
    test: [runner, verifier]
    gate: [runner]
    unchanged: [engine]
    review: [reviewer]
gates:
  BUILD-1:
    title: "Tests pass"
    command: "bun test"
refs:
  EX-D1: "Plain TypeScript with no runtime dependency."`

// One top-level leaf: its TASK.md (after, one touch, the H1, a goal) and its VERIFY.md (one ensures case).
const leaf = (id: string, after: ReadonlyArray<string>): Readonly<Record<string, string>> => {
  const dir = `${id}-step-${id.slice(1)}.task`
  return {
    [`${dir}/TASK.md`]: [
      "---",
      ...(after.length === 0 ? [] : [`after: [${after.join(", ")}]`]),
      "touches:",
      `  - path: src/${id.toLowerCase()}.ts`,
      "    change: new",
      `    what: "step ${id}"`,
      "---",
      "",
      `# Step ${id}`,
      "",
      "## Goal",
      "",
      `Do step ${id}.`,
      "",
    ].join("\n"),
    [`${dir}/VERIFY.md`]: [
      "---",
      "ensures:",
      "  c1:",
      "    category: happy-path",
      `    text: "step ${id} works"`,
      "---",
      "",
      "# Verify",
      "",
    ].join("\n"),
  }
}

const FILES: Readonly<Record<string, string>> = {
  "SPEC.md": `---\n${POLICY}\n---\n\n# A chain of steps\n\nThe RM9 plan: T3 after T2, T2 after T1, S1 needs T3.\n`,
  ...leaf("T1", []),
  ...leaf("T2", ["T1"]),
  ...leaf("T3", ["T2"]),
  ...leaf("T4", ["T1"]),
  ...leaf("T5", ["T4", "T2"]),
  ...leaf("T6", ["T2", "T4"]),
  "acceptance/S1.md": [
    "---",
    "needs: [T3]",
    'category: "Core Business Outcomes"',
    "---",
    "",
    "```gherkin",
    "@core",
    "Scenario: S1 The last step is reached",
    "  Given the chain of steps",
    "  When every step is done",
    "  Then the last step is reached",
    "```",
    "",
  ].join("\n"),
}

// The plan of `/task <tmp>/rm9-chain.spec`, through the real loader.
const loadChain = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rm9-" })
  const specDir = path.join(root, "rm9-chain.spec")
  for (const [file, text] of Object.entries(FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(specDir, file)), { recursive: true })
    yield* fs.writeFileString(path.join(specDir, file), text)
  }
  const loaded = yield* Blend.load(specDir)
  if (!loaded.spec) return yield* Effect.die(new Error(`the RM9 spec did not load: ${JSON.stringify(loaded.failures)}`))
  expect(loaded.failures).toEqual([])
  const specPath = "rm9-chain.spec"
  return TaskCommand.plan({ spec: loaded.spec, specPath, path: specPath, root: Option.none() })
})

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

// The run started and T1 building, then the one fold step of T1's failure.
const scenario = Effect.gen(function* () {
  const plan = yield* loadChain
  const f = facts()
  const before = fold(plan, [f.runStarted(), f.started("T1")])
  const failure = f.failed("T1", "the builder session died")
  const after = engine.apply(plan, before, failure)
  return { plan, before, after }
})

const DEPENDANTS = ["T2", "T3", "T4", "T5", "T6", "S1"]

it.live("[RM9] the plan: T3 after T2, T2 after T1, S1 needs T3, from the loader", () =>
  Effect.gen(function* () {
    const { plan, before } = yield* scenario
    expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"])
    const afterOf = (id: string) => plan.tasks.find((task) => task.id === id)?.afterEffective
    expect(afterOf("T2")).toEqual(["T1"])
    expect(afterOf("T3")).toEqual(["T2"])
    expect(plan.scenarios.map((scenario) => [scenario.id, scenario.needs])).toEqual([["S1", ["T3"]]])
    // The dependency order of T5 and T6 is their after list as written.
    expect(afterOf("T5")).toEqual(["T4", "T2"])
    expect(afterOf("T6")).toEqual(["T2", "T4"])
    // Before T1 fails: T1 builds, and every dependant waits, with no cause.
    expect(before.status).toBe("active")
    expect(engine.unitState(before, "T1")).toBe("building")
    for (const id of DEPENDANTS) {
      expect(engine.unitState(before, id)).toBe("waiting")
      expect(engine.blockedBy(before, id)).toBeUndefined()
    }
    expect(engine.waitingOn(before, "T3")).toEqual(["T2"])
    expect(engine.waitingOn(before, "S1")).toEqual(["T3"])
  }),
)

it.live("[RM9] when T1 fails, T2 is blocked by T1 and T3 by T2 in the same fold step", () =>
  Effect.gen(function* () {
    const { before, after } = yield* scenario
    expect(after).not.toBe(before)
    expect(engine.unitState(after, "T1")).toBe("failed")
    expect(engine.unitState(after, "T2")).toBe("blocked")
    expect(engine.blockedBy(after, "T2")).toEqual({ id: "T1", state: "failed" })
    expect(engine.unitState(after, "T3")).toBe("blocked")
    expect(engine.blockedBy(after, "T3")).toEqual({ id: "T2", state: "blocked" })
    // Each block is one history entry of this step, with its named cause.
    const added = engine.view(after).history.slice(engine.view(before).history.length)
    expect(added.filter((entry) => entry.unit === "T2")).toMatchObject([
      { from: "waiting", to: "blocked", reason: "blocked by T1: failed" },
    ])
    expect(added.filter((entry) => entry.unit === "T3")).toMatchObject([
      { from: "waiting", to: "blocked", reason: "blocked by T2: blocked" },
    ])
    // T2 is blocked before T3 in the step: the cascade goes through T2.
    const order = added.map((entry) => entry.unit)
    expect(order.indexOf("T2")).toBeLessThan(order.indexOf("T3"))
  }),
)

it.live("[RM9] S1 is blocked by T3 in the same fold step", () =>
  Effect.gen(function* () {
    const { plan, before, after } = yield* scenario
    expect(engine.unitState(after, "S1")).toBe("blocked")
    expect(engine.blockedBy(after, "S1")).toEqual({ id: "T3", state: "blocked" })
    const added = engine.view(after).history.slice(engine.view(before).history.length)
    expect(added.filter((entry) => entry.unit === "S1")).toMatchObject([
      { from: "waiting", to: "blocked", reason: "blocked by T3: blocked" },
    ])
    const order = added.map((entry) => entry.unit)
    expect(order.indexOf("T3")).toBeLessThan(order.indexOf("S1"))
    expect(TaskStatus.project(plan, after).scenarios.S1).toMatchObject({
      state: "blocked",
      blockedBy: { id: "T3", state: "blocked" },
      reason: "blocked by T3: blocked",
    })
    // Nothing is left to move: every region is final, so the run ends in the failed task's state.
    expect(engine.ended(after)).toBe(true)
    expect(engine.view(after).run.state).toBe("failed")
  }),
)

it.live("[RM9] a task with two dead dependencies names the first one in dependency order", () =>
  Effect.gen(function* () {
    const { plan, before, after } = yield* scenario
    // T2 and T4 both die (blocked by T1) in one microstep, so T5 and T6 each meet both dead at once.
    for (const id of ["T2", "T4"]) expect(engine.blockedBy(after, id)).toEqual({ id: "T1", state: "failed" })
    // T5 is after [T4, T2]: it names T4, the first in dependency order, though T2 comes first by id.
    expect(engine.blockedBy(after, "T5")).toEqual({ id: "T4", state: "blocked" })
    // T6 is after [T2, T4]: it names T2.
    expect(engine.blockedBy(after, "T6")).toEqual({ id: "T2", state: "blocked" })
    const added = engine.view(after).history.slice(engine.view(before).history.length)
    expect(added.filter((entry) => entry.unit === "T5")).toMatchObject([{ reason: "blocked by T4: blocked" }])
    expect(added.filter((entry) => entry.unit === "T6")).toMatchObject([{ reason: "blocked by T2: blocked" }])
    const status = TaskStatus.project(plan, after)
    expect(status.tasks.T5).toMatchObject({ state: "blocked", blockedBy: { id: "T4", state: "blocked" } })
    expect(status.tasks.T6).toMatchObject({ state: "blocked", blockedBy: { id: "T2", state: "blocked" } })
  }),
)

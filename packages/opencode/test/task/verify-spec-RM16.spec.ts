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
import { facts, judge, pass, trust, unitState as machineState } from "./lib/machine"

// Scenario RM16 (spec task-harness-feedback, D4, AD-3, T1.3 and T1.7): two siblings with no order between them become
// ready in the same step.
//
//   Given a plan with leaves T1.1, T1.2 after T1.1, and T1.3 after T1.1
//   When the fact that makes T1.1 trusted is applied
//   Then T1.2 and T1.3 are both ready in the snapshot that apply returns
//
// The plan is a spec folder written to a scoped temporary directory and loaded by the real loader (`Blend.load`, then
// `TaskCommand.plan`): the parent T1 that rule R2 requires, leaf T1.1, and leaves T1.2 and T1.3, each after T1.1 and
// with no order between them; each leaf has one test obligation. The facts fold through the engine API (`initial`,
// `apply`). "Ready" is the machine state of the task's work region (read from the snapshot value by the test
// helper), the `<id>:ready` tag and the run supervisor's choice of the tasks it starts (`RunSupervisor.supervised`).

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

const leaf = (title: string, file: string, text: string, after: ReadonlyArray<string>) => ({
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

const SUM = leaf("A sum of numbers", "sum", "`sum([1, 2, 3])` is `6`.", [])
const MEAN = leaf("A mean of numbers", "mean", "`mean([1, 2, 3])` is `2`.", ["T1.1"])
const TOTAL = leaf("A total line", "total", "`total([1, 2])` is `Total: 3`.", ["T1.1"])

// The scenario's spec folder: T1.2 and T1.3 are each after T1.1, and neither is after the other.
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
    "# Two siblings after one leaf",
    "",
    "T1.2 and T1.3 both build on T1.1, and not on each other.",
    "",
  ].join("\n"),
  "T1-numbers.task/TASK.md": ["---", "---", "", "# Numbers", "", "## Goal", "", "Three small helpers.", ""].join("\n"),
  "T1-numbers.task/VERIFY.md": [
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
  "T1-numbers.task/T1.1-sum.task/TASK.md": SUM.task,
  "T1-numbers.task/T1.1-sum.task/VERIFY.md": SUM.verify,
  "T1-numbers.task/T1.2-mean.task/TASK.md": MEAN.task,
  "T1-numbers.task/T1.2-mean.task/VERIFY.md": MEAN.verify,
  "T1-numbers.task/T1.3-total.task/TASK.md": TOTAL.task,
  "T1-numbers.task/T1.3-total.task/VERIFY.md": TOTAL.verify,
}

// The plan of `/task example-siblings.spec`, from the folder written to a scoped temporary directory.
const loadSiblings = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const dir = path.join(root, "example-siblings.spec")
  for (const [file, text] of Object.entries(FILES)) {
    yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
    yield* fs.writeFileString(path.join(dir, file), text)
  }
  const loaded = yield* Blend.load(dir)
  expect(loaded.failures).toEqual([])
  if (!loaded.spec) return yield* Effect.die("the RM16 spec folder did not load")
  return TaskCommand.plan({
    spec: loaded.spec,
    specPath: "example-siblings.spec",
    path: "example-siblings.spec",
    root: Option.none(),
  })
})

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

interface Readiness {
  readonly machine: string
  readonly ready: boolean
  readonly waitingOn: ReadonlyArray<string>
  readonly status: string | undefined
}

const readiness = (plan: Plan, snapshot: RunSnapshot, id: string): Readiness => ({
  machine: machineState(snapshot, id),
  ready: snapshot.hasTag(`${id}:ready`),
  waitingOn: engine.waitingOn(snapshot, id),
  status: TaskStatus.project(plan, snapshot).tasks[id]?.state,
})

const READY: Readiness = { machine: "ready", ready: true, waitingOn: [], status: "waiting" }
const WAITING_ON_T11: Readiness = { machine: "waiting", ready: false, waitingOn: ["T1.1"], status: "waiting" }

it.live(
  "[RM16] the plan holds leaves T1.1, T1.2 after T1.1 and T1.3 after T1.1, with no order between T1.2 and T1.3",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadSiblings()
      expect(plan.tasks.map((task) => [task.id, task.afterEffective, task.children])).toEqual([
        ["T1", [], ["T1.1", "T1.2", "T1.3"]],
        ["T1.1", [], []],
        ["T1.2", ["T1.1"], []],
        ["T1.3", ["T1.1"], []],
      ])
      const started = fold(plan, [facts().runStarted()])
      // At the start only T1.1 is ready; both siblings wait on it.
      expect(readiness(plan, started, "T1.1")).toEqual(READY)
      expect(readiness(plan, started, "T1.2")).toEqual(WAITING_ON_T11)
      expect(readiness(plan, started, "T1.3")).toEqual(WAITING_ON_T11)
      expect(RunSupervisor.supervised(plan, started)).toEqual({ "T1.1": "task" })
    }),
)

it.live(
  "[RM16] the verdict that makes T1.1 trusted makes T1.2 and T1.3 both ready in the snapshot that apply returns",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadSiblings()
      const f = facts()
      // T1.1 is built and proved; its obligation waits for the verifier, so T1.1 is verifying.
      const before = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.ready("T1.1"),
        f.proved("T1.1", [judge("T1.1.c1")]),
      ])
      expect(machineState(before, "T1.1")).toBe("verifying")
      expect(readiness(plan, before, "T1.2")).toEqual(WAITING_ON_T11)
      expect(readiness(plan, before, "T1.3")).toEqual(WAITING_ON_T11)
      expect(RunSupervisor.supervised(plan, before)).toEqual({ "T1.1": "task" })

      // When: the verifier's trust of T1.1.c1, the fact that makes T1.1 trusted, is applied once.
      const after = engine.apply(plan, before, f.verified("T1.1", [trust("T1.1.c1")]))
      expect(machineState(after, "T1.1")).toBe("trusted")

      // Then: T1.2 and T1.3 are both ready in that one returned snapshot, and the run supervisor starts both from it.
      expect(readiness(plan, after, "T1.2")).toEqual(READY)
      expect(readiness(plan, after, "T1.3")).toEqual(READY)
      expect(RunSupervisor.supervised(plan, after)).toEqual({ "T1.2": "task", "T1.3": "task" })
      // The step logged the obligation's and T1.1's moves to trusted; the siblings' waiting-to-ready toggles are not
      // logged, so neither sibling is ordered before the other.
      const added = after.context.log.slice(before.context.log.length)
      expect(added.map((entry) => [entry.unit, entry.to])).toEqual([
        ["T1.1.c1", "trusted"],
        ["T1.1", "trusted"],
      ])
    }),
)

it.live(
  "[RM16] the siblings become ready in one step also when T1.1 is trusted by its proof's verification of passed results",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadSiblings()
      const f = facts()
      // The other path to trusted: every result passed, then the task's verification with no verdict to wait for.
      const before = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.ready("T1.1"),
        f.proved("T1.1", [pass("T1.1.c1")]),
      ])
      expect(machineState(before, "T1.1")).toBe("verifying")
      expect(readiness(plan, before, "T1.2")).toEqual(WAITING_ON_T11)
      const after = engine.apply(plan, before, f.verified("T1.1", []))
      expect(machineState(after, "T1.1")).toBe("trusted")
      expect([readiness(plan, after, "T1.2"), readiness(plan, after, "T1.3")]).toEqual([READY, READY])
      // Each sibling then runs on its own: T1.2 starts building while T1.3 stays ready.
      const building = engine.apply(plan, after, f.started("T1.2"))
      expect(machineState(building, "T1.2")).toBe("building")
      expect(readiness(plan, building, "T1.3")).toEqual(READY)
      expect(RunSupervisor.supervised(plan, building)).toEqual({ "T1.2": "task", "T1.3": "task" })
    }),
)

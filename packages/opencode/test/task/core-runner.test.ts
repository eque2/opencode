import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "path"
import type { BlendModel } from "@/task/blend/model"
import type { History, Plan } from "@/task/core/model"
import { TaskEvents } from "@/task/core/events"
import { TaskCommand } from "@/task/core/command"
import { RunSupervisor } from "@/task/core/supervise/run"
import { TaskWorkers } from "@/task/core/workers"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import type { TaskProof } from "@/task/proof"
import { testEffect } from "../lib/effect"
import { facts, fail, loadPlan, observed, trustLeaf } from "./lib/machine"

const fold = (plan: Plan, list: ReadonlyArray<Parameters<typeof TaskEngineXState.apply>[2]>, from?: RunSnapshot) =>
  list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), from ?? TaskEngineXState.initial(plan))

// The pure parts of the task harness that the polled runner held, in the modules that hold them now (spine AD-8):
// the workers' helpers, the run supervisor's choice of units, and the command's choice of slice. No server, no model.

const entry = (at: number, unit: string, from: string, to: string): History => ({ at, unit, from, to })

describe("the task wall clock", () => {
  const history: ReadonlyArray<History> = [
    entry(100, "T1.1", "waiting", "building"),
    entry(200, "T1.1", "building", "proving"),
    entry(300, "T1.1", "proving", "building"),
    entry(400, "T1.1", "building", "proving"),
    entry(500, "T1.1", "proving", "verifying"),
    entry(600, "T1.1", "verifying", "trusted"),
    entry(700, "T1.1", "trusted", "proving"),
    entry(150, "T1.2", "waiting", "building"),
  ]

  test("starts at the latest building entry", () => {
    expect(TaskWorkers.taskClockStart(history.slice(0, 5), "T1.1", 0)).toEqual(Option.some(300))
  })

  test("a trusted task reopened without building has no clock; built again, it starts afresh", () => {
    expect(TaskWorkers.taskClockStart(history, "T1.1", 0)).toEqual(Option.none())
    const rebuilt = [...history, entry(800, "T1.1", "proving", "building")]
    expect(TaskWorkers.taskClockStart(rebuilt, "T1.1", 0)).toEqual(Option.some(800))
  })

  test("never starts before the latest start or resume of the run", () => {
    expect(TaskWorkers.taskClockStart(history, "T1.2", 1_000)).toEqual(Option.some(1_000))
  })

  test("a task never in building has no clock", () => {
    expect(TaskWorkers.taskClockStart(history, "T1.3", 0)).toEqual(Option.none())
  })
})

// --- proof results -------------------------------------------------------------------------------------------------

const obligation = (id: string, proof: BlendModel.Proof, judges: BlendModel.Judge[]): BlendModel.Obligation => ({
  id,
  task: "T1.1",
  kind: "ensures",
  text: id,
  covers: [],
  proof,
  judges,
  hash: `hash-${id}`,
})

const spec = {
  obligations: [
    obligation("T1.1.c1", { kind: "test", tag: "T1.1.c1" }, ["runner", "verifier"]),
    obligation("T1.1.c2", { kind: "test", tag: "T1.1.c2" }, ["runner", "verifier"]),
    obligation("T1.1.c3", { kind: "test", tag: "T1.1.c3" }, ["runner", "verifier"]),
    obligation("T1.1.p1", { kind: "gate", gate: "BUILD-1" }, ["runner"]),
    obligation("T1.1.p2", { kind: "unchanged", path: "package.json" }, ["engine"]),
    obligation("T1.1.e1", { kind: "review" }, ["reviewer"]),
  ],
} as const satisfies Pick<BlendModel.Spec, "obligations">

const evidence: TaskProof.Evidence = { exitCode: 0, counts: { pass: 1, fail: 0, skip: 0 }, runId: "proof-1", commit: "c0" }

const proof = (input: {
  readonly obligations: ReadonlyArray<TaskProof.ObligationResult>
  readonly violations?: ReadonlyArray<TaskProof.Violation>
  readonly gates?: ReadonlyArray<TaskProof.GateResult>
}): TaskProof.TaskProof => ({
  task: "T1.1",
  obligations: input.obligations,
  structural: {
    rule: "touches-plus-tests",
    status: (input.violations ?? []).length > 0 ? "failed" : "passed",
    violations: input.violations ?? [],
  },
  gates: input.gates ?? [],
  evidence,
})

const passing: ReadonlyArray<TaskProof.ObligationResult> = [
  { id: "T1.1.c1", proof: "test", status: "passed" },
  { id: "T1.1.c2", proof: "test", status: "passed" },
  { id: "T1.1.c3", proof: "test", status: "passed" },
  { id: "T1.1.p1", proof: "gate", status: "passed" },
  { id: "T1.1.p2", proof: "unchanged", status: "passed" },
  { id: "T1.1.e1", proof: "review", status: "needs-review" },
]

const mapped =(input: Parameters<typeof proof>[0], gates: ReadonlyArray<string> = []) =>
  TaskWorkers.results(spec, proof(input), gates)

describe("the proof results", () => {
  test("a verifier-judged pass needs a judge; a machine-judged pass is passed; a review needs a judge", () => {
    const out = mapped({ obligations: passing })
    expect(out.results).toEqual([
      { id: "T1.1.c1", status: "needs-judge" },
      { id: "T1.1.c2", status: "needs-judge" },
      { id: "T1.1.c3", status: "needs-judge" },
      { id: "T1.1.p1", status: "passed" },
      { id: "T1.1.p2", status: "passed" },
      { id: "T1.1.e1", status: "needs-judge" },
    ])
    expect(out.reason).toEqual(Option.none())
  })

  test("a failed gate of the task fails every test obligation that did not fail on its own", () => {
    const obligations = passing.map((item): TaskProof.ObligationResult =>
      item.id === "T1.1.c3" ? { id: item.id, proof: "test", status: "failed", reason: "expected fix" } : item,
    )
    const gates: ReadonlyArray<TaskProof.GateResult> = [
      { gate: "BUILD-1", exitCode: 0, timedOut: false, status: "passed" },
      { gate: "BUILD-2", exitCode: 1, timedOut: false, status: "failed", reason: "exit 1: lint" },
    ]
    const out = mapped({ obligations, gates }, ["BUILD-1", "BUILD-2"])
    const blocked = "gate BUILD-2 failed: exit 1: lint"
    expect(out.results).toEqual([
      { id: "T1.1.c1", status: "failed", reason: blocked },
      { id: "T1.1.c2", status: "failed", reason: blocked },
      { id: "T1.1.c3", status: "failed", reason: "expected fix" },
      { id: "T1.1.p1", status: "passed" },
      { id: "T1.1.p2", status: "passed" },
      { id: "T1.1.e1", status: "needs-judge" },
    ])
    expect(out.reason).toEqual(Option.some(blocked))
  })

  test("a failed gate that is not one of the task's gates blocks nothing", () => {
    const gates: ReadonlyArray<TaskProof.GateResult> = [
      { gate: "BUILD-3", exitCode: 1, timedOut: false, status: "failed", reason: "exit 1" },
    ]
    const out = mapped({ obligations: passing, gates }, ["BUILD-1"])
    expect(out.results.filter((item) => item.status === "failed")).toEqual([])
  })

  test("a structural violation names the path in the results and the reason", () => {
    const reason = "structural: test/verify-release-notes-S3.spec.ts"
    const obligations = passing.map((item): TaskProof.ObligationResult =>
      item.proof === "test" ? { id: item.id, proof: "test", status: "failed", reason } : item,
    )
    const out = mapped({
      obligations,
      violations: [{ path: "test/verify-release-notes-S3.spec.ts", reason: "a test file whose head content holds [T1.2.c1]" }],
    })
    expect(out.results.filter((item) => item.status === "failed")).toHaveLength(3)
    expect(out.results.every((item) => item.status !== "failed" || item.reason === reason)).toBe(true)
    expect(out.reason).toEqual(Option.some(reason))
  })

  test("a skipped test obligation stays failed with its reason", () => {
    const reason = "skipped: every test titled [T1.1.c1] was skipped"
    const obligations = passing.map((item): TaskProof.ObligationResult =>
      item.id === "T1.1.c1" ? { id: item.id, proof: "test", status: "failed", reason } : item,
    )
    expect(mapped({ obligations }).results[0]).toEqual({ id: "T1.1.c1", status: "failed", reason })
  })
})

describe("the scenario results", () => {
  const scenario = (result: TaskProof.TagResult): TaskProof.ScenarioProof => ({ scenario: "S2", result, evidence })

  test("passed is passed; failed keeps its reason; skipped is failed", () => {
    expect(TaskWorkers.scenarioOutcome(scenario({ status: "passed" }))).toEqual({ status: "passed" })
    expect(TaskWorkers.scenarioOutcome(scenario({ status: "failed", reason: "no test titled [S2]" }))).toEqual({
      status: "failed",
      reason: "no test titled [S2]",
    })
    expect(TaskWorkers.scenarioOutcome(scenario({ status: "skipped" }))).toEqual({
      status: "failed",
      reason: "skipped: every test titled [S2] was skipped",
    })
  })
})

describe("the verdicts of a round", () => {
  test("keep only the last verdict per id", () => {
    expect(
      TaskWorkers.latestVerdicts([
        { id: "T1.1.c1", verdict: "rejected", reason: "first look" },
        { id: "T1.1.c2", verdict: "trusted" },
        { id: "T1.1.c1", verdict: "trusted" },
      ]),
    ).toEqual([
      { id: "T1.1.c2", verdict: "trusted" },
      { id: "T1.1.c1", verdict: "trusted" },
    ])
  })
})

// The supervisors work by the run machine's tags (AD-8): the run supervisor supervises a task tagged ready or active
// and a scenario in verifying, proves the ready scenarios as one batch, and supervises nothing once the run is done;
// the command resumes only a slice that has not ended.
describe("the units the run supervisor supervises", () => {
  const it = testEffect(NodeServices.layer)
  const keys = (plan: Plan, snapshot: RunSnapshot) => {
    const units = RunSupervisor.supervised(plan, snapshot)
    const phase = (unit: string) => RunSupervisor.tagsOf(snapshot, unit).find((tag) => tag !== "waiting" && tag !== "active") ?? "-"
    const batch = RunSupervisor.readyScenarios(plan, snapshot)
    return [
      ...Object.entries(units).map(([unit, kind]) => `${kind}:${unit}:${phase(unit)}`),
      ...(batch.length > 0 ? [`batch:${batch.join(",")}`] : []),
    ]
  }

  it.live("supervises each ready leaf, and only the ready ones", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      expect(keys(plan, fold(plan, [f.runStarted()]))).toEqual(["task:T1.1:ready", "task:T1.2:ready"])
      const building = fold(plan, [f.runStarted(), f.started("T1.1")])
      expect(keys(plan, building)).toEqual(["task:T1.1:building", "task:T1.2:ready"])
    }),
  )

  it.live("follows the phase tags: proving, verifying, the parent's review, the scenario batch and its judges", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      expect(keys(plan, fold(plan, [f.runStarted(), f.started("T1.1"), f.ready("T1.1")]))).toEqual(["task:T1.1:proving"])
      const trusted = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
      expect(keys(plan, trusted)).toEqual(["task:T1:ready", "batch:S1"])
      const judged = fold(plan, [f.scenarioProved("S1", "passed")], trusted)
      expect(keys(plan, judged)).toEqual(["task:T1:ready", "scenario:S1:verifying"])
      const verifying = fold(plan, [f.proved("T1", [])], judged)
      expect(keys(plan, verifying)).toEqual(["task:T1:verifying", "scenario:S1:verifying"])
    }),
  )

  it.live("RM10 keeps supervising the independent task after another task dies, until the snapshot is done", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const dead = fold(plan, [
        f.runStarted(),
        f.started("T1.1"),
        f.started("T1.3"),
        f.ready("T1.1"),
        f.proved("T1.1", [fail("T1.1.c1", "BUILD-1 exited 1")]),
      ])
      expect(keys(plan, dead)).toEqual(["task:T1.3:building"])
      expect(TaskEngineXState.ended(dead)).toBe(false)
      const done = fold(plan, trustLeaf(plan, f, "T1.3").slice(1), dead)
      expect(TaskEngineXState.ended(done)).toBe(true)
      expect(keys(plan, done)).toEqual([])
    }),
  )

  it.live("RM8 resumes a slice that has not ended, and never one that stopped or folds to done", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const open = [f.runStarted(), ...trustLeaf(plan, f, "T1.1")]
      // An old slice with no path counts as a whole-spec slice (RM8b).
      expect(yield* TaskCommand.sliceOf(plan, open, plan.specPath)).toEqual({ kind: "resume", facts: open })
      // A stored stop ends the slice (RM8a).
      expect((yield* TaskCommand.sliceOf(plan, [...open, f.ended("done")], plan.specPath)).kind).toBe("new")
      // The observed slice with its scenario proofs and its outside trusts folds to done: never resumed (RM8c).
      const ready = ["S2", "S3", "S4", "S7", "S12"]
      const done = [
        ...observed(plan, f),
        ...ready.flatMap((id) => [f.scenarioProved(id, "passed"), f.scenarioVerified({ id, verdict: "trusted" })]),
      ]
      expect(TaskEngineXState.ended(TaskEvents.fold(TaskEngineXState.XStateEngine, plan, done))).toBe(true)
      expect((yield* TaskCommand.sliceOf(plan, done, plan.specPath)).kind).toBe("new")
      // Only the latest slice counts.
      expect((yield* TaskCommand.sliceOf(plan, [...done, ...open], plan.specPath)).kind).toBe("resume")
    }),
  )

  it.live("RM17 trusts an outside region once: an untrusted outside region takes a trust, a trusted one none", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const started = fold(plan, [f.runStarted()])
      expect(RunSupervisor.untrustedOutside(plan, started, "T9")).toBe(true)
      expect(RunSupervisor.untrustedOutside(plan, started, "T8")).toBe(true)
      // A task is no outside region.
      expect(RunSupervisor.untrustedOutside(plan, started, "T1.1")).toBe(false)
      const trusted = fold(plan, [f.outside("T9"), f.outside("T8")], started)
      expect(TaskEngineXState.unitState(trusted, "T9")).toBe("trusted")
      expect(RunSupervisor.untrustedOutside(plan, trusted, "T9")).toBe(false)
      expect(RunSupervisor.untrustedOutside(plan, trusted, "T8")).toBe(false)
    }),
  )
})

describe("the polled runner is gone (SV1)", () => {
  // The runner's own names: no module of the harness core (the runner's home, now the harness root, the Recorder, the
  // workers and the supervisors) declares one of them any more.
  const RUNNER = ["loop", "tick", "TICK", "STALE_EVERY", "checkDone", "failures", "MAX_FAILURES", "stopping", "children", "active", "trustActive"]
  const sources = (dir: string): ReadonlyArray<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory()
        ? sources(path.join(dir, item.name))
        : item.name.endsWith(".ts")
          ? [path.join(dir, item.name)]
          : [],
    )
  const root = path.resolve(import.meta.dir, "../../src/task/core")

  test("no module defines the runner's loop, its counters, its registry or its FiberMap of workers", () => {
    expect(existsSync(path.join(root, "runner.ts"))).toBe(false)
    const found = sources(root).flatMap((file) => {
      const text = readFileSync(file, "utf8")
      const declared = RUNNER.filter((name) =>
        new RegExp(`\\b(const|let|var|function|class)\\s+${name}\\b|\\bexport const ${name}\\b`).test(text),
      )
      const fiberMap = /\bFiberMap\b/.test(text) ? ["FiberMap"] : []
      return [...declared, ...fiberMap].map((name) => `${path.relative(root, file)}: ${name}`)
    })
    expect(found).toEqual([])
  })
})

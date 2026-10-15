import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { readFileSync } from "node:fs"
import path from "path"
import type { BlendModel } from "@/task/blend/model"
import type { History, Plan } from "@/task/core/model"
import { TaskEvents } from "@/task/core/events"
import { TaskRunner } from "@/task/core/runner"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import type { TaskProof } from "@/task/proof"
import { testEffect } from "../lib/effect"
import { facts, fail, loadPlan, observed, trustLeaf } from "./lib/machine"

const fold = (plan: Plan, list: ReadonlyArray<Parameters<typeof TaskEngineXState.apply>[2]>, from?: RunSnapshot) =>
  list.reduce((snapshot, fact) => TaskEngineXState.apply(plan, snapshot, fact), from ?? TaskEngineXState.initial(plan))

// The pure parts of the task harness runner: no server, no model.

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
    expect(TaskRunner.taskClockStart(history.slice(0, 5), "T1.1", 0)).toEqual(Option.some(300))
  })

  test("a trusted task reopened without building has no clock; built again, it starts afresh", () => {
    expect(TaskRunner.taskClockStart(history, "T1.1", 0)).toEqual(Option.none())
    const rebuilt = [...history, entry(800, "T1.1", "proving", "building")]
    expect(TaskRunner.taskClockStart(rebuilt, "T1.1", 0)).toEqual(Option.some(800))
  })

  test("never starts before the latest start or resume of the run", () => {
    expect(TaskRunner.taskClockStart(history, "T1.2", 1_000)).toEqual(Option.some(1_000))
  })

  test("a task never in building has no clock", () => {
    expect(TaskRunner.taskClockStart(history, "T1.3", 0)).toEqual(Option.none())
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
  TaskRunner.results(spec, proof(input), gates)

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
    expect(TaskRunner.scenarioOutcome(scenario({ status: "passed" }))).toEqual({ status: "passed" })
    expect(TaskRunner.scenarioOutcome(scenario({ status: "failed", reason: "no test titled [S2]" }))).toEqual({
      status: "failed",
      reason: "no test titled [S2]",
    })
    expect(TaskRunner.scenarioOutcome(scenario({ status: "skipped" }))).toEqual({
      status: "failed",
      reason: "skipped: every test titled [S2] was skipped",
    })
  })
})

describe("the verdicts of a round", () => {
  test("keep only the last verdict per id", () => {
    expect(
      TaskRunner.latestVerdicts([
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

// The phase-1 seam (AD-20): the runner starts work by the run machine's phase tags, ends on its `done`, and
// resumes only a slice that has not ended.
describe("the phase-1 seam on the run snapshot", () => {
  const it = testEffect(NodeServices.layer)
  const keys = (plan: Plan, snapshot: RunSnapshot) =>
    TaskRunner.due(plan, snapshot).map((work) => `${work.kind}:${work.key}${work.ids ? `=${work.ids.join(",")}` : ""}`)

  it.live("starts each ready leaf, and only the ready ones", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      expect(keys(plan, fold(plan, [f.runStarted()]))).toEqual(["begin:T1.1", "begin:T1.2"])
      const building = fold(plan, [f.runStarted(), f.started("T1.1")])
      expect(keys(plan, building)).toEqual(["build:T1.1", "begin:T1.2"])
    }),
  )

  it.live("follows the phase tags: proving, verifying, the parent's review, the scenario batch and its judges", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      expect(keys(plan, fold(plan, [f.runStarted(), f.started("T1.1"), f.ready("T1.1")]))).toEqual(["prove:T1.1"])
      const trusted = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
      expect(keys(plan, trusted)).toEqual(["review:T1", "scenarios:scenarios=S1"])
      const judged = fold(plan, [f.scenarioProved("S1", "passed")], trusted)
      expect(keys(plan, judged)).toEqual(["review:T1", "judge:S1"])
      const verifying = fold(plan, [f.proved("T1", [])], judged)
      expect(keys(plan, verifying)).toEqual(["verify:T1", "judge:S1"])
    }),
  )

  it.live("RM10 keeps the independent task's worker after another task dies, until the snapshot is done", () =>
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
      expect(keys(plan, dead)).toEqual(["build:T1.3"])
      expect(TaskEngineXState.ended(dead)).toBe(false)
      const done = fold(plan, trustLeaf(plan, f, "T1.3").slice(1), dead)
      expect(TaskEngineXState.ended(done)).toBe(true)
      expect(keys(plan, done)).toEqual([])
    }),
  )

  it.live("RM8 resumes a slice that has not ended, and never one that stopped or folds to done", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const engine = TaskEngineXState.XStateEngine
      const f = facts()
      const open = [f.runStarted(), ...trustLeaf(plan, f, "T1.1")]
      // An old slice with no path counts as a whole-spec slice (RM8b).
      expect(Option.map(TaskRunner.resumable(engine, plan, open), (slice) => slice.length)).toEqual(Option.some(5))
      // A stored stop ends the slice (RM8a).
      expect(TaskRunner.resumable(engine, plan, [...open, f.ended("done")])).toEqual(Option.none())
      // The observed slice with its scenario proofs folds to done: never resumed (RM8c).
      const ready = ["S2", "S3", "S4", "S7", "S12"]
      const done = [
        ...observed(plan, f),
        ...ready.flatMap((id) => [f.scenarioProved(id, "passed"), f.scenarioVerified({ id, verdict: "trusted" })]),
      ]
      expect(TaskRunner.resumable(engine, plan, done)).toEqual(Option.none())
      // Only the latest slice counts.
      expect(Option.isSome(TaskRunner.resumable(engine, plan, [...done, ...open]))).toBe(true)
    }),
  )

  it.live("RM17 records each directory trust once at the start, and none the machine already holds", () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const started = fold(plan, [f.runStarted()])
      // The directory recorded T9 twice and T8 once before this run.
      const directory = [f.outside("T9"), f.outside("T8"), f.outside("T9")]
      const recorded = TaskRunner.trustFacts(started, TaskEvents.trustedOutside(directory), 50)
      expect(recorded).toEqual([
        { type: "outside.trusted", at: 50, id: "T9" },
        { type: "outside.trusted", at: 50, id: "T8" },
      ])
      // Applied, they trust both regions; the same trusts again (a forwarded /task trust) record nothing.
      const trusted = fold(plan, recorded, started)
      expect(TaskEngineXState.unitState(trusted, "T9")).toBe("trusted")
      expect(TaskEngineXState.unitState(trusted, "T8")).toBe("trusted")
      expect(TaskRunner.trustFacts(trusted, ["T9", "T8"], 60)).toEqual([])
      expect(TaskRunner.trustFacts(trusted, ["T9"], 60)).toEqual([])
    }),
  )

  test("holds no readiness check, no done rule, no trust set and no lists of states", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "../../src/task/core/runner.ts"), "utf8")
    expect(source).not.toMatch(/\bcheckDone\b/)
    expect(source).not.toMatch(/\bfollows\b/)
    expect(source).not.toMatch(/\bconst (ACTIVE|JUDGED)\b/)
    expect(source).not.toMatch(/afterEffective\.every/)
    expect(source).not.toMatch(/readonly outside: Ref/)
    expect(source).not.toMatch(/type: "run\.ended", at: [^,]+, state: "done"/)
  })
})

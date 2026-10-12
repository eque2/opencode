import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { BlendModel } from "@/task/blend/model"
import type { History } from "@/task/core/model"
import { TaskRunner } from "@/task/core/runner"
import type { TaskProof } from "@/task/proof"

// The pure parts of the in-core harness runner: no server, no model.

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

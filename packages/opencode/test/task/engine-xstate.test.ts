import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import type { BlendModel } from "@/task/blend/model"
import type { Fact, Plan, Result, Verdict } from "@/task/core/model"
import { TaskEvents } from "@/task/core/events"
import { TaskRunner } from "@/task/core/runner"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { exhaustLeaf, facts, loadPlan, observed, trustLeaf } from "./lib/machine"

// The engine's contract as fact sequences through `initial`, `apply`, the selectors and `view` (spine AD-6). A
// small spec: parent T1 with leaves T1.1 and T1.2. T1.1 has three test obligations and one gate obligation; T1.2
// has one test obligation; T1 has one review obligation. Budget 3 for every task. The release-notes plan, loaded
// with `Blend.load`, covers the observed run.
//
// The tests of the old engine file (owner ruling 2, "Rewrite, keep intent"), each in one class:
//
//  1 "is named xstate" — ported.
//  2 "the initial state: tasks waiting, obligations pending, scenarios waiting" — ported.
//  3 "the happy leaf path: waiting, building, proving, verifying, trusted with attempts 1" — ported.
//  4 "a failed proof returns the task to the builder with the failed ids and reasons" — ported.
//  5 "the proof's own reason (a structural failure) is part of the task reason" — ported.
//  6 "budget exhaustion at the budget ends the task and the run" — re-baselined (D3): the run keeps running until
//    the independent T1.2 and its scenario end, then ends budget_exhausted; T1 is blocked (D2).
//  7 "a rejection reopens only the rejected id; the others stay trusted" — ported.
//  8 "a verifier round that leaves an obligation unjudged also returns the task" — ported.
//  9 "a rejection at the budget exhausts it" — re-baselined (D3): the run does not end at once.
// 10 "a stall keeps the task building with its attempts and records the reason" — ported.
// 11 "a repetition returns the task to the builder with attempts + 1, and exhausts the budget" — re-baselined
//    (D3): the exhausted task does not end the run at once.
// 12 "needs_human ends an active task and the run" — re-baselined (D3): the run waits for the independent work.
// 13 "task.failed fails the task and the run" — re-baselined (D3): the run waits for the independent work.
// 14 "cancel moves every building, proving or verifying task to cancelled, and the run" — re-baselined
//    (default 4): the waiting parent is cancelled too, so every region is final when the run ends.
// 15 "a stale obligation reopens its trusted task; a later round trusts it again" — ported.
// 16 "a failed result reopens a trusted obligation with its reason; a needs-judge result leaves it trusted" — ported.
// 17 "a parent is reviewed once: trusted with attempts 1, or failed and never rebuilt" — re-baselined (D4: the
//    review comes once the children are trusted; D3: a failed parent does not end the run at once).
// 18 "scenarios: proved passed then verified; a failed proof or a rejection ends the scenario" — re-baselined
//    (D4: a scenario is proved once its needs are trusted).
// 19 "run facts: started, resumed, outside trust and the end" — re-baselined (D3, AD-4: run.ended is a stop
//    that cancels the unfinished units, and the outcome takes its state).
// 20 "a fact that matches no row changes nothing and adds no history" — ported.
// 21 "facts after the run ended change nothing" — re-baselined (D3: needs_human no longer ends the run; a cancel
//    ends it).
// 22 "apply is pure: it never changes the state it receives" — ported.
// 23 "a parent's stale review obligation reopens it once; the new review trusts it (attempts 1) or fails it" —
//    re-baselined (D4: the first review comes once the children are trusted; D3: the failure ends no run).
// 24 "task.failed fails a waiting leaf, a waiting parent and a verifying leaf, and the run with it" — re-baselined
//    (D3): the run does not follow the failed task.
// 25 "obligation.stale on an obligation that is neither passed nor trusted changes nothing, its trusted task
//    included" — retired: its input was a hand-built State. Replaced by "a fact that moves nothing returns the
//    identical snapshot", shown here on a rejected obligation that a real fold reaches.
// 26 "obligation.stale moves an obligation whose task the state does not hold" — retired: a snapshot holds every
//    unit of its plan. Replaced by "an unknown id returns the identical snapshot".
// 27 "a unit in a state its lifecycle does not name takes no fact, and no such state makes apply throw" — retired:
//    no snapshot holds a state its machine does not name. Replaced by "a foreign snapshot dies".
// B1 "the base of an unfinished run: is the branch its run.started recorded, until the run ends" — ported.
// B2 "the base of an unfinished run: is unknown for a run stored before the base was recorded" — ported.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState
const BUDGET = 3

// The policy of `release-notes.spec`.
const policy: BlendModel.Policy = {
  redFirst: true,
  proofBinding: "title-tag",
  structural: "touches-plus-tests",
  review: "parent-diff",
  trust: "independent-verifier",
  acceptance: "after-all-needs-trusted",
  evidence: ["exit-code", "counts", "run-id", "commit"],
  budgets: { taskAttempts: BUDGET, retries: 2 },
  judges: { test: ["runner", "verifier"], gate: ["runner"], unchanged: ["engine"], review: ["reviewer"] },
}

const task = (id: string, children: string[] = []): BlendModel.Task => ({
  id,
  slug: id.toLowerCase(),
  title: id,
  parent: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : undefined,
  children,
  after: [],
  goal: `goal of ${id}`,
  touches: [],
  refs: [],
  notHere: [],
  gates: [],
  policy,
  afterEffective: [],
  supports: [],
  hash: `hash-${id}`,
})

const obligation = (id: string, proof: BlendModel.Proof): BlendModel.Obligation => ({
  id,
  task: id.slice(0, id.lastIndexOf(".")),
  kind: "ensures",
  text: id,
  covers: [],
  proof,
  judges: [],
  hash: `hash-${id}`,
})

const scenario = (id: string, needs: string[]): BlendModel.Scenario => ({
  id,
  title: id,
  tags: [],
  steps: [],
  category: "happy-path",
  needs,
  hash: `hash-${id}`,
})

const tasks = [task("T1", ["T1.1", "T1.2"]), task("T1.1"), task("T1.2")]
const obligations = [
  obligation("T1.1.c1", { kind: "test", tag: "T1.1.c1" }),
  obligation("T1.1.c2", { kind: "test", tag: "T1.1.c2" }),
  obligation("T1.1.c3", { kind: "test", tag: "T1.1.c3" }),
  obligation("T1.1.p1", { kind: "gate", gate: "BUILD-1" }),
  obligation("T1.2.c1", { kind: "test", tag: "T1.2.c1" }),
  obligation("T1.e1", { kind: "review" }),
  obligation("T2.1.c1", { kind: "test", tag: "T2.1.c1" }),
]
const scenarios = [scenario("S1", ["T1.1"]), scenario("S2", ["T1.2"])]

const spec: BlendModel.Spec = {
  id: "demo",
  title: "demo",
  policy,
  gates: { "BUILD-1": { title: "build", command: "exit 0" } },
  refs: {},
  outside: { T9: "an outside task" },
  tasks: [...tasks, task("T2", ["T2.1"]), task("T2.1")],
  obligations,
  scenarios,
}

const plan: Plan = {
  spec,
  specPath: "demo.spec",
  path: "demo.spec/T1-demo.task",
  tasks,
  scenarios,
  external: [],
  budget: () => BUDGET,
}

let clock = 0
const at = () => ++clock

const started = (id: string): Fact => ({
  type: "task.started",
  at: at(),
  task: id,
  worktree: `/wt/${id}`,
  branch: `task/${id}`,
  base: "base0",
  session: `ses_${id}`,
})
const ready = (id: string, head = "head1"): Fact => ({ type: "task.ready", at: at(), task: id, head })
const proved = (id: string, results: ReadonlyArray<Result>, reason?: string): Fact => ({
  type: "task.proved",
  at: at(),
  task: id,
  results,
  ...(reason === undefined ? {} : { reason }),
})
const verified = (id: string, verdicts: ReadonlyArray<Verdict>): Fact => ({
  type: "task.verified",
  at: at(),
  task: id,
  verdicts,
})
const failed = (id: string, reason: string): Fact => ({ type: "task.failed", at: at(), task: id, reason })
const stale = (id: string, hash = "hash-new"): Fact => ({ type: "obligation.stale", at: at(), id, hash })
const scenarioProved = (id: string, status: "passed" | "failed", reason?: string): Fact => ({
  type: "scenario.proved",
  at: at(),
  id,
  status,
  ...(reason === undefined ? {} : { reason }),
})
const scenarioVerified = (verdict: Verdict): Fact => ({ type: "scenario.verified", at: at(), verdict })

const judge = (id: string): Result => ({ id, status: "needs-judge" })
const pass = (id: string): Result => ({ id, status: "passed" })
const fail = (id: string, reason: string): Result => ({ id, status: "failed", reason })
const trust = (id: string): Verdict => ({ id, verdict: "trusted" })
const reject = (id: string, reason: string): Verdict => ({ id, verdict: "rejected", reason })

// The T1.1 proof that passes: three tests to judge and a machine-judged gate.
const happyProof = () => proved("T1.1", [judge("T1.1.c1"), judge("T1.1.c2"), judge("T1.1.c3"), pass("T1.1.p1")])
const failingProof = () =>
  proved("T1.1", [fail("T1.1.c1", "expected feat"), judge("T1.1.c2"), judge("T1.1.c3"), pass("T1.1.p1")])
const trustAll = () => verified("T1.1", [trust("T1.1.c1"), trust("T1.1.c2"), trust("T1.1.c3")])
const trustT12 = (): ReadonlyArray<Fact> => [
  started("T1.2"),
  ready("T1.2"),
  proved("T1.2", [judge("T1.2.c1")]),
  verified("T1.2", [trust("T1.2.c1")]),
]
const trustT11 = (): ReadonlyArray<Fact> => [started("T1.1"), ready("T1.1"), happyProof(), trustAll()]

const fold = (list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

// A fold of another plan, through the same engine.
const foldOf = (other: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(other)) =>
  list.reduce((snapshot, fact) => engine.apply(other, snapshot, fact), from)

const obligationStates = (snapshot: RunSnapshot, task: string) =>
  Object.fromEntries(
    Object.values(engine.view(snapshot).obligations)
      .filter((item) => item.task === task)
      .map((item) => [item.id, item.state]),
  )

const entriesOf = (snapshot: RunSnapshot, unit: string) => snapshot.context.log.filter((item) => item.unit === unit)

describe("XStateEngine", () => {
  test("1 ported: is named xstate", () => {
    expect(engine.XStateEngine.name).toBe("xstate")
  })

  test("2 ported: the initial state: tasks waiting, obligations pending, scenarios waiting", () => {
    const state = engine.view(engine.initial(plan))
    expect(state.run).toEqual({ state: "running", spec: "demo.spec", path: "demo.spec/T1-demo.task" })
    expect(state.tasks["T1"]).toEqual({ id: "T1", leaf: false, state: "waiting", attempts: 0 })
    expect(state.tasks["T1.1"]).toEqual({ id: "T1.1", leaf: true, state: "waiting", attempts: 0 })
    expect(Object.keys(state.tasks)).toEqual(["T1", "T1.1", "T1.2"])
    // Only the obligations of the plan's tasks, each with its unit hash.
    expect(Object.keys(state.obligations)).toEqual(["T1.1.c1", "T1.1.c2", "T1.1.c3", "T1.1.p1", "T1.2.c1", "T1.e1"])
    expect(state.obligations["T1.1.c2"]).toEqual({
      id: "T1.1.c2",
      task: "T1.1",
      state: "pending",
      hash: "hash-T1.1.c2",
    })
    expect(state.scenarios).toEqual({ S1: { id: "S1", state: "waiting" }, S2: { id: "S2", state: "waiting" } })
    expect(state.history).toEqual([])
  })

  test("3 ported: the happy leaf path: waiting, building, proving, verifying, trusted with attempts 1", () => {
    const building = fold([started("T1.1")])
    expect(engine.view(building).tasks["T1.1"]).toMatchObject({
      state: "building",
      attempts: 1,
      worktree: "/wt/T1.1",
      branch: "task/T1.1",
      base: "base0",
      session: "ses_T1.1",
    })
    const proving = fold([ready("T1.1", "abc")], building)
    expect(engine.view(proving).tasks["T1.1"]).toMatchObject({ state: "proving", head: "abc", attempts: 1 })

    const verifying = fold([happyProof()], proving)
    expect(engine.unitState(verifying, "T1.1")).toBe("verifying")
    // needs-judge: passed; machine-judged gate: trusted at once.
    expect(obligationStates(verifying, "T1.1")).toEqual({
      "T1.1.c1": "passed",
      "T1.1.c2": "passed",
      "T1.1.c3": "passed",
      "T1.1.p1": "trusted",
    })

    const trusted = fold([trustAll()], verifying)
    expect(engine.view(trusted).tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(Object.values(obligationStates(trusted, "T1.1"))).toEqual(["trusted", "trusted", "trusted", "trusted"])
    expect(engine.view(trusted).run.state).toBe("running")
    expect(entriesOf(trusted, "T1.1").map((item) => [item.from, item.to])).toEqual([
      ["waiting", "building"],
      ["building", "proving"],
      ["proving", "verifying"],
      ["verifying", "trusted"],
    ])
    // Every entry takes the fact's time, in order.
    const times = trusted.context.log.map((item) => item.at)
    expect(times).toEqual(times.toSorted((a, b) => a - b))
  })

  test("4 ported: a failed proof returns the task to the builder with the failed ids and reasons", () => {
    const snapshot = fold([started("T1.1"), ready("T1.1"), failingProof()])
    const state = engine.view(snapshot)
    expect(state.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 2 })
    expect(state.tasks["T1.1"]?.reason).toContain("T1.1.c1: expected feat")
    expect(state.obligations["T1.1.c1"]).toMatchObject({ state: "failed", reason: "expected feat" })
    expect(state.obligations["T1.1.c2"]?.state).toBe("passed")
    // No verifier round happened, so nothing that needs a judge is trusted.
    expect(state.history.some((item) => item.unit === "T1.1.c2" && item.to === "trusted")).toBe(false)

    const retried = engine.view(fold([ready("T1.1"), happyProof(), trustAll()], snapshot))
    expect(retried.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 2 })
    expect(retried.tasks["T1.1"]?.reason).toBeUndefined()
  })

  test("5 ported: the proof's own reason (a structural failure) is part of the task reason", () => {
    const state = engine.view(
      fold([
        started("T1.1"),
        ready("T1.1"),
        proved("T1.1", [fail("T1.1.c1", "tampered")], "test/verify-release-notes-S3.spec.ts holds another task's tag"),
      ]),
    )
    expect(state.tasks["T1.1"]?.reason).toContain("test/verify-release-notes-S3.spec.ts")
  })

  test("6 re-baselined (D3): budget exhaustion ends the task and blocks its parent; the run ends after the independent work", () => {
    const list: Fact[] = [started("T1.1")]
    for (let attempt = 1; attempt <= BUDGET; attempt++) list.push(ready("T1.1"), failingProof())
    const exhausted = fold(list)
    expect(engine.view(exhausted).tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: BUDGET })
    expect(engine.unitState(exhausted, "T1")).toBe("blocked")
    expect(engine.blockedBy(exhausted, "T1")).toEqual({ id: "T1.1", state: "budget_exhausted" })
    expect(engine.unitState(exhausted, "S1")).toBe("blocked")
    // T1.2 is independent and still ready, so the run goes on (D3).
    expect(exhausted.hasTag("T1.2:ready")).toBe(true)
    expect(engine.view(exhausted).run.state).toBe("running")
    // Three builds: attempts 1, 2, 3; never a 4th.
    expect(entriesOf(exhausted, "T1.1").filter((item) => item.to === "building")).toHaveLength(BUDGET)
    const ended = fold([...trustT12(), scenarioProved("S2", "passed"), scenarioVerified(trust("S2"))], exhausted)
    expect(engine.view(ended).run).toMatchObject({
      state: "budget_exhausted",
      reason: "T1.1 budget exhausted\nT1 blocked by T1.1",
    })
  })

  test("7 ported: a rejection reopens only the rejected id; the others stay trusted", () => {
    const rejected = fold([
      started("T1.1"),
      ready("T1.1"),
      happyProof(),
      verified("T1.1", [trust("T1.1.c1"), trust("T1.1.c2"), reject("T1.1.c3", "the refs test does not cover Refs #")]),
    ])
    const state = engine.view(rejected)
    expect(state.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 2 })
    expect(state.tasks["T1.1"]?.reason).toBe("T1.1.c3: the refs test does not cover Refs #")
    expect(state.obligations["T1.1.c3"]).toMatchObject({
      state: "rejected",
      reason: "the refs test does not cover Refs #",
    })
    expect(obligationStates(rejected, "T1.1")).toMatchObject({ "T1.1.c1": "trusted", "T1.1.c2": "trusted" })

    // The second round proves everything again; only c3 waits for a judge.
    const reproved = fold([ready("T1.1"), happyProof()], rejected)
    expect(obligationStates(reproved, "T1.1")).toEqual({
      "T1.1.c1": "trusted",
      "T1.1.c2": "trusted",
      "T1.1.c3": "passed",
      "T1.1.p1": "trusted",
    })
    const trusted = fold([verified("T1.1", [trust("T1.1.c3")])], reproved)
    expect(engine.view(trusted).tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 2 })
    for (const id of ["T1.1.c1", "T1.1.c2"])
      expect(entriesOf(trusted, id).map((item) => item.to)).toEqual(["passed", "trusted"])
  })

  test("8 ported: a verifier round that leaves an obligation unjudged also returns the task", () => {
    const state = engine.view(
      fold([started("T1.1"), ready("T1.1"), happyProof(), verified("T1.1", [trust("T1.1.c1")])]),
    )
    expect(state.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 2 })
    expect(state.tasks["T1.1"]?.reason).toBe("T1.1.c2: not judged; T1.1.c3: not judged")
  })

  test("9 re-baselined (D3): a rejection at the budget exhausts it, and the run waits for the independent work", () => {
    const list: Fact[] = [started("T1.1")]
    for (let attempt = 1; attempt <= BUDGET; attempt++)
      list.push(
        ready("T1.1"),
        happyProof(),
        verified("T1.1", [reject("T1.1.c1", "weak"), trust("T1.1.c2"), trust("T1.1.c3")]),
      )
    const state = engine.view(fold(list))
    expect(state.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: BUDGET })
    expect(state.run.state).toBe("running")
  })

  test("10 ported: a stall keeps the task building with its attempts and records the reason", () => {
    const snapshot = fold([started("T1.1"), { type: "task.stalled", at: at(), task: "T1.1", reason: "stream idle 2s" }])
    expect(engine.view(snapshot).tasks["T1.1"]).toMatchObject({
      state: "building",
      attempts: 1,
      reason: "stream idle 2s",
    })
    expect(entriesOf(snapshot, "T1.1").at(-1)).toMatchObject({
      from: "building",
      to: "building",
      reason: "stream idle 2s",
    })
  })

  test("11 re-baselined (D3): a repetition returns the task with attempts + 1; at the budget it ends the task only", () => {
    const repeated = (): Fact => ({
      type: "task.repeated",
      at: at(),
      task: "T1.1",
      reason: "repetition: 3 identical read calls in a row",
    })
    const once = fold([started("T1.1"), repeated()])
    expect(engine.view(once).tasks["T1.1"]).toMatchObject({
      state: "building",
      attempts: 2,
      reason: "repetition: 3 identical read calls in a row",
    })
    expect(entriesOf(once, "T1.1").at(-1)?.reason).toContain("repetition")
    const spent = engine.view(fold([repeated(), repeated()], once))
    expect(spent.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: 3 })
    expect(spent.run.state).toBe("running")
  })

  test("12 re-baselined (D3): needs_human ends an active task; the run waits for the independent work", () => {
    const snapshot = fold([
      started("T1.1"),
      { type: "task.needs_human", at: at(), task: "T1.1", reason: "insufficient_quota" },
    ])
    expect(engine.view(snapshot).tasks["T1.1"]).toMatchObject({ state: "needs_human", reason: "insufficient_quota" })
    expect(engine.view(snapshot).run.state).toBe("running")
    const ended = fold([...trustT12(), scenarioProved("S2", "passed"), scenarioVerified(trust("S2"))], snapshot)
    expect(engine.view(ended).run).toMatchObject({
      state: "needs_human",
      reason: "T1.1 needs human\nT1 blocked by T1.1",
    })
    // A task that has not started is not active.
    const initial = engine.initial(plan)
    expect(engine.apply(plan, initial, { type: "task.needs_human", at: at(), task: "T1.2", reason: "x" })).toBe(initial)
  })

  test("13 re-baselined (D3): task.failed fails the task; the run waits for the independent work", () => {
    const snapshot = fold([started("T1.1"), ready("T1.1"), failed("T1.1", "merge conflict")])
    expect(engine.view(snapshot).tasks["T1.1"]).toMatchObject({ state: "failed", reason: "merge conflict" })
    expect(engine.view(snapshot).run.state).toBe("running")
  })

  test("14 re-baselined (default 4): cancel moves every unfinished task to cancelled, the waiting parent too, and the run", () => {
    const snapshot = fold([
      started("T1.1"),
      started("T1.2"),
      ready("T1.2"),
      { type: "run.cancelled", at: at(), reason: "aborted" },
    ])
    const state = engine.view(snapshot)
    expect(state.tasks["T1.1"]).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.tasks["T1.2"]).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.tasks["T1"]).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.run).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.history.at(-1)).toMatchObject({ unit: "run", from: "running", to: "cancelled" })
  })

  test("15 ported: a stale obligation reopens its trusted task; a later round trusts it again", () => {
    const trusted = fold(trustT11())
    const reopened = fold([stale("T1.1.c2")], trusted)
    expect(engine.view(reopened).obligations["T1.1.c2"]).toMatchObject({ state: "stale", hash: "hash-new" })
    expect(engine.view(reopened).tasks["T1.1"]).toMatchObject({
      state: "proving",
      reason: "stale: T1.1.c2",
      attempts: 1,
    })
    expect(obligationStates(reopened, "T1.1")).toMatchObject({ "T1.1.c1": "trusted", "T1.1.c3": "trusted" })

    const reproved = fold([happyProof()], reopened)
    expect(engine.unitState(reproved, "T1.1")).toBe("verifying")
    expect(obligationStates(reproved, "T1.1")).toEqual({
      "T1.1.c1": "trusted",
      "T1.1.c2": "passed",
      "T1.1.c3": "trusted",
      "T1.1.p1": "trusted",
    })
    const again = fold([verified("T1.1", [trust("T1.1.c2")])], reproved)
    expect(engine.view(again).tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(engine.view(again).obligations["T1.1.c2"]).toMatchObject({ state: "trusted", hash: "hash-new" })
    for (const id of ["T1.1.c1", "T1.1.c3"])
      expect(entriesOf(again, id).some((item) => item.to === "stale")).toBe(false)

    // A pending obligation cannot go stale.
    const initial = engine.initial(plan)
    expect(engine.apply(plan, initial, stale("T1.2.c1", "x"))).toBe(initial)
  })

  test("16 ported: a failed result reopens a trusted obligation with its reason; a needs-judge result leaves it trusted", () => {
    const rejected = fold([
      started("T1.1"),
      ready("T1.1"),
      happyProof(),
      verified("T1.1", [trust("T1.1.c1"), trust("T1.1.c2"), reject("T1.1.c3", "too weak")]),
    ])
    expect(engine.view(rejected).obligations["T1.1.c1"]?.state).toBe("trusted")
    const reproved = fold(
      [
        ready("T1.1", "head2"),
        proved("T1.1", [fail("T1.1.c1", "the parser broke"), judge("T1.1.c2"), judge("T1.1.c3"), pass("T1.1.p1")]),
      ],
      rejected,
    )
    expect(engine.view(reproved).obligations["T1.1.c1"]).toMatchObject({ state: "failed", reason: "the parser broke" })
    expect(engine.view(reproved).obligations["T1.1.c2"]?.state).toBe("trusted")
    expect(entriesOf(reproved, "T1.1.c1").at(-1)).toMatchObject({
      from: "trusted",
      to: "failed",
      reason: "the parser broke",
    })
    expect(engine.view(reproved).tasks["T1.1"]).toMatchObject({ state: "building", attempts: 3 })
  })

  test("17 re-baselined (D3, D4): a parent is reviewed once its children are trusted; trusted with attempts 1, or failed and never rebuilt", () => {
    const children = fold([...trustT11(), ...trustT12()])
    expect(engine.unitState(children, "T1")).toBe("waiting")
    expect(children.hasTag("T1:ready")).toBe(true)
    const verifying = fold([proved("T1", [])], children)
    expect(engine.view(verifying).tasks["T1"]).toMatchObject({ state: "verifying", attempts: 0 })
    expect(engine.view(verifying).obligations["T1.e1"]?.state).toBe("passed")

    const trusted = fold([verified("T1", [trust("T1.e1")])], verifying)
    expect(engine.view(trusted).tasks["T1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(engine.view(trusted).obligations["T1.e1"]?.state).toBe("trusted")

    const failedReview = fold([verified("T1", [reject("T1.e1", "the combined diff misses a test")])], verifying)
    expect(engine.view(failedReview).tasks["T1"]).toMatchObject({
      state: "failed",
      reason: "T1.e1: the combined diff misses a test",
    })
    // The scenarios still run (D3).
    expect(engine.view(failedReview).run.state).toBe("running")

    // A leaf ignores task.proved before it is proving, and a parent ignores task.started.
    const initial = engine.initial(plan)
    expect(fold([proved("T1.1", [judge("T1.1.c1")]), started("T1")], initial)).toBe(initial)
  })

  test("18 re-baselined (D4): a scenario is proved once its needs are trusted, then verified; a failure or a rejection ends it", () => {
    const needs = fold(trustT11())
    expect(engine.unitState(needs, "S1")).toBe("pending")
    const verifying = fold([scenarioProved("S1", "passed")], needs)
    expect(engine.unitState(verifying, "S1")).toBe("pending")
    expect(engine.tags(verifying, "S1")).toEqual(["active"])
    const trusted = fold([scenarioVerified(trust("S1"))], verifying)
    expect(engine.view(trusted).scenarios["S1"]?.state).toBe("trusted")
    const rejected = fold([scenarioVerified(reject("S1", "no step 3"))], verifying)
    expect(engine.view(rejected).scenarios["S1"]).toMatchObject({ state: "rejected", reason: "no step 3" })
    const failedProof = fold([...trustT12(), scenarioProved("S2", "failed", "2 tests failed")])
    expect(engine.view(failedProof).scenarios["S2"]).toMatchObject({ state: "failed", reason: "2 tests failed" })
    // A verdict for a scenario that was not proved changes nothing.
    expect(engine.apply(plan, needs, scenarioVerified(trust("S2")))).toBe(needs)
  })

  test("19 re-baselined (D3, AD-4): run facts: started, resumed, outside trust, and run.ended as a stop", () => {
    const snapshot = fold([
      { type: "run.started", at: at() },
      { type: "outside.trusted", at: at(), id: "T9" },
      { type: "run.resumed", at: at() },
    ])
    expect(engine.view(snapshot).run.state).toBe("running")
    expect(snapshot.context.log.map(({ at: _, ...item }) => item)).toEqual([
      { unit: "run", from: "running", to: "running" },
      { unit: "T9", to: "trusted", reason: "outside" },
      { unit: "run", from: "running", to: "running", reason: "resumed" },
    ])
    expect(engine.view(snapshot).tasks).toEqual(engine.view(engine.initial(plan)).tasks)
    const done = engine.view(fold([{ type: "run.ended", at: at(), state: "done" }], snapshot))
    expect(done.run.state).toBe("done")
    expect(done.tasks["T1.1"]?.state).toBe("cancelled")
    expect(
      engine.view(fold([{ type: "run.ended", at: at(), state: "failed", reason: "x" }], snapshot)).run,
    ).toMatchObject({
      state: "failed",
      reason: "x",
    })
  })

  test("20 ported: a fact that matches no row changes nothing and adds no history", () => {
    const initial = engine.initial(plan)
    for (const fact of [
      ready("T1.1"),
      proved("T1.1", [fail("T1.1.c1", "x")]),
      verified("T1.1", [trust("T1.1.c1")]),
      { type: "task.stalled", at: at(), task: "T1.1", reason: "idle" } satisfies Fact,
      started("T7"),
    ])
      expect(engine.apply(plan, initial, fact)).toBe(initial)
  })

  test("21 re-baselined (D3): facts after the run ended change nothing", () => {
    const ended = fold([started("T1.1"), { type: "run.cancelled", at: at(), reason: "abort" }])
    expect(engine.ended(ended)).toBe(true)
    for (const fact of [
      ready("T1.1"),
      started("T1.2"),
      { type: "run.resumed", at: at() } satisfies Fact,
      { type: "run.cancelled", at: at(), reason: "abort" } satisfies Fact,
      { type: "outside.trusted", at: at(), id: "T9" } satisfies Fact,
      scenarioProved("S1", "passed"),
    ])
      expect(engine.apply(plan, ended, fact)).toBe(ended)
    const done = fold([{ type: "run.ended", at: at(), state: "done" }])
    expect(engine.apply(plan, done, started("T1.1"))).toBe(done)
  })

  test("22 ported: apply is pure: it never changes the snapshot it receives", () => {
    const before = fold([started("T1.1"), ready("T1.1")])
    const copy = structuredClone(before.context)
    engine.apply(plan, before, failingProof())
    expect(before.context).toEqual(copy)
  })

  test("23 re-baselined (D3, D4): a parent's stale review obligation reopens it once; the new review trusts it (attempts 1) or fails it", () => {
    const trusted = fold([...trustT11(), ...trustT12(), proved("T1", []), verified("T1", [trust("T1.e1")])])
    expect(engine.view(trusted).tasks["T1"]).toMatchObject({ state: "trusted", attempts: 1 })
    const reopened = fold([stale("T1.e1")], trusted)
    expect(engine.view(reopened).obligations["T1.e1"]).toMatchObject({ state: "stale", hash: "hash-new" })
    expect(engine.view(reopened).tasks["T1"]).toMatchObject({ state: "proving", attempts: 1, reason: "stale: T1.e1" })

    // The new proof round gives the review obligation no result: it waits for the reviewer again.
    const reproved = fold([proved("T1", [])], reopened)
    expect(engine.unitState(reproved, "T1")).toBe("verifying")
    expect(engine.view(reproved).obligations["T1.e1"]?.state).toBe("passed")

    const again = fold([verified("T1", [trust("T1.e1")])], reproved)
    expect(engine.view(again).tasks["T1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(engine.view(again).obligations["T1.e1"]).toMatchObject({ state: "trusted", hash: "hash-new" })
    expect(engine.view(again).run.state).toBe("running")

    const failedReview = fold([verified("T1", [reject("T1.e1", "the new diff drops a test")])], reproved)
    expect(engine.view(failedReview).tasks["T1"]).toMatchObject({
      state: "failed",
      reason: "T1.e1: the new diff drops a test",
    })
    expect(engine.view(failedReview).run.state).toBe("running")
  })

  test("24 re-baselined (D3): task.failed fails a waiting leaf, a waiting parent and a verifying leaf; the run does not follow", () => {
    for (const [from, id] of [
      [engine.initial(plan), "T1.1"],
      [engine.initial(plan), "T1"],
      [fold([started("T1.1"), ready("T1.1"), happyProof()]), "T1.1"],
    ] as const) {
      const before = engine.view(from).tasks[id]?.state
      const snapshot = fold([failed(id, "merge conflict")], from)
      expect(engine.view(snapshot).tasks[id]).toMatchObject({ state: "failed", reason: "merge conflict" })
      expect(engine.view(snapshot).run.state).toBe("running")
      expect(entriesOf(snapshot, id).at(-1)).toMatchObject({ from: before, to: "failed", reason: "merge conflict" })
      expect(entriesOf(snapshot, "run")).toEqual([])
    }
  })

  test("25 retired, replaced by: a fact that moves nothing returns the identical snapshot (a stale rejected obligation)", () => {
    const rejected = fold([
      started("T1.1"),
      ready("T1.1"),
      happyProof(),
      verified("T1.1", [trust("T1.1.c1"), trust("T1.1.c2"), reject("T1.1.c3", "too weak")]),
    ])
    expect(engine.apply(plan, rejected, stale("T1.1.c3"))).toBe(rejected)
  })

  test("26 retired, replaced by: an unknown id returns the identical snapshot", () => {
    const initial = engine.initial(plan)
    for (const fact of [stale("T2.1.c1"), started("T2.1"), scenarioProved("S99", "passed")])
      expect(engine.apply(plan, initial, fact)).toBe(initial)
  })

  it.live("27 retired, replaced by: a foreign snapshot dies", () =>
    Effect.gen(function* () {
      const other = yield* loadPlan("example-cascade.spec")
      expect(() => engine.apply(plan, engine.initial(other), started("T1.1"))).toThrow(/another plan/)
    }),
  )
})

describe("the run machine on the release-notes and live-check plans", () => {
  it.live("RM7 blocks T1.5 and T1 in the fold step that exhausts T1.4, with the named cause", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const list = observed(notes)
      const before = foldOf(notes, list.slice(0, -1))
      expect(engine.unitState(before, "T1.5")).toBe("waiting")
      expect(before.hasTag("T1.5:ready")).toBe(false)
      const after = foldOf(notes, list.slice(-1), before)
      for (const id of ["T1.5", "T1"]) {
        expect(engine.unitState(after, id)).toBe("blocked")
        expect(engine.blockedBy(after, id)).toEqual({ id: "T1.4", state: "budget_exhausted" })
        expect(engine.view(after).tasks[id]?.reason).toBe("blocked by T1.4: budget exhausted")
      }
    }),
  )

  it.live("RM8c the observed slice folds to its end: done, budget exhausted, T1.5 and T1 blocked", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const f = facts()
      const stuck = foldOf(notes, observed(notes, f))
      // The scenarios whose needs are trusted are ready: the run ends only when they end (D3).
      const ready = ["S2", "S3", "S4", "S7", "S12"]
      expect(ready.map((id) => engine.unitState(stuck, id))).toEqual(Array(5).fill("pending"))
      expect(engine.ended(stuck)).toBe(false)
      // The old runner proved a scenario as soon as its needs were trusted, so the stored slice holds those proofs.
      const done = foldOf(
        notes,
        ready.flatMap((id) => [f.scenarioProved(id, "passed"), f.scenarioVerified({ id, verdict: "trusted" })]),
        stuck,
      )
      expect(engine.ended(done)).toBe(true)
      expect(engine.view(done).run).toMatchObject({
        state: "budget_exhausted",
        reason: "T1.4 budget exhausted\nT1 blocked by T1.4\nT1.5 blocked by T1.4",
      })
      expect(engine.unitState(done, "T1.5")).toBe("blocked")
      expect(engine.unitState(done, "T1")).toBe("blocked")
    }),
  )

  it.live("RM8a a stored old slice that ended folds with its stop's state", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const f = facts()
      const snapshot = foldOf(notes, [f.runStarted(), ...trustLeaf(notes, f, "T1.1"), f.ended("done")])
      expect(engine.ended(snapshot)).toBe(true)
      expect(engine.view(snapshot).run.state).toBe("done")
      expect(engine.view(snapshot).tasks["T1.2"]?.state).toBe("cancelled")
    }),
  )

  it.live("RM9 the cascade is transitive and names the first dead dependency", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const f = facts()
      const snapshot = foldOf(notes, [f.runStarted(), f.started("T1.2"), f.failed("T1.2", "the builder session died")])
      expect(engine.blockedBy(snapshot, "T1.4")).toEqual({ id: "T1.2", state: "failed" })
      expect(engine.blockedBy(snapshot, "T1.5")).toEqual({ id: "T1.4", state: "blocked" })
      expect(engine.blockedBy(snapshot, "T1")).toEqual({ id: "T1.2", state: "failed" })
      expect(engine.unitState(snapshot, "S1")).toBe("blocked")
      // Two dead dependencies at once: with T1.2 after T1.1, T1.1's death blocks T1.2 and T1.3 together, and T1.4
      // (after T1.2, T1.3) names the first of them in dependency order.
      const chained: Plan = {
        ...notes,
        tasks: notes.tasks.map((task) => (task.id === "T1.2" ? { ...task, afterEffective: ["T1.1"] } : task)),
      }
      const both = foldOf(chained, [f.runStarted(), f.started("T1.1"), f.failed("T1.1", "the builder session died")])
      expect(engine.blockedBy(both, "T1.2")).toEqual({ id: "T1.1", state: "failed" })
      expect(engine.blockedBy(both, "T1.3")).toEqual({ id: "T1.1", state: "failed" })
      expect(engine.blockedBy(both, "T1.4")).toEqual({ id: "T1.2", state: "blocked" })
    }),
  )

  it.live("RM15 a task is ready only when every after task and child is trusted, and waits again on a stale", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const f = facts()
      const trusted = foldOf(notes, [f.runStarted(), ...trustLeaf(notes, f, "T1.1")])
      expect(trusted.hasTag("T1.3:ready")).toBe(true)
      expect(engine.waitingOn(trusted, "T1.4")).toEqual(["T1.2", "T1.3"])
      const reopened = engine.apply(notes, trusted, f.stale("T1.1.c1"))
      expect(reopened.hasTag("T1.3:ready")).toBe(false)
      expect(engine.waitingOn(reopened, "T1.3")).toEqual(["T1.1"])
      // A parent waits on its children: T1 stays waiting while T1.5 is not trusted, and is ready once it is.
      const children = foldOf(notes, [
        f.runStarted(),
        ...trustLeaf(notes, f, "T1.1"),
        ...trustLeaf(notes, f, "T1.2"),
        ...trustLeaf(notes, f, "T1.3"),
        ...trustLeaf(notes, f, "T1.4"),
        f.outside("T9"),
      ])
      expect(engine.unitState(children, "T1")).toBe("waiting")
      // A ready task also shows waiting, so the phase tag tells them apart: T1 is not ready.
      expect(children.hasTag("T1:ready")).toBe(false)
      expect(engine.waitingOn(children, "T1")).toEqual(["T1.5"])
      const parent = foldOf(notes, trustLeaf(notes, f, "T1.5"), children)
      expect(parent.hasTag("T1:ready")).toBe(true)
    }),
  )

  it.live("RM16 two siblings with no after between them become ready in the same step", () =>
    Effect.gen(function* () {
      const loaded = yield* loadPlan("release-notes.spec")
      // T1.2 and T1.3 both come after T1.1 here, and not after each other.
      const notes: Plan = {
        ...loaded,
        tasks: loaded.tasks.map((task) => (task.id === "T1.2" ? { ...task, afterEffective: ["T1.1"] } : task)),
      }
      const f = facts()
      const own = notes.spec.obligations.filter((item) => item.task === "T1.1").map((item) => item.id)
      const verifying = foldOf(notes, [
        f.runStarted(),
        f.started("T1.1"),
        f.ready("T1.1"),
        f.proved(
          "T1.1",
          own.map((id) => ({ id, status: "passed" as const })),
        ),
      ])
      expect(["T1.2", "T1.3"].map((id) => engine.unitState(verifying, id))).toEqual(["waiting", "waiting"])
      expect(verifying.hasTag("T1.2:ready") || verifying.hasTag("T1.3:ready")).toBe(false)
      // The one step that trusts T1.1 readies both.
      const trusted = engine.apply(notes, verifying, f.verified("T1.1", []))
      expect(engine.unitState(trusted, "T1.1")).toBe("trusted")
      expect(trusted.hasTag("T1.2:ready") && trusted.hasTag("T1.3:ready")).toBe(true)
    }),
  )

  it.live(
    "RM17 a task after an untrusted outside id waits and moves on its trust; a second trust changes nothing",
    () =>
      Effect.gen(function* () {
        const notes = yield* loadPlan("release-notes.spec")
        const f = facts()
        const tasks = foldOf(notes, [
          f.runStarted(),
          ...trustLeaf(notes, f, "T1.1"),
          ...trustLeaf(notes, f, "T1.2"),
          ...trustLeaf(notes, f, "T1.3"),
          ...trustLeaf(notes, f, "T1.4"),
        ])
        expect(engine.waitingOn(tasks, "T1.5")).toEqual(["T9"])
        // A ready task also shows waiting, so the phase tag tells them apart: T1.5 is not ready before the trust.
        expect(tasks.hasTag("T1.5:ready")).toBe(false)
        const trusted = engine.apply(notes, tasks, f.outside("T9"))
        expect(trusted.hasTag("T1.5:ready")).toBe(true)
        expect(engine.apply(notes, trusted, f.outside("T9"))).toBe(trusted)
      }),
  )

  it.live("RM11 the task that died first gives the outcome, with lines for each dead and each blocked task", () =>
    Effect.gen(function* () {
      const cascade = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = foldOf(cascade, [
        f.runStarted(),
        f.started("T1.1"),
        f.needsHuman("T1.1", "spend cap: $5.00 reached"),
        f.started("T1.3"),
        f.failed("T1.3", "the builder session died"),
      ])
      expect(engine.view(snapshot).run).toMatchObject({
        state: "needs_human",
        reason: "T1.1 needs human\nT1.3 failed\nT1 blocked by T1.1\nT1.2 blocked by T1.1",
      })
      // The other order: T1.3 dies first, so its state decides, although T1.1 has the lower id and needs_human comes
      // first among the dead states.
      const g = facts()
      const later = foldOf(cascade, [
        g.runStarted(),
        g.started("T1.1"),
        g.started("T1.3"),
        g.failed("T1.3", "the builder session died"),
        g.needsHuman("T1.1", "spend cap: $5.00 reached"),
      ])
      expect(engine.view(later).run).toMatchObject({
        state: "failed",
        reason: "T1.1 needs human\nT1.3 failed\nT1 blocked by T1.3\nT1.2 blocked by T1.1",
      })
    }),
  )

  it.live("RM11 a task.failed death decides the outcome once the independent task ends", () =>
    Effect.gen(function* () {
      const cascade = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const dead = foldOf(cascade, [f.runStarted(), f.started("T1.1"), f.failed("T1.1", "the merge failed")])
      expect(engine.ended(dead)).toBe(false)
      const done = foldOf(cascade, trustLeaf(cascade, f, "T1.3"), dead)
      expect(engine.ended(done)).toBe(true)
      expect(engine.view(done).run).toMatchObject({
        state: "failed",
        reason: "T1.1 failed\nT1 blocked by T1.1\nT1.2 blocked by T1.1",
      })
    }),
  )

  it.live("RM12 owner ruling 1: every task trusted and a scenario rejected ends the run failed", () =>
    Effect.gen(function* () {
      const slugs = yield* loadPlan("example-scenarios.spec")
      const f = facts()
      const snapshot = foldOf(slugs, [
        f.runStarted(),
        ...trustLeaf(slugs, f, "T1.1"),
        f.proved("T1", []),
        f.verified("T1", [{ id: "T1.e1", verdict: "trusted" }]),
        f.scenarioProved("S1", "passed"),
        f.scenarioVerified({ id: "S1", verdict: "rejected", reason: "the slug keeps the colon" }),
      ])
      expect(engine.view(snapshot).run).toMatchObject({ state: "failed", reason: "acceptance not proved: S1 rejected" })
    }),
  )

  it.live("RM13 owner ruling 1: a parked scenario adds its not-run line, and the run still ends done", () =>
    Effect.gen(function* () {
      const subtree = yield* loadPlan("release-notes.spec", "T1.4")
      const f = facts()
      const snapshot = foldOf(subtree, [
        f.runStarted(),
        f.outside("T1.2"),
        f.outside("T1.3"),
        ...trustLeaf(subtree, f, "T1.4"),
        ...["S6", "S8", "S9", "S11"].flatMap((id) => [
          f.scenarioProved(id, "passed"),
          f.scenarioVerified({ id, verdict: "trusted" }),
        ]),
      ])
      expect(engine.view(snapshot).run).toMatchObject({ state: "done", reason: "not run: S13 waits on T8" })
    }),
  )

  it.live("RM14 a cancel and a wall-clock stop finish the unfinished units and end the run", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const f = facts()
      const going = foldOf(notes, [f.runStarted(), ...trustLeaf(notes, f, "T1.1"), f.started("T1.2")])
      const cancelled = engine.view(engine.apply(notes, going, f.cancelled("user stop")))
      expect(cancelled.run).toMatchObject({ state: "cancelled", reason: "user stop" })
      expect(cancelled.tasks["T1.1"]?.state).toBe("trusted")
      expect(cancelled.tasks["T1.2"]?.state).toBe("cancelled")
      const clocked = engine.view(
        engine.apply(notes, going, f.ended("failed", "wall clock: the run took over 120 min")),
      )
      expect(clocked.run).toMatchObject({ state: "failed", reason: "wall clock: the run took over 120 min" })
      expect(clocked.scenarios["S2"]?.state).toBe("cancelled")
    }),
  )

  it.live("RM27 AC 4 outranks the spine: a stop after a death ends in the dead task's state", () =>
    Effect.gen(function* () {
      const cascade = yield* loadPlan("example-cascade.spec")
      const f = facts()
      const snapshot = foldOf(cascade, [
        f.runStarted(),
        ...exhaustLeaf(f, "T1.1", "T1.1.c1", 1),
        f.started("T1.3"),
        f.cancelled("user stop"),
      ])
      expect(engine.view(snapshot).run).toMatchObject({
        state: "budget_exhausted",
        reason: "T1.1 budget exhausted\nT1 blocked by T1.1\nT1.2 blocked by T1.1\nuser stop",
      })
      expect(engine.view(snapshot).tasks["T1.3"]?.state).toBe("cancelled")
    }),
  )
})

describe("the fact list (AD-10)", () => {
  // The decoded value, compared as plain data with the input.
  const decode = (input: unknown): unknown => Schema.decodeUnknownSync(TaskEvents.FactSchema)(input)

  it.live("folds task.nudged as a targetless building entry with its reason", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      const f = facts()
      const building = foldOf(notes, [f.runStarted(), f.started("T1.1")])
      const nudged = foldOf(notes, [f.nudged("T1.1", 1, "idle without task_ready")], building)
      expect(engine.view(nudged).tasks["T1.1"]).toMatchObject({ state: "building", attempts: 1 })
      expect(nudged.context.log.at(-1)).toMatchObject({
        unit: "T1.1",
        from: "building",
        to: "building",
        reason: "idle without task_ready",
      })
      // A nudge is a note: it moves no state, and a second one adds a second entry.
      const twice = foldOf(notes, [f.nudged("T1.1", 2, "idle again")], nudged)
      expect(twice.context.log.filter((entry) => entry.unit === "T1.1").map((entry) => entry.reason)).toEqual([
        undefined,
        "idle without task_ready",
        "idle again",
      ])
      // A nudge for a task that is not building changes nothing.
      expect(engine.apply(notes, building, f.nudged("T1.2", 1, "not building"))).toBe(building)
    }),
  )

  test("decodes task.nudged with nudge 1 or 2 and refuses any other", () => {
    for (const nudge of [1, 2]) {
      const fact = { type: "task.nudged", at: 1, task: "T1.1", nudge, reason: "idle" }
      expect(decode(fact)).toEqual(fact)
    }
    expect(() => decode({ type: "task.nudged", at: 1, task: "T1.1", nudge: 3, reason: "idle" })).toThrow()
    expect(() => decode({ type: "task.nudged", at: 1, task: "T1.1", reason: "idle" })).toThrow()
  })

  test("decodes run.started and run.resumed with or without a path", () => {
    for (const type of ["run.started", "run.resumed"]) {
      expect(decode({ type, at: 1 })).toEqual({ type, at: 1 })
      expect(decode({ type, at: 1, path: "task-formats/blend/release-notes.spec" })).toEqual({
        type,
        at: 1,
        path: "task-formats/blend/release-notes.spec",
      })
      expect(decode({ type, at: 1, base: "dev", path: "x.spec" })).toEqual({ type, at: 1, base: "dev", path: "x.spec" })
    }
  })

  it.live("still decodes every stored fact of the observed release-notes run (durable v1)", () =>
    Effect.gen(function* () {
      const notes = yield* loadPlan("release-notes.spec")
      for (const fact of observed(notes)) expect(decode(fact)).toEqual(fact)
    }),
  )
})

describe("the base of an unfinished run", () => {
  test("B1 ported: is the branch its run.started recorded, until the run ends", () => {
    const begun: Fact[] = [{ type: "run.started", at: at(), base: "dev" }]
    expect(TaskRunner.unfinishedBase(engine.XStateEngine, plan, begun)).toEqual(Option.some("dev"))
    const resumed: Fact[] = [...begun, { type: "run.resumed", at: at(), base: "dev" }]
    expect(TaskRunner.unfinishedBase(engine.XStateEngine, plan, resumed)).toEqual(Option.some("dev"))
    const cancelled: Fact[] = [...begun, { type: "run.cancelled", at: at(), reason: "stop" }]
    expect(TaskRunner.unfinishedBase(engine.XStateEngine, plan, cancelled)).toEqual(Option.none())
  })

  test("B2 ported: is unknown for a run stored before the base was recorded", () => {
    expect(TaskRunner.unfinishedBase(engine.XStateEngine, plan, [{ type: "run.started", at: at() }])).toEqual(
      Option.none(),
    )
  })
})

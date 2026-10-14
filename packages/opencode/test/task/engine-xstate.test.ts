import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { BlendModel } from "@/task/blend/model"
import type { Fact, Plan, Result, State, Verdict } from "@/task/core/model"
import { TaskRunner } from "@/task/core/runner"
import { TaskEngineXState } from "@/task/engine-xstate"

// A small spec: parent T1 with leaves T1.1 and T1.2. T1.1 has three test obligations and one gate obligation;
// T1.2 has one test obligation; T1 has one review obligation. Budget 3 for every task.
//
// These cases are the engine's contract: what each fact does to the folded state, history included.

const engine = TaskEngineXState.XStateEngine
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
  reason,
})
const verified = (id: string, verdicts: ReadonlyArray<Verdict>): Fact => ({
  type: "task.verified",
  at: at(),
  task: id,
  verdicts,
})

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

const obligationStates = (state: State, prefix: string) =>
  Object.fromEntries(
    Object.values(state.obligations)
      .filter((item) => item.task === prefix)
      .map((item) => [item.id, item.state]),
  )

const entriesOf = (state: State, unit: string) => state.history.filter((item) => item.unit === unit)

// A changed copy of a state: one the fold never makes, for the cases that ask how an engine treats it.
const altered = (state: State, change: (copy: State) => unknown): State => {
  const copy = structuredClone(state)
  change(copy)
  return copy
}

describe("XStateEngine", () => {
  const fold = (facts: ReadonlyArray<Fact>, from: State = engine.initial(plan)) =>
    facts.reduce((state, fact) => engine.apply(plan, state, fact), from)

  test("is named xstate", () => {
    expect(engine.name).toBe("xstate")
  })

  test("the initial state: tasks waiting, obligations pending, scenarios waiting", () => {
    const state = engine.initial(plan)
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

  test("the happy leaf path: waiting, building, proving, verifying, trusted with attempts 1", () => {
    const building = fold([started("T1.1")])
    expect(building.tasks["T1.1"]).toMatchObject({
      state: "building",
      attempts: 1,
      worktree: "/wt/T1.1",
      branch: "task/T1.1",
      base: "base0",
      session: "ses_T1.1",
    })
    const proving = fold([ready("T1.1", "abc")], building)
    expect(proving.tasks["T1.1"]).toMatchObject({ state: "proving", head: "abc", attempts: 1 })

    const verifying = fold([happyProof()], proving)
    expect(verifying.tasks["T1.1"].state).toBe("verifying")
    // needs-judge: passed; machine-judged gate: trusted at once.
    expect(obligationStates(verifying, "T1.1")).toEqual({
      "T1.1.c1": "passed",
      "T1.1.c2": "passed",
      "T1.1.c3": "passed",
      "T1.1.p1": "trusted",
    })

    const trusted = fold([trustAll()], verifying)
    expect(trusted.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(Object.values(obligationStates(trusted, "T1.1"))).toEqual(["trusted", "trusted", "trusted", "trusted"])
    expect(trusted.run.state).toBe("running")
    expect(entriesOf(trusted, "T1.1").map((item) => [item.from, item.to])).toEqual([
      ["waiting", "building"],
      ["building", "proving"],
      ["proving", "verifying"],
      ["verifying", "trusted"],
    ])
    // Every entry takes the fact's time, in order.
    const times = trusted.history.map((item) => item.at)
    expect(times).toEqual(times.toSorted((a, b) => a - b))
  })

  test("a failed proof returns the task to the builder with the failed ids and reasons", () => {
    const state = fold([started("T1.1"), ready("T1.1"), failingProof()])
    expect(state.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 2 })
    expect(state.tasks["T1.1"].reason).toContain("T1.1.c1: expected feat")
    expect(state.obligations["T1.1.c1"]).toMatchObject({ state: "failed", reason: "expected feat" })
    expect(state.obligations["T1.1.c2"].state).toBe("passed")
    // No verifier round happened, so nothing that needs a judge is trusted.
    expect(state.history.some((item) => item.unit === "T1.1.c2" && item.to === "trusted")).toBe(false)

    const retried = fold([ready("T1.1"), happyProof(), trustAll()], state)
    expect(retried.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 2 })
    expect(retried.tasks["T1.1"].reason).toBeUndefined()
  })

  test("the proof's own reason (a structural failure) is part of the task reason", () => {
    const state = fold([
      started("T1.1"),
      ready("T1.1"),
      proved("T1.1", [fail("T1.1.c1", "tampered")], "test/verify-release-notes-S3.spec.ts holds another task's tag"),
    ])
    expect(state.tasks["T1.1"].reason).toContain("test/verify-release-notes-S3.spec.ts")
  })

  test("budget exhaustion at the budget ends the task and the run", () => {
    const facts: Fact[] = [started("T1.1")]
    for (let attempt = 1; attempt <= BUDGET; attempt++) facts.push(ready("T1.1"), failingProof())
    const state = fold(facts)
    expect(state.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: BUDGET })
    expect(state.run.state).toBe("budget_exhausted")
    expect(state.run.reason).toContain("T1.1")
    // Three builds: attempts 1, 2, 3; never a 4th.
    expect(entriesOf(state, "T1.1").filter((item) => item.to === "building")).toHaveLength(BUDGET)
  })

  test("a rejection reopens only the rejected id; the others stay trusted", () => {
    const rejected = fold([
      started("T1.1"),
      ready("T1.1"),
      happyProof(),
      verified("T1.1", [trust("T1.1.c1"), trust("T1.1.c2"), reject("T1.1.c3", "the refs test does not cover Refs #")]),
    ])
    expect(rejected.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 2 })
    expect(rejected.tasks["T1.1"].reason).toBe("T1.1.c3: the refs test does not cover Refs #")
    expect(rejected.obligations["T1.1.c3"]).toMatchObject({
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
    expect(trusted.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 2 })
    for (const id of ["T1.1.c1", "T1.1.c2"])
      expect(entriesOf(trusted, id).map((item) => item.to)).toEqual(["passed", "trusted"])
  })

  test("a verifier round that leaves an obligation unjudged also returns the task", () => {
    const state = fold([started("T1.1"), ready("T1.1"), happyProof(), verified("T1.1", [trust("T1.1.c1")])])
    expect(state.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 2 })
    expect(state.tasks["T1.1"].reason).toBe("T1.1.c2: not judged; T1.1.c3: not judged")
  })

  test("a rejection at the budget exhausts it", () => {
    const facts: Fact[] = [started("T1.1")]
    for (let attempt = 1; attempt <= BUDGET; attempt++)
      facts.push(
        ready("T1.1"),
        happyProof(),
        verified("T1.1", [reject("T1.1.c1", "weak"), trust("T1.1.c2"), trust("T1.1.c3")]),
      )
    const state = fold(facts)
    expect(state.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: BUDGET })
    expect(state.run.state).toBe("budget_exhausted")
  })

  test("a stall keeps the task building with its attempts and records the reason", () => {
    const state = fold([started("T1.1"), { type: "task.stalled", at: at(), task: "T1.1", reason: "stream idle 2s" }])
    expect(state.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 1, reason: "stream idle 2s" })
    expect(entriesOf(state, "T1.1").at(-1)).toMatchObject({
      from: "building",
      to: "building",
      reason: "stream idle 2s",
    })
  })

  test("a repetition returns the task to the builder with attempts + 1, and exhausts the budget", () => {
    const repeated = (): Fact => ({
      type: "task.repeated",
      at: at(),
      task: "T1.1",
      reason: "repetition: 3 identical read calls in a row",
    })
    const once = fold([started("T1.1"), repeated()])
    expect(once.tasks["T1.1"]).toMatchObject({
      state: "building",
      attempts: 2,
      reason: "repetition: 3 identical read calls in a row",
    })
    expect(entriesOf(once, "T1.1").at(-1)?.reason).toContain("repetition")
    const spent = fold([repeated(), repeated()], once)
    expect(spent.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: 3 })
    expect(spent.run.state).toBe("budget_exhausted")
  })

  test("needs_human ends an active task and the run", () => {
    const state = fold([
      started("T1.1"),
      { type: "task.needs_human", at: at(), task: "T1.1", reason: "insufficient_quota" },
    ])
    expect(state.tasks["T1.1"]).toMatchObject({ state: "needs_human", reason: "insufficient_quota" })
    expect(state.run).toMatchObject({ state: "needs_human", reason: "T1.1: insufficient_quota" })
    // A waiting task is not active.
    const waiting = fold([{ type: "task.needs_human", at: at(), task: "T1.2", reason: "x" }])
    expect(waiting).toEqual(engine.initial(plan))
  })

  test("task.failed fails the task and the run", () => {
    const state = fold([
      started("T1.1"),
      ready("T1.1"),
      { type: "task.failed", at: at(), task: "T1.1", reason: "merge conflict" },
    ])
    expect(state.tasks["T1.1"]).toMatchObject({ state: "failed", reason: "merge conflict" })
    expect(state.run.state).toBe("failed")
  })

  test("cancel moves every building, proving or verifying task to cancelled, and the run", () => {
    const state = fold([
      started("T1.1"),
      started("T1.2"),
      ready("T1.2"),
      { type: "run.cancelled", at: at(), reason: "aborted" },
    ])
    expect(state.tasks["T1.1"]).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.tasks["T1.2"]).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.tasks["T1"].state).toBe("waiting")
    expect(state.run).toMatchObject({ state: "cancelled", reason: "aborted" })
    expect(state.history.at(-1)).toMatchObject({ unit: "run", from: "running", to: "cancelled" })
  })

  test("a stale obligation reopens its trusted task; a later round trusts it again", () => {
    const trusted = fold([started("T1.1"), ready("T1.1"), happyProof(), trustAll()])
    const stale = fold([{ type: "obligation.stale", at: at(), id: "T1.1.c2", hash: "hash-new" }], trusted)
    expect(stale.obligations["T1.1.c2"]).toMatchObject({ state: "stale", hash: "hash-new" })
    expect(stale.tasks["T1.1"]).toMatchObject({ state: "proving", reason: "stale: T1.1.c2", attempts: 1 })
    expect(obligationStates(stale, "T1.1")).toMatchObject({ "T1.1.c1": "trusted", "T1.1.c3": "trusted" })

    const reproved = fold([happyProof()], stale)
    expect(reproved.tasks["T1.1"].state).toBe("verifying")
    expect(obligationStates(reproved, "T1.1")).toEqual({
      "T1.1.c1": "trusted",
      "T1.1.c2": "passed",
      "T1.1.c3": "trusted",
      "T1.1.p1": "trusted",
    })
    const again = fold([verified("T1.1", [trust("T1.1.c2")])], reproved)
    expect(again.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(again.obligations["T1.1.c2"]).toMatchObject({ state: "trusted", hash: "hash-new" })
    for (const id of ["T1.1.c1", "T1.1.c3"])
      expect(entriesOf(again, id).some((item) => item.to === "stale")).toBe(false)

    // A pending obligation cannot go stale.
    const pending = fold([{ type: "obligation.stale", at: at(), id: "T1.2.c1", hash: "x" }])
    expect(pending).toEqual(engine.initial(plan))
  })

  test("a failed result reopens a trusted obligation with its reason; a needs-judge result leaves it trusted", () => {
    const rejected = fold([
      started("T1.1"),
      ready("T1.1"),
      happyProof(),
      verified("T1.1", [trust("T1.1.c1"), trust("T1.1.c2"), reject("T1.1.c3", "too weak")]),
    ])
    expect(rejected.obligations["T1.1.c1"].state).toBe("trusted")
    const reproved = fold(
      [
        ready("T1.1", "head2"),
        proved("T1.1", [fail("T1.1.c1", "the parser broke"), judge("T1.1.c2"), judge("T1.1.c3"), pass("T1.1.p1")]),
      ],
      rejected,
    )
    expect(reproved.obligations["T1.1.c1"]).toMatchObject({ state: "failed", reason: "the parser broke" })
    expect(reproved.obligations["T1.1.c2"].state).toBe("trusted")
    expect(entriesOf(reproved, "T1.1.c1").at(-1)).toMatchObject({
      from: "trusted",
      to: "failed",
      reason: "the parser broke",
    })
    expect(reproved.tasks["T1.1"]).toMatchObject({ state: "building", attempts: 3 })
  })

  test("a parent is reviewed once: trusted with attempts 1, or failed and never rebuilt", () => {
    const verifying = fold([proved("T1", [])])
    expect(verifying.tasks["T1"]).toMatchObject({ state: "verifying", attempts: 0 })
    expect(verifying.obligations["T1.e1"].state).toBe("passed")

    const trusted = fold([verified("T1", [trust("T1.e1")])], verifying)
    expect(trusted.tasks["T1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(trusted.obligations["T1.e1"].state).toBe("trusted")

    const failed = fold([verified("T1", [reject("T1.e1", "the combined diff misses a test")])], verifying)
    expect(failed.tasks["T1"]).toMatchObject({ state: "failed", reason: "T1.e1: the combined diff misses a test" })
    expect(failed.run.state).toBe("failed")

    // A leaf ignores task.proved while waiting, and a parent ignores task.started.
    expect(fold([proved("T1.1", [judge("T1.1.c1")]), started("T1")])).toEqual(engine.initial(plan))
  })

  test("scenarios: proved passed then verified; a failed proof or a rejection ends the scenario", () => {
    const verifying = fold([{ type: "scenario.proved", at: at(), id: "S1", status: "passed" }])
    expect(verifying.scenarios["S1"].state).toBe("verifying")
    const trusted = fold([{ type: "scenario.verified", at: at(), verdict: trust("S1") }], verifying)
    expect(trusted.scenarios["S1"].state).toBe("trusted")
    const rejected = fold([{ type: "scenario.verified", at: at(), verdict: reject("S1", "no step 3") }], verifying)
    expect(rejected.scenarios["S1"]).toMatchObject({ state: "rejected", reason: "no step 3" })
    const failed = fold([{ type: "scenario.proved", at: at(), id: "S2", status: "failed", reason: "2 tests failed" }])
    expect(failed.scenarios["S2"]).toMatchObject({ state: "failed", reason: "2 tests failed" })
    // A verdict for a scenario that was not proved changes nothing.
    expect(fold([{ type: "scenario.verified", at: at(), verdict: trust("S2") }])).toEqual(engine.initial(plan))
  })

  test("run facts: started, resumed, outside trust and the end", () => {
    const state = fold([
      { type: "run.started", at: at() },
      { type: "outside.trusted", at: at(), id: "T9" },
      { type: "run.resumed", at: at() },
    ])
    expect(state.run.state).toBe("running")
    expect(state.history.map(({ at: _, ...item }) => item)).toEqual([
      { unit: "run", from: "running", to: "running", reason: undefined },
      { unit: "T9", to: "trusted", reason: "outside" },
      { unit: "run", from: "running", to: "running", reason: "resumed" },
    ])
    expect(state.tasks).toEqual(engine.initial(plan).tasks)
    expect(fold([{ type: "run.ended", at: at(), state: "done" }], state).run.state).toBe("done")
    expect(fold([{ type: "run.ended", at: at(), state: "failed", reason: "x" }], state).run).toMatchObject({
      state: "failed",
      reason: "x",
    })
  })

  test("a fact that matches no row changes nothing and adds no history", () => {
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

  test("facts after the run ended change nothing", () => {
    const ended = fold([started("T1.1"), { type: "task.needs_human", at: at(), task: "T1.1", reason: "quota" }])
    for (const fact of [
      ready("T1.1"),
      started("T1.2"),
      { type: "run.resumed", at: at() } satisfies Fact,
      { type: "run.cancelled", at: at(), reason: "abort" } satisfies Fact,
      { type: "outside.trusted", at: at(), id: "T9" } satisfies Fact,
      { type: "scenario.proved", at: at(), id: "S1", status: "passed" } satisfies Fact,
    ])
      expect(engine.apply(plan, ended, fact)).toBe(ended)
    const done = fold([{ type: "run.ended", at: at(), state: "done" }])
    expect(engine.apply(plan, done, started("T1.1"))).toBe(done)
  })

  test("apply is pure: it never changes the state it receives", () => {
    const before = fold([started("T1.1"), ready("T1.1")])
    const copy = structuredClone(before)
    engine.apply(plan, before, failingProof())
    expect(before).toEqual(copy)
  })

  test("a parent's stale review obligation reopens it once; the new review trusts it (attempts 1) or fails it", () => {
    const trusted = fold([proved("T1", []), verified("T1", [trust("T1.e1")])])
    expect(trusted.tasks["T1"]).toMatchObject({ state: "trusted", attempts: 1 })
    const stale = fold([{ type: "obligation.stale", at: at(), id: "T1.e1", hash: "hash-new" }], trusted)
    expect(stale.obligations["T1.e1"]).toMatchObject({ state: "stale", hash: "hash-new" })
    expect(stale.tasks["T1"]).toMatchObject({ state: "proving", attempts: 1, reason: "stale: T1.e1" })

    // The new proof round gives the review obligation no result: it waits for the reviewer again.
    const reproved = fold([proved("T1", [])], stale)
    expect(reproved.tasks["T1"].state).toBe("verifying")
    expect(reproved.obligations["T1.e1"].state).toBe("passed")

    const again = fold([verified("T1", [trust("T1.e1")])], reproved)
    expect(again.tasks["T1"]).toMatchObject({ state: "trusted", attempts: 1 })
    expect(again.obligations["T1.e1"]).toMatchObject({ state: "trusted", hash: "hash-new" })
    expect(again.run.state).toBe("running")

    const failed = fold([verified("T1", [reject("T1.e1", "the new diff drops a test")])], reproved)
    expect(failed.tasks["T1"]).toMatchObject({ state: "failed", reason: "T1.e1: the new diff drops a test" })
    expect(failed.run).toMatchObject({ state: "failed", reason: "T1: T1.e1: the new diff drops a test" })
  })

  test("task.failed fails a waiting leaf, a waiting parent and a verifying leaf, and the run with it", () => {
    const failure = (task: string): Fact => ({ type: "task.failed", at: at(), task, reason: "merge conflict" })
    for (const [from, task] of [
      [engine.initial(plan), "T1.1"],
      [engine.initial(plan), "T1"],
      [fold([started("T1.1"), ready("T1.1"), happyProof()]), "T1.1"],
    ] as const) {
      const state = fold([failure(task)], from)
      expect(state.tasks[task]).toMatchObject({ state: "failed", reason: "merge conflict" })
      expect(state.run).toMatchObject({ state: "failed", reason: `${task}: merge conflict` })
      expect(state.history.slice(-2)).toMatchObject([
        { unit: task, from: from.tasks[task].state, to: "failed", reason: "merge conflict" },
        { unit: "run", from: "running", to: "failed", reason: `${task}: merge conflict` },
      ])
    }
  })

  test("obligation.stale on an obligation that is neither passed nor trusted changes nothing, its trusted task included", () => {
    const trusted = fold([started("T1.1"), ready("T1.1"), happyProof(), trustAll()])
    const odd = altered(trusted, (copy) => Object.assign(copy.obligations["T1.1.c2"], { state: "rejected" }))
    expect(engine.apply(plan, odd, { type: "obligation.stale", at: at(), id: "T1.1.c2", hash: "hash-new" })).toBe(odd)
  })

  test("obligation.stale moves an obligation whose task the state does not hold", () => {
    const orphan = altered(engine.initial(plan), (copy) =>
      Object.assign(copy.obligations, {
        "T2.1.c1": { id: "T2.1.c1", task: "T2.1", state: "trusted", hash: "hash-T2.1.c1" },
      }),
    )
    const after = engine.apply(plan, orphan, { type: "obligation.stale", at: at(), id: "T2.1.c1", hash: "hash-new" })
    expect(after.obligations["T2.1.c1"]).toEqual({ id: "T2.1.c1", task: "T2.1", state: "stale", hash: "hash-new" })
    expect(entriesOf(after, "T2.1.c1").map((item) => [item.from, item.to])).toEqual([["trusted", "stale"]])
    expect(after.tasks).toEqual(orphan.tasks)
  })

  test("a unit in a state its lifecycle does not name takes no fact, and no such state makes apply throw", () => {
    // A task: its own facts change nothing; one of its trusted obligations still goes stale.
    const lostTask = altered(fold([started("T1.1"), ready("T1.1"), happyProof(), trustAll()]), (copy) =>
      Object.assign(copy.tasks["T1.1"], { state: "lost" }),
    )
    for (const fact of [started("T1.1"), ready("T1.1"), happyProof(), trustAll()])
      expect(engine.apply(plan, lostTask, fact)).toBe(lostTask)
    const staled = engine.apply(plan, lostTask, { type: "obligation.stale", at: at(), id: "T1.1.c2", hash: "hash-new" })
    expect(staled.obligations["T1.1.c2"].state).toBe("stale")
    expect(staled.tasks["T1.1"]).toMatchObject({ state: "lost" })

    // An obligation: a proof round moves the task's other obligations and leaves it.
    const lostObligation = altered(fold([started("T1.1"), ready("T1.1")]), (copy) =>
      Object.assign(copy.obligations["T1.1.c1"], { state: "lost" }),
    )
    const proved = engine.apply(plan, lostObligation, happyProof())
    expect(proved.tasks["T1.1"].state).toBe("verifying")
    expect<Record<string, string>>(obligationStates(proved, "T1.1")).toEqual({
      "T1.1.c1": "lost",
      "T1.1.c2": "passed",
      "T1.1.c3": "passed",
      "T1.1.p1": "trusted",
    })

    // A scenario.
    const lostScenario = altered(engine.initial(plan), (copy) => Object.assign(copy.scenarios["S1"], { state: "lost" }))
    expect(engine.apply(plan, lostScenario, { type: "scenario.proved", at: at(), id: "S1", status: "passed" })).toBe(
      lostScenario,
    )

    // The run: its own facts change nothing; an outside trust is recorded, and it follows a task into an end state.
    const lostRun = altered(fold([started("T1.1")]), (copy) => Object.assign(copy.run, { state: "lost" }))
    for (const fact of [
      { type: "run.resumed", at: at() },
      { type: "run.cancelled", at: at(), reason: "abort" },
      { type: "run.ended", at: at(), state: "done" },
    ] satisfies Fact[])
      expect(engine.apply(plan, lostRun, fact)).toBe(lostRun)
    const outside = engine.apply(plan, lostRun, { type: "outside.trusted", at: at(), id: "T9" })
    expect(outside.history.at(-1)).toMatchObject({ unit: "T9", to: "trusted", reason: "outside" })
    const followed = engine.apply(plan, lostRun, { type: "task.needs_human", at: at(), task: "T1.1", reason: "quota" })
    expect(followed.run).toMatchObject({ state: "needs_human", reason: "T1.1: quota" })
    expect(followed.history.at(-1)).toMatchObject({ unit: "run", from: "lost", to: "needs_human" })
  })
})

describe("the base of an unfinished run", () => {
  test("is the branch its run.started recorded, until the run ends", () => {
    const started: Fact[] = [{ type: "run.started", at: at(), base: "dev" }]
    expect(TaskRunner.unfinishedBase(engine, plan, started)).toEqual(Option.some("dev"))
    const resumed: Fact[] = [...started, { type: "run.resumed", at: at(), base: "dev" }]
    expect(TaskRunner.unfinishedBase(engine, plan, resumed)).toEqual(Option.some("dev"))
    const cancelled: Fact[] = [...started, { type: "run.cancelled", at: at(), reason: "stop" }]
    expect(TaskRunner.unfinishedBase(engine, plan, cancelled)).toEqual(Option.none())
  })

  test("is unknown for a run stored before the base was recorded", () => {
    expect(TaskRunner.unfinishedBase(engine, plan, [{ type: "run.started", at: at() }])).toEqual(Option.none())
  })
})

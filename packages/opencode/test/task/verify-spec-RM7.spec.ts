import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { loadPlan, observed } from "./lib/machine"

// Scenario RM7 (spec task-harness-feedback, spine AD-3, AD-5, AD-6): the observed stuck run blocks its dependants in
// the same fold step.
//
//   Given the release-notes plan and the observed facts up to the second failing proof of T1.4
//   When the third failing proof of T1.4 is applied
//   Then T1.4 is budget exhausted
//   And T1.5 and T1 are blocked in the snapshot that apply returns
//   And each of T1.5 and T1 has a history entry whose reason is "blocked by T1.4: budget exhausted"
//   And T1.5 and T1 carry the blocked cause T1.4 in state budget_exhausted
//
// The plan comes from the real loader (`Blend.load` and `TaskCommand.plan`, through `loadPlan`); the facts are the
// fixture's observed release-notes facts (`observed`: run.started, T1.1 to T1.3 trusted, T1.4 built three times with a
// failing proof each time, budget 3). The given facts are every observed fact before T1.4's third failing proof: they
// end after the second failing proof and the third build's `task.ready`, which the third proof needs. The fold, the
// one step and the reads all go through the engine API (`initial`, `apply`, the selectors, `view`) and the status
// projection (`TaskStatus.project`).

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const CAUSE = { id: "T1.4", state: "budget_exhausted" }
const REASON = "blocked by T1.4: budget exhausted"
const DEPENDANTS = ["T1.5", "T1"]

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const failingProofsOf = (list: ReadonlyArray<Fact>, task: string) =>
  list.filter(
    (fact) => fact.type === "task.proved" && fact.task === task && fact.results.some((r) => r.status === "failed"),
  )

// The given facts, the snapshot they fold to, T1.4's third failing proof, and the one snapshot `apply` returns for it.
const scenario = Effect.gen(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const list = observed(plan)
  const given = list.slice(0, -1)
  const third = list.at(-1)
  if (third === undefined) return yield* Effect.die(new Error("the observed facts are empty"))
  const before = fold(plan, given)
  const after = engine.apply(plan, before, third)
  return { plan, list, given, third, before, after }
})

it.live("[RM7] the given facts end after T1.4's second failing proof, with T1.5 and T1 waiting and not blocked", () =>
  Effect.gen(function* () {
    const { plan, list, given, third, before } = yield* scenario
    // The release-notes plan: T1 is the parent of T1.1 to T1.5, and T1.5 is after T1.3, T1.4 and the outside T9.
    expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
    expect(plan.tasks.find((task) => task.id === "T1.5")?.afterEffective).toEqual(["T1.3", "T1.4", "T9"])
    expect(plan.budget("T1.4")).toBe(3)

    // The observed facts hold three failing proofs of T1.4; the given facts hold the first two.
    expect(failingProofsOf(list, "T1.4")).toHaveLength(3)
    expect(failingProofsOf(given, "T1.4")).toHaveLength(2)
    expect(third).toMatchObject({ type: "task.proved", task: "T1.4", results: [{ id: "T1.4.c7", status: "failed" }] })
    // After the second failing proof, only the third build's task.ready of T1.4 comes before the third proof.
    const second = given.lastIndexOf(failingProofsOf(given, "T1.4")[1])
    expect(given.slice(second + 1)).toMatchObject([{ type: "task.ready", task: "T1.4" }])

    // The fold of the given facts: T1.1 to T1.3 trusted, T1.4 proving its third attempt, the run still running.
    expect(before.status).toBe("active")
    expect(["T1.1", "T1.2", "T1.3"].map((id) => engine.unitState(before, id))).toEqual([
      "trusted",
      "trusted",
      "trusted",
    ])
    expect(engine.view(before).tasks["T1.4"]).toMatchObject({ state: "proving", attempts: 3 })
    expect(engine.view(before).run.state).toBe("running")

    // T1.5 and T1 wait: not ready, not blocked, no cause, and no blocked history entry yet.
    for (const id of DEPENDANTS) {
      expect(engine.unitState(before, id)).toBe("waiting")
      expect(before.hasTag(`${id}:ready`)).toBe(false)
      expect(engine.tags(before, id)).not.toContain("blocked")
      expect(engine.blockedBy(before, id)).toBeUndefined()
      expect(engine.view(before).history.filter((entry) => entry.unit === id && entry.to === "blocked")).toEqual([])
    }
    expect(engine.waitingOn(before, "T1.5")).toEqual(["T1.4", "T9"])
  }),
)

it.live("[RM7] one apply of T1.4's third failing proof makes T1.4 budget exhausted", () =>
  Effect.gen(function* () {
    const { after, before } = yield* scenario
    expect(after).not.toBe(before)
    expect(after.status).toBe("active")
    expect(engine.unitState(after, "T1.4")).toBe("budget_exhausted")
    expect(engine.view(after).tasks["T1.4"]).toMatchObject({ state: "budget_exhausted", attempts: 3 })
    expect(engine.tags(after, "T1.4")).toContain("dead")
    // The one step's history for T1.4: proving to budget_exhausted.
    const added = engine.view(after).history.slice(engine.view(before).history.length)
    expect(added.filter((entry) => entry.unit === "T1.4")).toMatchObject([{ from: "proving", to: "budget_exhausted" }])
  }),
)

it.live("[RM7] T1.5 and T1 are blocked in the snapshot that this one apply returns", () =>
  Effect.gen(function* () {
    const { after } = yield* scenario
    for (const id of DEPENDANTS) {
      expect(engine.unitState(after, id)).toBe("blocked")
      expect(engine.view(after).tasks[id]?.state).toBe("blocked")
      expect(engine.tags(after, id)).toContain("blocked")
      expect(after.hasTag(`${id}:ready`)).toBe(false)
    }
    // Nothing else moved to blocked: T1.1 to T1.3 stay trusted.
    expect(["T1.1", "T1.2", "T1.3"].map((id) => engine.unitState(after, id))).toEqual(["trusted", "trusted", "trusted"])
  }),
)

it.live('[RM7] each of T1.5 and T1 has a history entry whose reason is "blocked by T1.4: budget exhausted"', () =>
  Effect.gen(function* () {
    const { plan, after, before } = yield* scenario
    const old = engine.view(before).history
    const all = engine.view(after).history
    // The log only grows: the step appends to the history the given facts wrote.
    expect(all.slice(0, old.length)).toEqual([...old])
    const added = all.slice(old.length)
    for (const id of DEPENDANTS) {
      // Written by this one apply, from waiting to blocked, with the named reason.
      expect(added.filter((entry) => entry.unit === id)).toMatchObject([
        { from: "waiting", to: "blocked", reason: REASON },
      ])
      expect(all.filter((entry) => entry.unit === id && entry.reason === REASON)).toHaveLength(1)
      expect(engine.view(after).tasks[id]?.reason).toBe(REASON)
    }
    // The status projection carries the same history entries.
    const status = TaskStatus.project(plan, after)
    for (const id of DEPENDANTS)
      expect(status.history.filter((entry) => entry.unit === id && entry.to === "blocked")).toMatchObject([
        { from: "waiting", reason: REASON },
      ])
  }),
)

it.live("[RM7] T1.5 and T1 carry the blocked cause T1.4 in state budget_exhausted", () =>
  Effect.gen(function* () {
    const { plan, after } = yield* scenario
    const status = TaskStatus.project(plan, after)
    for (const id of DEPENDANTS) {
      expect(engine.blockedBy(after, id)).toEqual(CAUSE)
      expect(status.tasks[id]).toMatchObject({ state: "blocked", blockedBy: CAUSE, reason: REASON })
    }
    // T1.4 itself is dead, not blocked: it has no cause.
    expect(engine.blockedBy(after, "T1.4")).toBeUndefined()
    expect(status.tasks["T1.4"]?.blockedBy).toBeUndefined()
  }),
)

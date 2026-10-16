import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { initialTransition, transition } from "@jambudipa/xstate-effect"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { type Facts, exhaustLeaf, facts, fail, loadPlan, observed, pass, trust, trustLeaf } from "./lib/machine"

// Scenario RM6 (spec task-harness-feedback, spine AD-6, EFX-18; task T1.6): apply is pure and guards its input.
//
//   Given a snapshot of a running release-notes run
//   When a fact that matches no row is applied
//   Then the identical snapshot is returned and the input is not mutated
//   And a fact applied to a snapshot whose run has ended returns that snapshot unchanged
//   And a snapshot made by another machine makes apply die
//
// The plan comes from the real loader (`loadPlan`: `Blend.load` and `TaskCommand.plan`); the snapshots come from the
// engine's `initial` and `apply` (`TaskEngineXState`), the API under test.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

// Everything a reader can see of a snapshot, as text: a mutation of any of it changes the text.
const seen = (snapshot: RunSnapshot) =>
  JSON.stringify({
    status: snapshot.status,
    value: snapshot.value,
    context: snapshot.context,
    tags: [...snapshot.tags].toSorted(),
    nodes: snapshot._nodes.map((node) => node.id),
    children: Object.keys(snapshot.children),
    output: snapshot.output,
    error: snapshot.error === undefined ? undefined : String(snapshot.error),
  })

// A deep freeze of plain data: a write to any part of it throws in this strict module.
const freeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

// The running run: T1.1 to T1.3 trusted, T1.4 building, T1.5 and T1 waiting, the scenarios waiting.
const runningOf = (plan: Plan, f: Facts) =>
  fold(plan, [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    ...trustLeaf(plan, f, "T1.2"),
    ...trustLeaf(plan, f, "T1.3"),
    f.started("T1.4"),
  ])

// One fact of every stored type, for real and unknown ids.
const everyFact = (f: Facts): ReadonlyArray<Fact> => [
  f.runStarted(),
  f.runResumed(),
  f.outside("T9"),
  f.started("T1.4"),
  f.ready("T1.4"),
  f.proved("T1.4", [pass("T1.4.c1")]),
  f.verified("T1.4", [trust("T1.4.c1")]),
  f.stalled("T1.4", "idle"),
  f.nudged("T1.4", 1, "idle without task_ready"),
  f.repeated("T1.4", "read a file 5 times"),
  f.needsHuman("T1.4", "quota"),
  f.failed("T1.4", "merge conflict"),
  f.stale("T1.1.c1"),
  f.checked([{ rule: "R3", path: "T1.task/TASK.md", message: "a fault" }]),
  f.scenarioProved("S1", "passed"),
  f.scenarioVerified(trust("S1")),
  f.cancelled("user stop"),
  f.ended("failed", "wall clock"),
  f.started("T7"),
  f.stale("T7.c1"),
  f.scenarioProved("S99", "passed"),
]

// The defect `apply` dies with: its message (a typed failure or a return fails the test).
const defectOf = (run: () => unknown) => {
  const exit = Effect.runSyncExit(Effect.sync(run))
  if (Exit.isSuccess(exit)) throw new Error("apply returned instead of dying")
  expect(Cause.hasDies(exit.cause)).toBe(true)
  expect(Cause.hasFails(exit.cause)).toBe(false)
  return String(Cause.squash(exit.cause))
}

it.live("[RM6] a fact that matches no row returns the identical snapshot of a running run, unmutated", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // Given a snapshot of a running release-notes run.
    const running = runningOf(plan, f)
    expect(running.status).toBe("active")
    expect(engine.view(running).run.state).toBe("running")
    expect(["T1.1", "T1.2", "T1.3", "T1.4", "T1.5", "T1"].map((id) => engine.unitState(running, id))).toEqual([
      "trusted",
      "trusted",
      "trusted",
      "building",
      "waiting",
      "waiting",
    ])
    expect(engine.unitState(running, "S1")).toBe("waiting")

    // When a fact that matches no row is applied: each has no row in the state its unit is in, or names no unit.
    const noRow: ReadonlyArray<Fact> = [
      f.ready("T1.5"), // a waiting task takes no task.ready
      f.proved("T1.4", [fail("T1.4.c1", "red")]), // a building task takes no proof
      f.verified("T1.4", [trust("T1.4.c1")]), // nor a verdict
      f.started("T1.1"), // a trusted task takes no start
      f.stale("T1.4.c1"), // a pending obligation takes no staleness
      f.outside("T1.4"), // outside.trusted that names a task
      f.scenarioProved("S1", "passed"), // a waiting scenario takes no proof
      f.scenarioVerified(trust("S2")), // nor a verdict
      f.started("T7"), // ids in no plan
      f.stale("T7.c1"),
      f.scenarioProved("S99", "passed"),
      f.outside("T42"),
    ]
    const before = seen(running)
    const history = running.context.log.length
    for (const fact of noRow) {
      const text = JSON.stringify(fact)
      const next = engine.apply(plan, running, fact)
      // Then the identical snapshot is returned and the input is not mutated (nor the fact).
      expect({ fact: text, identical: next === running }).toEqual({ fact: text, identical: true })
      expect(seen(running)).toBe(before)
      expect(running.context.log).toHaveLength(history)
      expect(JSON.stringify(fact)).toBe(text)
    }

    // A fact that does match a row moves the run to a new snapshot, and leaves the input as it was too.
    const moved = engine.apply(plan, running, f.ready("T1.4"))
    expect(moved).not.toBe(running)
    expect(engine.unitState(moved, "T1.4")).toBe("proving")
    expect(seen(running)).toBe(before)
    expect(engine.unitState(running, "T1.4")).toBe("building")

    // With its context and value frozen deep, the input folds every fact type without a write to it, and gives the
    // same snapshots as an unfrozen copy of the same run.
    const g = facts(100)
    const twin = runningOf(plan, facts())
    freeze(running.context)
    freeze(running.value)
    for (const fact of everyFact(g)) {
      const frozen = engine.apply(plan, running, fact)
      const free = engine.apply(plan, twin, fact)
      expect({ fact: fact.type, same: seen(frozen) === seen(free) }).toEqual({ fact: fact.type, same: true })
    }
    expect(seen(running)).toBe(before)
  }),
)

it.live("[RM6] a fact applied to a snapshot whose run has ended returns that snapshot unchanged", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const cascade = yield* loadPlan("example-cascade.spec")
    const f = facts()
    // Runs that ended in each way: a cancel, a stored run.ended done and failed, the observed release-notes run
    // stopped after its death, and a cascade run that settles by itself once every unit is final.
    const ended: ReadonlyArray<readonly [string, Plan, RunSnapshot]> = [
      ["cancelled", plan, fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.cancelled("user stop")])],
      ["run.ended done", plan, fold(plan, [f.runStarted(), f.ended("done")])],
      ["run.ended failed", plan, fold(plan, [f.runStarted(), f.started("T1.1"), f.ended("failed", "wall clock")])],
      ["observed, then a stop", plan, fold(plan, [...observed(plan, f), f.cancelled("user stop")])],
      [
        "cascade, settled",
        cascade,
        fold(cascade, [f.runStarted(), ...exhaustLeaf(f, "T1.1", "T1.1.c1"), ...trustLeaf(cascade, f, "T1.3")]),
      ],
    ]
    expect(ended.map(([name, , snapshot]) => [name, engine.view(snapshot).run.state])).toEqual([
      ["cancelled", "cancelled"],
      ["run.ended done", "done"],
      ["run.ended failed", "failed"],
      ["observed, then a stop", "budget_exhausted"],
      ["cascade, settled", "budget_exhausted"],
    ])
    let raw = 0
    for (const [name, owner, snapshot] of ended) {
      expect({ name, ended: engine.ended(snapshot), status: snapshot.status }).toEqual({
        name,
        ended: true,
        status: "done",
      })
      const machine = TaskMachine.machine(owner)
      const before = seen(snapshot)
      for (const fact of everyFact(facts(1000))) {
        const next = engine.apply(owner, snapshot, fact)
        expect({ name, fact: fact.type, unchanged: next === snapshot }).toEqual({
          name,
          fact: fact.type,
          unchanged: true,
        })
        // Control: the port's own pure transition still runs a step on a done snapshot (AD-6), so this is the
        // engine's guard, not the port's.
        const [stepped] = Effect.runSync(transition(machine, snapshot, fact))
        if (stepped !== snapshot) raw++
      }
      expect(seen(snapshot)).toBe(before)
    }
    expect(raw).toBeGreaterThan(0)
  }),
)

it.live("[RM6] a snapshot made by another machine makes apply die", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const fact = f.runStarted()
    // Another plan's machine.
    const cascade = yield* loadPlan("example-cascade.spec")
    expect(defectOf(() => engine.apply(plan, engine.initial(cascade), fact))).toContain(
      "a snapshot of another plan's machine was applied",
    )
    // The same spec loaded a second time: another plan, so another machine, even with equal content.
    const again = yield* loadPlan("release-notes.spec")
    expect(again).not.toBe(plan)
    expect(TaskMachine.machine(again)).not.toBe(TaskMachine.machine(plan))
    expect(defectOf(() => engine.apply(plan, engine.initial(again), fact))).toContain("another plan's machine")
    // A machine rebuilt from the plan's own config, and a running snapshot of it.
    const rebuilt = TaskMachine.fromConfig(plan, TaskMachine.config(plan))
    const [initial] = Effect.runSync(initialTransition(rebuilt))
    const [first] = Effect.runSync(transition(rebuilt, initial, fact))
    expect(first.status).toBe("active")
    expect(defectOf(() => engine.apply(plan, first, f.started("T1.1")))).toContain("another plan's machine")
    // A snapshot of the plan's own machine, later in a run of another plan, dies as well.
    const running = fold(cascade, [f.runStarted(), ...trustLeaf(cascade, f, "T1.1")])
    expect(defectOf(() => engine.apply(plan, running, f.started("T1.2")))).toContain("another plan's machine")
    // The plan's own snapshot is taken.
    expect(engine.apply(plan, engine.initial(plan), fact).status).toBe("active")
  }),
)

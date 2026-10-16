import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, obligationsOf, pass, trust, trustLeaf, unitState as machineState } from "./lib/machine"

// Scenario RM15 (spec task-harness-feedback, D4, AD-3, T1.3 and T1.7): a task becomes ready only when every after
// task and every child is trusted.
//
//   Given the release-notes plan
//   When T1.1 is trusted and T1.2 is not
//   Then T1.3 is ready and T1.4 is waiting
//   And the parent T1 is waiting until every child is trusted
//   And when a trusted dependency goes stale, a ready dependant returns to waiting
//
// The plan is `release-notes.spec`, loaded by the real loader (`Blend.load`, then `TaskCommand.plan`, through
// `loadPlan`): T1.3 is after T1.1; T1.4 is after T1.2 and T1.3; T1.5 is after T1.3, T1.4 and the outside
// precondition T9; T1 is the parent of T1.1-T1.5. The facts fold through the engine API (`initial`, `apply`).
// "Ready" is the machine state of the task's work region (read from the snapshot value by the test helper) and the
// `<id>:ready` tag that the run supervisor reads to start a task (`RunSupervisor.supervised`); a ready task shows as
// `waiting` in the status file, so "waiting" is checked in the machine, the tags, `waitingOn` and the status file.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

interface Readiness {
  /** The machine state of the task's work region. */
  readonly machine: string
  /** Whether the snapshot tags the task `ready`: what the run supervisor starts a task on. */
  readonly ready: boolean
  /** Whether the run supervisor would supervise the task in this snapshot. */
  readonly started: boolean
  readonly waitingOn: ReadonlyArray<string>
  /** The task as the status file shows it. */
  readonly status: string | undefined
  readonly statusWaitingOn: ReadonlyArray<string> | undefined
}

const readiness = (plan: Plan, snapshot: RunSnapshot, id: string): Readiness => {
  const status = TaskStatus.project(plan, snapshot).tasks[id]
  return {
    machine: machineState(snapshot, id),
    ready: snapshot.hasTag(`${id}:ready`),
    started: id in RunSupervisor.supervised(plan, snapshot),
    waitingOn: engine.waitingOn(snapshot, id),
    status: status?.state,
    statusWaitingOn: status?.waitingOn,
  }
}

const READY: Readiness = {
  machine: "ready",
  ready: true,
  started: true,
  waitingOn: [],
  status: "waiting",
  statusWaitingOn: [],
}

const waitingOn = (...ids: ReadonlyArray<string>): Readiness => ({
  machine: "waiting",
  ready: false,
  started: false,
  waitingOn: ids,
  status: "waiting",
  statusWaitingOn: ids,
})

// The parent's review: proved with no result for its review obligation, then trusted by the reviewer.
const trustParent = (f: ReturnType<typeof facts>): ReadonlyArray<Fact> => [
  f.proved("T1", []),
  f.verified("T1", [trust("T1.e1")]),
]

it.live("[RM15] the release-notes plan orders T1.3 after T1.1, T1.4 after T1.2 and T1.3, under the parent T1", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    expect(plan.tasks.map((task) => [task.id, task.afterEffective, task.children])).toEqual([
      ["T1", [], ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"]],
      ["T1.1", [], []],
      ["T1.2", [], []],
      ["T1.3", ["T1.1"], []],
      ["T1.4", ["T1.2", "T1.3"], []],
      ["T1.5", ["T1.3", "T1.4", "T9"], []],
    ])
    const f = facts()
    // At the start only the two leaves with no after task are ready; every other task waits.
    const started = fold(plan, [f.runStarted()])
    expect(readiness(plan, started, "T1.1")).toEqual(READY)
    expect(readiness(plan, started, "T1.2")).toEqual(READY)
    expect(readiness(plan, started, "T1.3")).toEqual(waitingOn("T1.1"))
    expect(readiness(plan, started, "T1.4")).toEqual(waitingOn("T1.2", "T1.3"))
    expect(readiness(plan, started, "T1")).toEqual(waitingOn("T1.1", "T1.2", "T1.3", "T1.4", "T1.5"))
  }),
)

it.live(
  "[RM15] when T1.1 is trusted and T1.2 is not, T1.3 is ready and T1.4 is waiting, in each state of T1.2 short of trusted",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const started = fold(plan, [f.runStarted()])
      // T1.1 is trusted on its first attempt.
      const trusted = fold(plan, trustLeaf(plan, f, "T1.1"), started)
      expect(machineState(trusted, "T1.1")).toBe("trusted")

      // T1.2 is ready, building, proving, then verifying: never trusted.
      const t12 = [
        ["ready", trusted],
        ["building", engine.apply(plan, trusted, f.started("T1.2"))],
      ] as const
      const proving = engine.apply(plan, t12[1][1], f.ready("T1.2"))
      const verifying = engine.apply(plan, proving, f.proved("T1.2", obligationsOf(plan, "T1.2").map(pass)))
      const cases: ReadonlyArray<readonly [string, RunSnapshot]> = [
        ...t12,
        ["proving", proving],
        ["verifying", verifying],
      ]
      for (const [state, snapshot] of cases) {
        expect([state, machineState(snapshot, "T1.2")]).toEqual([state, state])
        // Then: T1.3 is ready ...
        expect([state, readiness(plan, snapshot, "T1.3")]).toEqual([state, READY])
        // ... and T1.4 is waiting, on T1.2 and on T1.3, which is ready but not trusted.
        expect([state, readiness(plan, snapshot, "T1.4")]).toEqual([state, waitingOn("T1.2", "T1.3")])
        // The parent waits on every child that is not trusted.
        expect([state, readiness(plan, snapshot, "T1")]).toEqual([state, waitingOn("T1.2", "T1.3", "T1.4", "T1.5")])
      }
      // T1.3 became ready in the fold step that made T1.1 trusted, and not before it.
      const beforeVerdict = fold(plan, trustLeaf(plan, f, "T1.1").slice(0, 3), started)
      expect(machineState(beforeVerdict, "T1.1")).toBe("verifying")
      expect(readiness(plan, beforeVerdict, "T1.3")).toEqual(waitingOn("T1.1"))
    }),
)

it.live("[RM15] T1.4 becomes ready only when every after task, T1.2 and T1.3, is trusted", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const t11 = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
    // T1.3 trusted, T1.2 not: T1.4 waits on T1.2 alone.
    const onlyT13 = fold(plan, trustLeaf(plan, f, "T1.3"), t11)
    expect(machineState(onlyT13, "T1.3")).toBe("trusted")
    expect(readiness(plan, onlyT13, "T1.4")).toEqual(waitingOn("T1.2"))
    // T1.2 trusted, T1.3 not: T1.4 waits on T1.3 alone.
    const onlyT12 = fold(plan, trustLeaf(plan, f, "T1.2"), t11)
    expect(machineState(onlyT12, "T1.3")).toBe("ready")
    expect(readiness(plan, onlyT12, "T1.4")).toEqual(waitingOn("T1.3"))
    // Both trusted: T1.4 is ready, in the fold step that trusts the second one.
    const both = fold(plan, trustLeaf(plan, f, "T1.2"), onlyT13)
    expect(readiness(plan, both, "T1.4")).toEqual(READY)
    // T1.5 is after T1.3, T1.4 and the outside T9: with T1.4 trusted and T9 not, it waits on T9 alone.
    const t14 = fold(plan, trustLeaf(plan, f, "T1.4"), both)
    expect(readiness(plan, t14, "T1.5")).toEqual(waitingOn("T9"))
    expect(readiness(plan, engine.apply(plan, t14, f.outside("T9")), "T1.5")).toEqual(READY)
  }),
)

it.live("[RM15] the parent T1 is waiting until every child is trusted, and is ready once the last child is", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    let snapshot = fold(plan, [f.runStarted(), f.outside("T9")])
    const children = ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"]
    for (const [index, child] of children.entries()) {
      // The child in work: started, ready and proved, so it is verifying, one fact short of trusted.
      snapshot = fold(plan, trustLeaf(plan, f, child).slice(0, 3), snapshot)
      expect([child, machineState(snapshot, child)]).toEqual([child, "verifying"])
      expect([child, readiness(plan, snapshot, "T1")]).toEqual([child, waitingOn(...children.slice(index))])
      // The child's verdict makes it trusted.
      snapshot = fold(plan, trustLeaf(plan, f, child).slice(3), snapshot)
      expect([child, machineState(snapshot, child)]).toEqual([child, "trusted"])
      const rest = children.slice(index + 1)
      // T1 stays waiting while any child is not trusted, and is ready in the step that trusts the last child.
      expect([child, readiness(plan, snapshot, "T1")]).toEqual([child, rest.length > 0 ? waitingOn(...rest) : READY])
    }
    // The ready parent is started by its review proof and ends trusted.
    const reviewed = fold(plan, trustParent(f), snapshot)
    expect(machineState(reviewed, "T1")).toBe("trusted")
  }),
)

it.live("[RM15] when a trusted dependency goes stale, a ready dependant returns to waiting", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const t11 = fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1")])
    expect(readiness(plan, t11, "T1.3")).toEqual(READY)

    // T1.1's first obligation goes stale: T1.1 reopens to prove again, and T1.3 returns to waiting on it in the same
    // fold step; the run supervisor no longer starts it.
    const obligation = obligationsOf(plan, "T1.1")[0] ?? ""
    expect(obligation).toBe("T1.1.c1")
    const stale = engine.apply(plan, t11, f.stale(obligation))
    expect(machineState(stale, "T1.1")).toBe("proving")
    expect(TaskStatus.project(plan, stale).obligations[obligation]?.state).toBe("stale")
    expect(readiness(plan, stale, "T1.3")).toEqual(waitingOn("T1.1"))

    // T1.1 proved and verified again: T1.3 is ready again.
    const again = fold(
      plan,
      [f.proved("T1.1", obligationsOf(plan, "T1.1").map(pass)), f.verified("T1.1", [trust(obligation)])],
      stale,
    )
    expect(machineState(again, "T1.1")).toBe("trusted")
    expect(readiness(plan, again, "T1.3")).toEqual(READY)

    // The parent too: once every child is trusted T1 is ready; a stale obligation of T1.5 sends it back to waiting.
    const children = fold(
      plan,
      [
        f.outside("T9"),
        ...trustLeaf(plan, f, "T1.2"),
        ...trustLeaf(plan, f, "T1.3"),
        ...trustLeaf(plan, f, "T1.4"),
        ...trustLeaf(plan, f, "T1.5"),
      ],
      again,
    )
    expect(readiness(plan, children, "T1")).toEqual(READY)
    const last = obligationsOf(plan, "T1.5")[0] ?? ""
    expect(last).toBe("T1.5.c1")
    const reopened = engine.apply(plan, children, f.stale(last))
    expect(machineState(reopened, "T1.5")).toBe("proving")
    expect(readiness(plan, reopened, "T1")).toEqual(waitingOn("T1.5"))
  }),
)

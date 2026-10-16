import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, outcome, trust, trustLeaf, unitState as machineState } from "./lib/machine"

// Scenario RM17 (spec task-harness-feedback, D4, AD-3, T1.3, T1.7 and T1.11): a task waiting on an untrusted outside
// precondition stays waiting and moves on its trust.
//
//   Given the release-notes plan with T1.1 to T1.4 trusted, every scenario whose needs are trusted also trusted, and
//     T9 untrusted
//   When the snapshot is read
//   Then T1.5 is waiting, its waitingOn names T9, and the run is waiting, not ended
//   And when outside.trusted for T9 is applied, T1.5 becomes ready
//   And a second trust of T9 changes nothing
//
// The plan is `release-notes.spec`, loaded by the real loader (`Blend.load`, then `TaskCommand.plan`, through
// `loadPlan`): T1.5 is after T1.3, T1.4 and the outside precondition T9; S5 needs T1.5; S13 needs T1.4 and the
// outside precondition T8; S1-S4 and S6-S12 need only T1.1-T1.4. The facts fold through the engine API (`initial`,
// `apply`). The snapshot is read through the engine selectors, the status file (`TaskStatus.project`), the machine
// state of each region (test helpers `unitState` and `outcome`) and the run supervisor's reads (`supervised`,
// `untrustedOutside`).

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const TASKS = ["T1.1", "T1.2", "T1.3", "T1.4"]

// The scenarios whose needs are all among T1.1-T1.4: every other scenario needs T1.5 or the outside T8.
const trustedNeeds = (plan: Plan) =>
  plan.scenarios
    .filter((scenario) => scenario.needs.every((need) => TASKS.includes(need)))
    .map((scenario) => scenario.id)

const RUNNABLE = ["S1", "S2", "S3", "S4", "S6", "S7", "S8", "S9", "S10", "S11", "S12"]

// The Given: T1.1-T1.4 trusted, then every scenario whose needs are trusted proved and trusted. T9 and T8 untrusted.
const given = (plan: Plan, f: ReturnType<typeof facts>) =>
  fold(plan, [
    f.runStarted(),
    ...TASKS.flatMap((task) => trustLeaf(plan, f, task)),
    ...RUNNABLE.map((id) => f.scenarioProved(id, "passed")),
    ...RUNNABLE.map((id) => f.scenarioVerified(trust(id))),
  ])

it.live(
  "[RM17] with T1.1-T1.4 trusted, every scenario whose needs are trusted trusted, and T9 untrusted, T1.5 is waiting on T9 and the run is waiting, not ended",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      expect(plan.tasks.find((task) => task.id === "T1.5")?.afterEffective).toEqual(["T1.3", "T1.4", "T9"])
      expect(Object.keys(plan.spec.outside).toSorted()).toEqual(["T8", "T9"])
      expect(trustedNeeds(plan)).toEqual(RUNNABLE)
      const f = facts()
      const snapshot = given(plan, f)
      const status = TaskStatus.project(plan, snapshot)

      // The Given holds: T1.1-T1.4 trusted, each runnable scenario trusted, T9 untrusted.
      expect(TASKS.map((id) => status.tasks[id]?.state)).toEqual(TASKS.map(() => "trusted"))
      expect(RUNNABLE.map((id) => status.scenarios[id]?.state)).toEqual(RUNNABLE.map(() => "trusted"))
      expect(status.outside["T9"]).toEqual({ state: "untrusted", tags: ["waiting"] })
      expect(machineState(snapshot, "T9")).toBe("untrusted")

      // Then: T1.5 is waiting, and its waitingOn names T9, in the engine and in the status file.
      expect(machineState(snapshot, "T1.5")).toBe("waiting")
      expect(snapshot.hasTag("T1.5:ready")).toBe(false)
      expect(engine.unitState(snapshot, "T1.5")).toBe("waiting")
      expect(engine.tags(snapshot, "T1.5")).toEqual(["waiting"])
      expect(engine.waitingOn(snapshot, "T1.5")).toEqual(["T9"])
      expect(status.tasks["T1.5"]).toMatchObject({ state: "waiting", waitingOn: ["T9"], waitingOnOutside: ["T9"] })
      // The units that wait behind it wait too: T1 on T1.5, S5 on T1.5; S13 is parked on T8.
      expect(engine.waitingOn(snapshot, "T1")).toEqual(["T1.5"])
      expect(engine.waitingOn(snapshot, "S5")).toEqual(["T1.5"])
      expect(machineState(snapshot, "S13")).toBe("parked")

      // And the run is waiting, not ended: nothing is ready or in work, and the machine is still active.
      expect(outcome(snapshot)).toBe("waiting")
      expect(snapshot.status).toBe("active")
      expect(engine.ended(snapshot)).toBe(false)
      expect(status.run.state).toBe("waiting")
      expect(status.run.tags).toEqual(["waiting"])
      expect(status.run.reason).toBeUndefined()
      expect(RunSupervisor.supervised(plan, snapshot)).toEqual({})
      // The run supervisor reads from the snapshot that T9 is an untrusted outside precondition it may record a trust of.
      expect(RunSupervisor.untrustedOutside(plan, snapshot, "T9")).toBe(true)
    }),
)

it.live(
  "[RM17] when outside.trusted for T9 is applied T1.5 becomes ready, and a second trust of T9 changes nothing",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const waiting = given(plan, f)
      expect(machineState(waiting, "T1.5")).toBe("waiting")

      // When: outside.trusted for T9 is applied. Then: T1.5 becomes ready in the returned snapshot.
      const trusted = engine.apply(plan, waiting, f.outside("T9"))
      expect(machineState(trusted, "T9")).toBe("trusted")
      expect(TaskStatus.project(plan, trusted).outside["T9"]).toEqual({ state: "trusted", tags: ["ended"] })
      expect(machineState(trusted, "T1.5")).toBe("ready")
      expect(trusted.hasTag("T1.5:ready")).toBe(true)
      expect(engine.waitingOn(trusted, "T1.5")).toEqual([])
      expect(TaskStatus.project(plan, trusted).tasks["T1.5"]).toMatchObject({
        state: "waiting",
        waitingOn: [],
        waitingOnOutside: [],
      })
      // The run is running again, and the run supervisor starts T1.5.
      expect(outcome(trusted)).toBe("running")
      expect(TaskStatus.project(plan, trusted).run.state).toBe("running")
      expect(RunSupervisor.supervised(plan, trusted)).toEqual({ "T1.5": "task" })
      expect(RunSupervisor.untrustedOutside(plan, trusted, "T9")).toBe(false)
      // The trust is logged once, as a move of T9 to trusted.
      const logged = trusted.context.log.slice(waiting.context.log.length)
      expect(logged.map((entry) => [entry.unit, entry.to])).toEqual([["T9", "trusted"]])

      // And: a second trust of T9 changes nothing; `apply` returns the identical snapshot.
      const again = engine.apply(plan, trusted, f.outside("T9"))
      expect(again).toBe(trusted)
      expect(again.context.log).toHaveLength(trusted.context.log.length)
      expect(machineState(again, "T1.5")).toBe("ready")
    }),
)

it.live("[RM17] a trust of T9 while T1.3 or T1.4 is not trusted leaves T1.5 waiting on that task alone", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // T9 trusted first, with T1.4 still in work: T1.5 waits on T1.4 only, then becomes ready when T1.4 is trusted.
    const early = fold(plan, [
      f.runStarted(),
      f.outside("T9"),
      ...trustLeaf(plan, f, "T1.1"),
      ...trustLeaf(plan, f, "T1.2"),
      ...trustLeaf(plan, f, "T1.3"),
      f.started("T1.4"),
    ])
    expect(machineState(early, "T9")).toBe("trusted")
    expect(machineState(early, "T1.5")).toBe("waiting")
    expect(engine.waitingOn(early, "T1.5")).toEqual(["T1.4"])
    const done = fold(plan, trustLeaf(plan, f, "T1.4").slice(1), early)
    expect(machineState(done, "T1.4")).toBe("trusted")
    expect(machineState(done, "T1.5")).toBe("ready")
  }),
)

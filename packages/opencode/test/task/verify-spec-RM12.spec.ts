import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, reject, trust, trustLeaf } from "./lib/machine"

// Scenario RM12 (spec task-harness-feedback, owner ruling 1, D3, SD-18 rule 3, T1.4): a rejected runnable scenario
// fails a run whose tasks are all trusted.
//
//   Given a run where every task is trusted
//   When a runnable scenario is rejected by its verifier
//   Then the run outcome is failed
//   And the run reason has the line "acceptance not proved: <scenario id> rejected"
//
// The plan is the live-check folder `example-scenarios.spec`, loaded by the real loader (`Blend.load`, then
// `TaskCommand.plan`, through `loadPlan`): the parent T1 with its review obligation e1, the leaf T1.1, and scenario
// S1 that needs T1.1. The facts fold through the engine API (`initial`, `apply`); the run is read through the
// status projection (`TaskStatus.project`, the status file), `view`, `ended` and the run supervisor's choices.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const REJECTED = "the [S1] test checks only that a string comes back"

// Every task of the plan trusted: the leaf T1.1, then the review of the parent T1.
const allTasksTrusted = (plan: Plan, f: ReturnType<typeof facts>) =>
  fold(plan, [f.runStarted(), ...trustLeaf(plan, f, "T1.1"), f.proved("T1", []), f.verified("T1", [trust("T1.e1")])])

const taskStates = (plan: Plan, snapshot: RunSnapshot) =>
  Object.fromEntries(Object.entries(TaskStatus.project(plan, snapshot).tasks).map(([id, task]) => [id, task.state]))

it.live(
  "[RM12] owner ruling 1: every task trusted and the runnable scenario S1 rejected by its verifier gives the outcome failed with the line 'acceptance not proved: S1 rejected'",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-scenarios.spec")
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1"])
      expect(plan.scenarios.map((scenario) => [scenario.id, scenario.needs])).toEqual([["S1", ["T1.1"]]])
      const f = facts()

      // Given: every task is trusted. S1 needs only T1.1, so it is runnable: the next scenario batch holds it.
      const trusted = allTasksTrusted(plan, f)
      expect(taskStates(plan, trusted)).toEqual({ T1: "trusted", "T1.1": "trusted" })
      expect(RunSupervisor.readyScenarios(plan, trusted)).toEqual(["S1"])
      expect(TaskStatus.project(plan, trusted).scenarios["S1"]?.state).toBe("pending")
      // The run has not settled: the trusted tasks alone do not end it while S1 is still to run.
      expect(engine.ended(trusted)).toBe(false)
      expect(TaskStatus.project(plan, trusted).run.state).toBe("running")

      // When: S1 is proved, and its verifier rejects it.
      const verifying = engine.apply(plan, trusted, f.scenarioProved("S1", "passed"))
      expect(RunSupervisor.supervised(plan, verifying)).toEqual({ S1: "scenario" })
      expect(engine.ended(verifying)).toBe(false)
      const rejected = engine.apply(plan, verifying, f.scenarioVerified(reject("S1", REJECTED)))
      const status = TaskStatus.project(plan, rejected)
      expect(status.scenarios["S1"]?.state).toBe("rejected")
      expect(status.scenarios["S1"]?.reason).toBe(REJECTED)
      // No task died: every task stays trusted.
      expect(taskStates(plan, rejected)).toEqual({ T1: "trusted", "T1.1": "trusted" })

      // Then: the run outcome is failed.
      expect(engine.ended(rejected)).toBe(true)
      expect(status.run.state).toBe("failed")
      expect(engine.view(rejected).run.state).toBe("failed")
      expect(status.run.tags).toEqual(["ended", "stopped"])

      // And: the reason has the line "acceptance not proved: S1 rejected".
      const lines = (status.run.reason ?? "").split("\n")
      expect(lines).toContain("acceptance not proved: S1 rejected")
      expect(lines).toEqual(["acceptance not proved: S1 rejected"])
      // The outcome entry of the run closes the history, after the entry that rejected S1.
      const log = rejected.context.log
      expect(log.at(-1)).toMatchObject({ unit: "run", to: "failed", reason: "acceptance not proved: S1 rejected" })
      expect(log.findIndex((entry) => entry.unit === "S1" && entry.to === "rejected")).toBe(log.length - 2)
    }),
)

it.live("[RM12] owner ruling 1 control: the same run with S1 trusted by its verifier ends done with no reason", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("example-scenarios.spec")
    const f = facts()
    const trusted = allTasksTrusted(plan, f)
    const done = fold(plan, [f.scenarioProved("S1", "passed"), f.scenarioVerified(trust("S1"))], trusted)
    const status = TaskStatus.project(plan, done)
    expect(status.scenarios["S1"]?.state).toBe("trusted")
    expect(engine.ended(done)).toBe(true)
    expect(status.run.state).toBe("done")
    expect(status.run.reason).toBeUndefined()
  }),
)

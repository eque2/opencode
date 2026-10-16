import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, unitState as machineState, trust, trustLeaf } from "./lib/machine"

// Scenario RM13 (spec task-harness-feedback, owner ruling 1, D3, D4, AD-3, SD-18 rule 4, T1.3 and T1.4): a scenario
// that waits only on an outside precondition is parked and does not fail the run.
//
//   Given the release-notes plan with T9 trusted and T8 untrusted
//   When every task is trusted and every runnable scenario is trusted
//   Then S13 is parked and shows as waiting
//   And the run outcome is done with the reason line "not run: S13 waits on T8"
//   And when T8 is trusted before the run settles, S13 moves from parked to ready
//
// The plan is `release-notes.spec`, loaded by the real loader (`Blend.load`, then `TaskCommand.plan`, through
// `loadPlan`): S13 needs T1.4 and the outside precondition T8; T1.5 needs T9; S1-S12 need tasks only. The facts fold
// through the engine API (`initial`, `apply`). "Parked" is the machine state of S13's region (read from the snapshot
// value by the test helper); "shows as waiting" is the status file (`TaskStatus.project`) and the engine selectors.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const RUNNABLE = Array.from({ length: 12 }, (_, index) => `S${index + 1}`)

// The scenarios whose needs are all tasks of the plan: the ones that can run without an outside precondition.
const runnableOf = (plan: Plan) =>
  plan.scenarios
    .filter((scenario) => scenario.needs.every((need) => plan.tasks.some((task) => task.id === need)))
    .map((scenario) => scenario.id)

// Every task of the release-notes plan trusted, with T9 trusted first: the leaves, then T1's review.
const everyTaskTrusted = (plan: Plan, f: ReturnType<typeof facts>, from: RunSnapshot) =>
  fold(
    plan,
    [
      ...trustLeaf(plan, f, "T1.1"),
      ...trustLeaf(plan, f, "T1.2"),
      ...trustLeaf(plan, f, "T1.3"),
      ...trustLeaf(plan, f, "T1.4"),
      ...trustLeaf(plan, f, "T1.5"),
      f.proved("T1", []),
      f.verified("T1", [trust("T1.e1")]),
    ],
    from,
  )

// The scenario batch: each scenario proved, then each one trusted by its verifier.
const proveAndTrust = (f: ReturnType<typeof facts>, ids: ReadonlyArray<string>): ReadonlyArray<Fact> => [
  ...ids.map((id) => f.scenarioProved(id, "passed")),
  ...ids.map((id) => f.scenarioVerified(trust(id))),
]

interface ScenarioView {
  readonly state: string | undefined
  readonly tags: ReadonlyArray<string> | undefined
  readonly waitingOn: ReadonlyArray<string> | undefined
  readonly waitingOnOutside: ReadonlyArray<string> | undefined
}

// S13 as the status file shows it.
const s13Status = (plan: Plan, snapshot: RunSnapshot): ScenarioView => {
  const s13 = TaskStatus.project(plan, snapshot).scenarios["S13"]
  return { state: s13?.state, tags: s13?.tags, waitingOn: s13?.waitingOn, waitingOnOutside: s13?.waitingOnOutside }
}

const PARKED_SHOWS = { state: "waiting", tags: ["waiting"], waitingOn: ["T8"], waitingOnOutside: ["T8"] }

it.live(
  "[RM13] owner ruling 1: with T9 trusted and T8 untrusted, S13 is parked and shows as waiting, and the run ends done with 'not run: S13 waits on T8'",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      expect(plan.scenarios.find((scenario) => scenario.id === "S13")?.needs).toEqual(["T1.4", "T8"])
      expect(runnableOf(plan)).toEqual(RUNNABLE)
      const f = facts()

      // Given: T9 is trusted and T8 is not.
      const given = fold(plan, [f.runStarted(), f.outside("T9")])
      expect(TaskStatus.project(plan, given).outside).toEqual({
        T8: { state: "untrusted", tags: ["waiting"] },
        T9: { state: "trusted", tags: ["ended"] },
      })
      // S13 waits on its task T1.4 as well, so it is not parked yet.
      expect(machineState(given, "S13")).toBe("waiting")

      // When: every task is trusted ...
      const tasks = everyTaskTrusted(plan, f, given)
      expect(Object.values(TaskStatus.project(plan, tasks).tasks).every((task) => task.state === "trusted")).toBe(true)
      expect(Object.keys(TaskStatus.project(plan, tasks).tasks)).toEqual(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
      // ... so S13 is parked: its only untrusted need is the outside precondition T8. The batch leaves it out.
      expect(machineState(tasks, "S13")).toBe("parked")
      expect(s13Status(plan, tasks)).toEqual(PARKED_SHOWS)
      expect(RunSupervisor.readyScenarios(plan, tasks)).toEqual(RUNNABLE)

      // ... and every runnable scenario is trusted.
      const done = fold(plan, proveAndTrust(f, RUNNABLE), tasks)
      const status = TaskStatus.project(plan, done)
      expect(RUNNABLE.map((id) => status.scenarios[id]?.state)).toEqual(RUNNABLE.map(() => "trusted"))

      // Then: S13 is parked and shows as waiting.
      expect(machineState(done, "S13")).toBe("parked")
      expect(s13Status(plan, done)).toEqual(PARKED_SHOWS)
      expect(engine.unitState(done, "S13")).toBe("waiting")
      expect(engine.view(done).scenarios["S13"]?.state).toBe("waiting")
      expect(engine.waitingOn(done, "S13")).toEqual(["T8"])

      // And: the run outcome is done, with the reason line "not run: S13 waits on T8".
      expect(engine.ended(done)).toBe(true)
      expect(status.run.state).toBe("done")
      expect(status.run.tags).toEqual(["ended"])
      expect((status.run.reason ?? "").split("\n")).toEqual(["not run: S13 waits on T8"])
      // A trust of T8 after the run settled changes nothing: S13 stays parked.
      expect(engine.apply(plan, done, f.outside("T8"))).toBe(done)
    }),
)

it.live("[RM13] owner ruling 1: when T8 is trusted before the run settles, S13 moves from parked to ready", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const tasks = everyTaskTrusted(plan, f, fold(plan, [f.runStarted(), f.outside("T9")]))
    // Every runnable scenario proved, and every verdict but the one for S12: S12 is still under its verifier, so the
    // run has not settled.
    const almost = fold(
      plan,
      [
        ...RUNNABLE.map((id) => f.scenarioProved(id, "passed")),
        ...RUNNABLE.slice(0, -1).map((id) => f.scenarioVerified(trust(id))),
      ],
      tasks,
    )
    expect(machineState(almost, "S12")).toBe("verifying")
    expect(machineState(almost, "S13")).toBe("parked")
    expect(engine.ended(almost)).toBe(false)

    // T8 is trusted before the run settles: S13 moves from parked to ready in that one fold step.
    const trusted = engine.apply(plan, almost, f.outside("T8"))
    expect(TaskStatus.project(plan, trusted).outside["T8"]?.state).toBe("trusted")
    expect(machineState(trusted, "S13")).toBe("ready")
    expect(TaskStatus.project(plan, trusted).scenarios["S13"]?.state).toBe("pending")
    expect(RunSupervisor.readyScenarios(plan, trusted)).toEqual(["S13"])
    expect(engine.waitingOn(trusted, "S13")).toEqual([])

    // S13 is runnable now: the last verdict of the batch does not settle the run, and S13 runs to its end.
    const waiting = engine.apply(plan, trusted, f.scenarioVerified(trust("S12")))
    expect(TaskStatus.project(plan, waiting).scenarios["S12"]?.state).toBe("trusted")
    expect(engine.ended(waiting)).toBe(false)
    const done = fold(plan, proveAndTrust(f, ["S13"]), waiting)
    const status = TaskStatus.project(plan, done)
    expect(status.scenarios["S13"]?.state).toBe("trusted")
    expect(engine.ended(done)).toBe(true)
    expect(status.run.state).toBe("done")
    expect(status.run.reason).toBeUndefined()
  }),
)

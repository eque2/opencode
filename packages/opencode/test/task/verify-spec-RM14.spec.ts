import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Option } from "effect"
import type { Fact, Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { RunSupervisor } from "@/task/core/supervise/run"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, fail, loadPlan, obligationsOf, pass, trustLeaf } from "./lib/machine"

// Scenario RM14 (spec task-harness-feedback, default 4, D3, AD-4, SD-18 rule 2, defect 12, T1.4): a cancel moves
// every unfinished unit to cancelled and keeps the finished ones.
//
//   Given a run with a trusted task, a building task, a ready task and a waiting task
//   When the run is cancelled with a reason
//   Then the building, ready and waiting tasks are cancelled with that reason
//   And the trusted task stays trusted, and every obligation keeps its state and ends with its task
//   And the run outcome is cancelled with that reason, because no task died before the stop
//   And a run wall-clock stop gives the run.ended state as the outcome in the same way
//
// The plan is `release-notes.spec`, loaded by the real loader (`Blend.load`, then `TaskCommand.plan`, through
// `loadPlan`). T1.1 is trusted; T1.2 is building again after one failing proof, so its obligations hold a failed and
// trusted states; T1.3 (after T1.1) is ready; T1.4 (after T1.2 and T1.3) is waiting. The facts fold through the
// engine API (`initial`, `apply`); units and the run are read through the status projection (`TaskStatus.project`,
// the status file), the history and the run supervisor's tag reader. The wall-clock stop is the fact that the run
// supervisor records when the run wall clock runs out: `run.ended { state: "failed", reason: "wall clock: ..." }`.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const fold = (plan: Plan, list: ReadonlyArray<Fact>, from: RunSnapshot = engine.initial(plan)) =>
  list.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), from)

const USER_STOP = "user stop: ctrl+x w"
const WALL_CLOCK = "wall clock: the run took over 30 min"

// T1.1 trusted, T1.2 building its second attempt, T1.3 ready, T1.4 waiting.
const goingRun = (plan: Plan, f: ReturnType<typeof facts>) => {
  const [first, ...rest] = obligationsOf(plan, "T1.2")
  if (first === undefined) throw new Error("T1.2 has no obligation")
  return fold(plan, [
    f.runStarted(),
    ...trustLeaf(plan, f, "T1.1"),
    f.started("T1.2"),
    f.ready("T1.2"),
    f.proved("T1.2", [fail(first, "the bump ignores a breaking change"), ...rest.map(pass)]),
  ])
}

// The given run, as the status file and the run supervisor's tag reader show it.
const checkGiven = (plan: Plan, going: RunSnapshot) => {
  const tasks = TaskStatus.project(plan, going).tasks
  expect(tasks["T1.1"]?.state).toBe("trusted")
  expect(tasks["T1.2"]?.state).toBe("building")
  expect(tasks["T1.2"]?.attempts).toBe(2)
  expect(RunSupervisor.tagsOf(going, "T1.1")).toEqual(["ended"])
  expect(RunSupervisor.tagsOf(going, "T1.2")).toEqual(["active", "building"])
  expect(RunSupervisor.tagsOf(going, "T1.3")).toEqual(["waiting", "ready"])
  expect(RunSupervisor.tagsOf(going, "T1.4")).toEqual(["waiting"])
  expect(engine.waitingOn(going, "T1.4")).toEqual(["T1.2", "T1.3"])
  // The obligations of T1.2 hold more than one state: c1 failed, the others trusted.
  const obligations = TaskStatus.project(plan, going).obligations
  expect(obligationsOf(plan, "T1.2").map((id) => obligations[id]?.state)).toEqual([
    "failed",
    "trusted",
    "trusted",
    "trusted",
  ])
  // No task has died.
  expect(Object.values(tasks).filter((task) => task.tags.includes("dead"))).toEqual([])
  expect(engine.ended(going)).toBe(false)
}

// The effect of a stop on the units: every unfinished task and scenario cancelled with the stop's reason, the trusted
// task kept, and every obligation kept in its state, with no entry of its own, ending with its task.
const checkStop = (plan: Plan, going: RunSnapshot, stopped: RunSnapshot, reason: string) => {
  const before = TaskStatus.project(plan, going)
  const after = TaskStatus.project(plan, stopped)
  const unfinished = Object.entries(before.tasks)
    .filter(([, task]) => !task.tags.includes("ended"))
    .map(([id]) => id)
  expect(unfinished).toEqual(["T1", "T1.2", "T1.3", "T1.4", "T1.5"])
  // The building, ready and waiting tasks (and the other waiting ones) are cancelled with that reason.
  for (const id of unfinished) {
    expect(after.tasks[id]?.state).toBe("cancelled")
    expect(after.tasks[id]?.reason).toBe(reason)
    expect(after.tasks[id]?.tags).toEqual(["ended", "stopped"])
  }
  const added = stopped.context.log.slice(going.context.log.length)
  expect(added.filter((entry) => entry.unit === "T1.2")).toEqual([
    expect.objectContaining({ from: "building", to: "cancelled", reason }),
  ])
  expect(added.filter((entry) => entry.unit === "T1.3")).toEqual([
    expect.objectContaining({ from: "waiting", to: "cancelled", reason }),
  ])
  expect(added.filter((entry) => entry.unit === "T1.4")).toEqual([
    expect.objectContaining({ from: "waiting", to: "cancelled", reason }),
  ])
  // The unfinished scenarios end too, with the same reason.
  for (const [id, scenario] of Object.entries(after.scenarios)) {
    expect([id, scenario.state, scenario.reason]).toEqual([id, "cancelled", reason])
  }
  // The trusted task stays trusted, with no new entry.
  expect(after.tasks["T1.1"]).toEqual(before.tasks["T1.1"])
  expect(added.filter((entry) => entry.unit === "T1.1")).toEqual([])
  // Every obligation keeps its state (and its reason and times), and the stop writes no obligation entry.
  expect(after.obligations).toEqual(before.obligations)
  const obligationIds = Object.keys(after.obligations)
  expect(added.filter((entry) => obligationIds.includes(entry.unit))).toEqual([])
  // Every obligation ends with its task: each task is in an ended state, and the run machine is final.
  for (const obligation of plan.spec.obligations.filter((each) => obligationIds.includes(each.id)))
    expect(after.tasks[obligation.task]?.tags).toContain("ended")
  expect(engine.ended(stopped)).toBe(true)
}

it.live(
  "[RM14] default 4: a cancel with a reason cancels the building, ready and waiting tasks, keeps the trusted task and every obligation, and ends the run cancelled with that reason",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      // Given: a trusted task, a building task, a ready task and a waiting task.
      const going = goingRun(plan, f)
      checkGiven(plan, going)

      // When: the run is cancelled with a reason.
      const cancelled = engine.apply(plan, going, f.cancelled(USER_STOP))

      // Then / And: the units.
      checkStop(plan, going, cancelled, USER_STOP)

      // And: the run outcome is cancelled with that reason, because no task died before the stop.
      const run = TaskStatus.project(plan, cancelled).run
      expect(run.state).toBe("cancelled")
      expect(run.reason).toBe(USER_STOP)
      expect(run.tags).toEqual(["ended", "stopped"])
      expect(Option.getOrUndefined(engine.stopOf(cancelled))).toEqual({ state: "cancelled", reason: USER_STOP })
    }),
)

it.live("[RM14] default 4: a cancel after a task died gives the dead task's state, not cancelled", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // The same run, but T1.2 needs a human before the stop: a task died first.
    const died = engine.apply(plan, goingRun(plan, f), f.needsHuman("T1.2", "spend cap: $5.00 reached"))
    expect(engine.ended(died)).toBe(false)
    const cancelled = engine.apply(plan, died, f.cancelled(USER_STOP))
    const run = TaskStatus.project(plan, cancelled).run
    expect(engine.ended(cancelled)).toBe(true)
    expect(run.state).toBe("needs_human")
    const lines = (run.reason ?? "").split("\n")
    expect(lines[0]).toBe("T1.2 needs human")
    expect(lines.at(-1)).toBe(USER_STOP)
  }),
)

it.live(
  "[RM14] default 4: a run wall-clock stop cancels the unfinished units in the same way and gives the run.ended state, failed, as the outcome",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const f = facts()
      const going = goingRun(plan, f)
      checkGiven(plan, going)

      // The run wall clock runs out: the run supervisor records run.ended in state failed with its reason.
      const ended = engine.apply(plan, going, f.ended("failed", WALL_CLOCK))
      checkStop(plan, going, ended, WALL_CLOCK)

      const run = TaskStatus.project(plan, ended).run
      expect(run.state).toBe("failed")
      expect(run.reason).toBe(WALL_CLOCK)
      expect(run.tags).toEqual(["ended", "stopped"])
      expect(Option.getOrUndefined(engine.stopOf(ended))).toEqual({ state: "failed", reason: WALL_CLOCK })
    }),
)

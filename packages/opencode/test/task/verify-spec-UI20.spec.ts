import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { Fact, Plan } from "@/task/core/model"
import { TaskWorkers } from "@/task/core/workers"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { facts, loadPlan, obligationsOf, observed, reject, trust, trustLeaf, unitState } from "./lib/machine"
import { runOf } from "./lib/supervise"

// Scenario UI20 (spec task-harness-feedback, owner ruling 1, AC 4, SD-18, D18; task T4.11): the summary's outcome line
// follows the outcome rules.
//
//   Given final statuses for a cancel with no dead task, a cancel after a dead task, a dead task, a rejected scenario
//     with every task trusted, a done run with one parked scenario, and a subtree run
//   When each summary is built
//   Then the outcome lines read "— cancelled: <first reason line>", "— budget exhausted", "— budget exhausted",
//     "— failed: acceptance not proved" and "— done · 1 scenario not run"
//   And the subtree summary starts with the task id and title, then "from spec" and the spec title
//   And a spec that stopped validating and then validated again still gives the run-warning line
//
// No status is written by hand. Each Given is a list of facts of the release-notes spec; the real Recorder restores
// the run actor from them (the final status is the real fold of the run machine), and the summary is built by the
// worker the run supervisor invokes, `TaskWorkers.summary`: the actor's snapshot, `TaskStatus.project`, the stop the
// run took (`stopOf`), whether the spec stopped validating (`warned`), and `TaskSummary.markdown`. Its `say` is
// replaced only to read the text it says in the root session.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))

const SPEC_TITLE = "**Release notes from conventional commits**"
const WARNING = "The spec stopped validating during the run. The run kept the plan it loaded."
const SCENARIOS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13"]

// The summary the worker says for a run restored from `stored`, and the run actor's final snapshot.
const summaryOf = (plan: Plan, stored: ReadonlyArray<Fact>) =>
  Effect.gen(function* () {
    const setup = yield* runOf({ plan, directory: "/root", stored })
    const said: Array<{ sessionID: string; text: string }> = []
    Object.assign(setup.run.env.ops, {
      say: (input: { sessionID: string; text: string }) => Effect.sync(() => void said.push(input)),
    })
    const snapshot = yield* setup.recorder.actor.getSnapshot
    yield* TaskWorkers.summary(setup.run)
    expect(said).toHaveLength(1)
    expect(said[0]?.sessionID).toBe(setup.run.root)
    return { snapshot, lines: (said[0]?.text ?? "").split("\n") }
  })

// Every task trusted, in plan order; the parent T1 after its review. T9 (and T8 when `t8`) are trusted outside.
const allTrusted = (plan: Plan, f: ReturnType<typeof facts>, t8: boolean): ReadonlyArray<Fact> => [
  f.runStarted(),
  ...(t8 ? [f.outside("T8")] : []),
  f.outside("T9"),
  ...["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].flatMap((task) => trustLeaf(plan, f, task)),
  f.proved("T1", []),
  f.verified("T1", obligationsOf(plan, "T1").map(trust)),
]

const scenarioTrusted = (f: ReturnType<typeof facts>, id: string): ReadonlyArray<Fact> => [
  f.scenarioProved(id, "passed"),
  f.scenarioVerified({ id, verdict: "trusted" }),
]

it.live("[UI20] a cancel with no dead task: the outcome line is the stop and its first reason line", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // Given T1.1 trusted, T1.2 building, then the user's cancel with a two-line reason.
    const { snapshot, lines } = yield* summaryOf(plan, [
      f.runStarted(),
      ...trustLeaf(plan, f, "T1.1"),
      f.started("T1.2"),
      f.cancelled("user stop\nsecond line"),
    ])
    expect(snapshot.status).toBe("done")
    expect(TaskEngineXState.view(snapshot).run.state).toBe("cancelled")
    expect(["T1.1", "T1.2"].map((task) => unitState(snapshot, task))).toEqual(["trusted", "cancelled"])
    // Then the outcome line reads "— cancelled: <first reason line>".
    expect(lines[0]).toBe(`Spec ${SPEC_TITLE} — cancelled: user stop`)
  }),
)

it.live("[UI20] a cancel after a dead task, and a dead task: the outcome line is the dead task's state", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    // Given the observed run: T1.1 to T1.3 trusted, T1.4 budget exhausted after three failed proofs (T1 and T1.5
    // blocked), and the scenarios that need only T1.1 to T1.3 still to prove.
    const before = facts()
    const dead = observed(plan, before)
    // A cancel after the dead task.
    const cancelled = yield* summaryOf(plan, [...dead, before.cancelled("user stop")])
    expect(cancelled.snapshot.status).toBe("done")
    expect(Option.isSome(TaskEngineXState.stopOf(cancelled.snapshot))).toBe(true)
    expect(unitState(cancelled.snapshot, "T1.4")).toBe("budget_exhausted")
    expect(cancelled.lines[0]).toBe(`Spec ${SPEC_TITLE} — budget exhausted`)

    // A dead task, with no stop: the scenarios T1.4 does not block are trusted, so the run ends by itself.
    const f = facts()
    const ended = yield* summaryOf(plan, [
      ...observed(plan, f),
      ...["S2", "S3", "S4", "S7", "S12"].flatMap((id) => scenarioTrusted(f, id)),
    ])
    expect(ended.snapshot.status).toBe("done")
    expect(TaskEngineXState.stopOf(ended.snapshot)).toEqual(Option.none())
    expect(TaskEngineXState.view(ended.snapshot).run.state).toBe("budget_exhausted")
    expect(ended.lines[0]).toBe(`Spec ${SPEC_TITLE} — budget exhausted`)
  }),
)

it.live("[UI20] a rejected scenario with every task trusted: the outcome line is failed: acceptance not proved", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // Given every task trusted (T8 and T9 too), every scenario trusted but S4, which its verifier rejects.
    const { snapshot, lines } = yield* summaryOf(plan, [
      ...allTrusted(plan, f, true),
      ...SCENARIOS.filter((id) => id !== "S4").flatMap((id) => scenarioTrusted(f, id)),
      f.scenarioProved("S4", "passed"),
      f.scenarioVerified(reject("S4", "the headings are not checked")),
    ])
    expect(snapshot.status).toBe("done")
    expect(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"].map((task) => unitState(snapshot, task))).toEqual(
      Array.from({ length: 6 }, () => "trusted"),
    )
    expect(unitState(snapshot, "S4")).toBe("rejected")
    expect(lines[0]).toBe(`Spec ${SPEC_TITLE} — failed: acceptance not proved`)
  }),
)

it.live("[UI20] a done run with one parked scenario: the outcome line is done · 1 scenario not run", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    // Given every task trusted, T8 not trusted, so S13 (which needs T8) is parked; every other scenario trusted.
    const { snapshot, lines } = yield* summaryOf(plan, [
      ...allTrusted(plan, f, false),
      ...SCENARIOS.filter((id) => id !== "S13").flatMap((id) => scenarioTrusted(f, id)),
    ])
    expect(snapshot.status).toBe("done")
    expect(TaskEngineXState.view(snapshot).run.state).toBe("done")
    expect(unitState(snapshot, "S13")).toBe("parked")
    expect(lines[0]).toBe(`Spec ${SPEC_TITLE} — done · 1 scenario not run`)
    // The run's spec checks never failed: no run-warning line.
    expect(lines).not.toContain(WARNING)
  }),
)

it.live("[UI20] a subtree run: the summary starts with the task id and title, then from spec and the spec title", () =>
  Effect.gen(function* () {
    // Given a run of the T1.2 folder: T1.2 trusted and the subtree's scenarios trusted.
    const plan = yield* loadPlan("release-notes.spec", "T1.2")
    const title = plan.tasks.find((task) => task.id === "T1.2")?.title
    expect(title).toBe("Compute the next version")
    expect(plan.scenarios.length).toBeGreaterThan(0)
    const f = facts()
    const { snapshot, lines } = yield* summaryOf(plan, [
      f.runStarted(),
      ...trustLeaf(plan, f, "T1.2"),
      ...plan.scenarios.flatMap((scenario) => scenarioTrusted(f, scenario.id)),
    ])
    expect(snapshot.status).toBe("done")
    expect(lines[0]).toBe(`**T1.2 Compute the next version** from spec ${SPEC_TITLE} — done`)
  }),
)

it.live("[UI20] a spec that stopped validating and then validated again still gives the run-warning line", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const f = facts()
    const failure = { rule: "R4", path: "T1-release-notes.task/TASK.md", message: "the task has no H1" }
    // Given the done run with one parked scenario, during which a spec check failed and a later one validated.
    const { snapshot, lines } = yield* summaryOf(plan, [
      f.runStarted(),
      f.outside("T9"),
      ...trustLeaf(plan, f, "T1.1"),
      f.checked([failure]),
      ...trustLeaf(plan, f, "T1.2"),
      f.checked([]),
      ...["T1.3", "T1.4", "T1.5"].flatMap((task) => trustLeaf(plan, f, task)),
      f.proved("T1", []),
      f.verified("T1", obligationsOf(plan, "T1").map(trust)),
      ...SCENARIOS.filter((id) => id !== "S13").flatMap((id) => scenarioTrusted(f, id)),
    ])
    expect(TaskEngineXState.warned(snapshot)).toBe(true)
    expect(snapshot.status).toBe("done")
    expect(TaskEngineXState.view(snapshot).run.state).toBe("done")
    // Then the summary holds the run-warning line, before the task table.
    expect(lines).toContain(WARNING)
    expect(lines.indexOf(WARNING)).toBeLessThan(lines.indexOf("**Tasks**"))
    expect(lines[0]).toBe(`Spec ${SPEC_TITLE} — done · 1 scenario not run`)
  }),
)

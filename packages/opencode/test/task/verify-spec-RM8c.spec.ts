import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Fiber, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TaskCommand } from "@/task/core/command"
import { TaskEvents } from "@/task/core/events"
import { TaskHarness } from "@/task/core/harness"
import type { Fact, Plan } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"
import { git, jobsOf, runTask, seed, SPEC } from "./lib/command"
import { exhaustLeaf, type Facts, facts, loadPlan, observed, trustLeaf } from "./lib/machine"
import { eventually } from "./lib/supervise"

// Scenario RM8c (spec task-harness-feedback, spine AD-3, AD-4, AD-6, D3): the observed stuck slice folds to its end and
// is never resumed.
//
//   Given the observed facts stored with no run.ended
//   When the slice is folded through the new machine
//   Then the fold is done with the outcome budget exhausted, and T1.5 and T1 are blocked
//   And /task on the same spec starts a new slice and never resumes a done fold
//
// The stored slice. The scenario file's header defines the observed facts as run.started, T1.1 to T1.3 trusted, and
// T1.4 built three times with a failing proof each time. The old runner that stored them (base 2c0214ab71,
// packages/opencode/src/task/core/runner.ts, `schedule`) also proved every waiting scenario whose needs were all
// trusted, as soon as they were; so the stored slice of the observed run holds those scenario facts too. The slice
// here is the fixture's observed facts (`observed`) with, after each trust, the proof and the verdict of each scenario
// that the trust made provable, in the old form (run.started with a base and no path), and with no run.ended. The
// first test shows that the header's facts alone leave exactly those scenarios open (D3: the run waits for them).
//
// The fold goes through the real engine (`TaskEvents.fold` over `initial` and `apply`, the selectors, `view`), the
// slice choice through `TaskCommand.sliceOf`, and the store and `/task` through the real event store and
// `TaskCommand.run` (through `./lib/command`), whose job records the first fact of the run on the harness.

const store = LayerNode.compile(LayerNode.group([EventV2Bridge.node, Database.node]))
const it = testEffect(Layer.mergeAll(store, NodeServices.layer))
const engine = TaskEngineXState
const seeded = seed(SPEC)

const START = 1_700_000_000_000
const OPEN = ["S2", "S3", "S4", "S7", "S12"]
const CAUSE = { id: "T1.4", state: "budget_exhausted" }

// The proof and the verdict of each scenario a trust made provable, as the old runner recorded them.
const scenarioFacts = (
  f: Facts,
  ids: ReadonlyArray<string>,
  outcome: (id: string) => "trusted" | "failed" | "rejected" = () => "trusted",
) =>
  ids.flatMap((id): ReadonlyArray<Fact> => {
    const end = outcome(id)
    if (end === "failed") return [f.scenarioProved(id, "failed", "the scenario test failed")]
    return [
      f.scenarioProved(id, "passed"),
      f.scenarioVerified(
        end === "trusted" ? { id, verdict: "trusted" } : { id, verdict: "rejected", reason: "the steps prove nothing" },
      ),
    ]
  })

// The stored observed slice, on the branch `base`; `outcome` sets each proved scenario's end.
const storedSlice = (plan: Plan, base: string, outcome?: (id: string) => "trusted" | "failed" | "rejected") => {
  // The facts after run.started take the next ticks of the clock.
  const f = facts(START)
  return [
    { type: "run.started", at: START, base },
    ...trustLeaf(plan, f, "T1.1"),
    ...scenarioFacts(f, ["S2", "S7"], outcome),
    ...trustLeaf(plan, f, "T1.2"),
    ...scenarioFacts(f, ["S3"], outcome),
    ...trustLeaf(plan, f, "T1.3"),
    ...scenarioFacts(f, ["S4", "S12"], outcome),
    ...exhaustLeaf(f, "T1.4", "T1.4.c7"),
  ] satisfies ReadonlyArray<Fact>
}

const isScenarioFact = (fact: Fact) => fact.type === "scenario.proved" || fact.type === "scenario.verified"
// A fact with its time and base left out, to compare two lists by what happened.
const shape = (fact: Fact) => {
  const { at: _at, ...rest } = fact
  if (rest.type === "run.started") {
    const { base: _base, ...start } = rest
    return start
  }
  return rest
}

it.live(
  "[RM8c] the stored observed slice: the observed facts, the old runner's scenario proofs, and no run.ended",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const stored = storedSlice(plan, "dev")
      // No stop is stored, and run.started has no path (the old engine wrote none).
      expect(stored.filter((fact) => fact.type === "run.ended" || fact.type === "run.cancelled")).toEqual([])
      expect(stored[0]).toEqual({ type: "run.started", at: stored[0]?.at ?? 0, base: "dev" })
      // Leave out the scenario facts, and what is left is the observed facts.
      expect(stored.filter((fact) => !isScenarioFact(fact)).map(shape)).toEqual(observed(plan).map(shape))

      // The observed facts alone fold to a run that waits only for the scenarios whose needs are all trusted (D3).
      const header = engine.view(TaskEvents.fold(engine.XStateEngine, plan, observed(plan)))
      expect(header.run.state).toBe("running")
      const provable = plan.scenarios
        .filter((scenario) => scenario.needs.every((id) => ["T1.1", "T1.2", "T1.3"].includes(id)))
        .map((scenario) => scenario.id)
      expect(provable.toSorted(engine.byId)).toEqual(OPEN)
      for (const scenario of plan.scenarios)
        expect(header.scenarios[scenario.id]?.state).toBe(OPEN.includes(scenario.id) ? "pending" : "blocked")
      // Those, and only those, are the scenarios the stored slice proves: each once, with a verdict.
      const proved = stored.flatMap((fact) => (fact.type === "scenario.proved" ? [fact.id] : []))
      expect(proved.toSorted(engine.byId)).toEqual(OPEN)
    }),
)

it.live("[RM8c] the stored slice folds to done with the outcome budget exhausted, and T1.5 and T1 blocked", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    const stored = storedSlice(plan, "dev")
    const snapshot = TaskEvents.fold(engine.XStateEngine, plan, stored)
    // The fold is done: its machine is final, with no stored stop.
    expect(snapshot.status).toBe("done")
    expect(engine.ended(snapshot)).toBe(true)
    expect(Option.isNone(engine.stopOf(snapshot))).toBe(true)
    expect(engine.view(snapshot).run).toMatchObject({
      state: "budget_exhausted",
      reason: "T1.4 budget exhausted\nT1 blocked by T1.4\nT1.5 blocked by T1.4",
    })
    expect(engine.view(snapshot).history.at(-1)).toMatchObject({ unit: "run", from: "running", to: "budget_exhausted" })
    // T1.4 is budget exhausted; T1.5 and T1 are blocked by it.
    expect(engine.unitState(snapshot, "T1.4")).toBe("budget_exhausted")
    for (const id of ["T1.5", "T1"]) {
      expect(engine.unitState(snapshot, id)).toBe("blocked")
      expect(engine.blockedBy(snapshot, id)).toEqual(CAUSE)
    }
    // The last stored fact, T1.4's third failing proof, is the one that ends the fold.
    expect(engine.ended(TaskEvents.fold(engine.XStateEngine, plan, stored.slice(0, -1)))).toBe(false)

    // The scenarios' own ends do not change it: a failed and a rejected scenario give the same outcome.
    const mixed = TaskEvents.fold(
      engine.XStateEngine,
      plan,
      storedSlice(plan, "dev", (id) => (id === "S3" ? "failed" : id === "S4" ? "rejected" : "trusted")),
    )
    expect(engine.ended(mixed)).toBe(true)
    expect(engine.view(mixed).run.state).toBe("budget_exhausted")
    expect([engine.unitState(mixed, "S3"), engine.unitState(mixed, "S4")]).toEqual(["failed", "rejected"])
    for (const id of ["T1.5", "T1"]) expect(engine.blockedBy(mixed, id)).toEqual(CAUSE)
  }),
)

it.instance(
  "[RM8c] /task on the same spec starts a new slice and never resumes the done fold",
  () =>
    Effect.gen(function* () {
      const directory = yield* seeded
      const branch = yield* git(directory, "rev-parse", "--abbrev-ref", "HEAD")
      const events = yield* EventV2Bridge.Service
      const db = yield* Database.Service
      const plan = yield* loadPlan("release-notes.spec")
      // The base is the checkout's branch, so a refusal for another branch cannot be the reason for a new slice.
      const stored = storedSlice(plan, branch)
      const id = TaskEvents.runID(directory, SPEC)
      for (const fact of stored) yield* TaskEvents.publish(events, id, fact)
      expect(yield* TaskEvents.read(db.db, id)).toEqual(stored)

      // The slice choice: the done fold is never resumed. One fact earlier the fold is not done, and it resumes.
      expect(yield* TaskCommand.sliceOf(plan, stored, SPEC)).toEqual({ kind: "new", died: Option.none() })
      expect(yield* TaskCommand.sliceOf(plan, stored.slice(0, -1), SPEC)).toEqual({
        kind: "resume",
        facts: stored.slice(0, -1),
      })

      // /task on the same spec: the reply is the run header alone, and the job starts a new slice.
      const harness = yield* TaskHarness.make
      const jobs = jobsOf()
      jobs.mode = "run"
      expect(yield* runTask(harness, SPEC, jobs)).toEqual([
        "Implementing spec **Release notes from conventional commits**",
      ])
      yield* eventually(
        Effect.map(TaskEvents.read(db.db, id), (list) => list.length > stored.length),
        "the new slice's first fact",
      )
      const after = yield* TaskEvents.read(db.db, id)
      expect(after.slice(0, stored.length)).toEqual(stored)
      const added = after.slice(stored.length)
      expect(added[0]).toEqual({ type: "run.started", at: added[0]?.at ?? 0, base: branch, path: SPEC })
      // No run.resumed: the done fold is not resumed, and the new slice is the latest.
      expect(added.filter((fact) => fact.type === "run.resumed")).toEqual([])
      expect(TaskEvents.slices(after)).toHaveLength(2)
      expect(Option.getOrThrow(TaskEvents.latestRun(after))[0]).toEqual(added[0])

      jobs.status = "cancelled"
      for (const fiber of jobs.fibers) yield* Fiber.interrupt(fiber)
      expect(yield* harness.live(directory)).toEqual(Option.none())
    }),
  { git: true },
)

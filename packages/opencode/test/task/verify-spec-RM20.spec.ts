import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Predicate } from "effect"
import path from "path"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"
import { Blend } from "@/task/blend"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { type RunEvent, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"

// Scenario RM20 (spec task-harness-feedback, D5, spine AD-7, AC 6, @ASSUMPTION:A1.a): the graph walk finds no stuck
// state in the two live-check plans.
//
//   Given the loaded plans of the two live-check folders, and from phase 3 the whole outside-run plan and its T1.2
//     subtree
//   When each plan is walked within 60 seconds
//   Then each walk finds no stuck state
//
// Each plan comes from the real loader: `Blend.load` of the folder under task-formats/blend, then `TaskCommand.plan`
// (through `loadPlan`). The walk is the port's breadth-first `getAdjacencyMap` over the plan's real run machine
// (`TaskMachine.machine(plan)`, which runs the structural totality check first), with the engine's progress alphabet
// (`TaskAlphabet.alphabet`) in the canonical interleaving (only the first unit, in document order, that has a fact
// gets its facts) and the engine's walk key (`TaskAlphabet.walkKey`). A state is stuck when it is not done and no
// event of the walk moves it to another key. The walk limit fails the walk (TraversalLimitError) instead of cutting
// it short, so a walk that passes visited every reachable key.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")
// The scenario's bound for each walk.
const WITHIN = 60_000
// About three times the largest walk's dequeued edges (the cascade plan: about 300); the port counts edges, not keys.
const LIMIT = 900

// The unit that a fact of the alphabet belongs to.
const unitOf = (fact: Fact): string => {
  if ("task" in fact) return fact.task
  if (fact.type === "scenario.verified") return fact.verdict.id
  if ("id" in fact) return fact.id
  return fact.type
}

/** The canonical interleaving: the facts of the first unit, in document order, that has any. */
const canonical = (snapshot: RunSnapshot): Array<Fact> => {
  const all = TaskAlphabet.alphabet(snapshot)
  const first = all[0]
  return first === undefined ? [] : all.filter((fact) => unitOf(fact) === unitOf(first))
}

const isMove = (value: unknown): value is { readonly state: RunSnapshot } =>
  Predicate.isObject(value) && "state" in value

interface Walk {
  readonly keys: number
  readonly edges: number
  readonly done: number
  readonly stuck: ReadonlyArray<string>
  readonly statuses: ReadonlyArray<string>
  readonly ms: number
}

/** Walks every key the canonical alphabet reaches from the plan's first snapshot. */
const walk = (plan: Plan) =>
  Effect.gen(function* () {
    const machine = TaskMachine.machine(plan)
    const keyOf = TaskAlphabet.walkKey(plan)
    const started = performance.now()
    const adjacency = yield* getAdjacencyMap<RunSnapshot, RunEvent, unknown>(machine, {
      events: (snapshot) => canonical(snapshot),
      serializeState: (snapshot) => keyOf(snapshot),
      fromState: engine.initial(plan),
      stopWhen: (snapshot) => snapshot.status === "done",
      limit: LIMIT,
    })
    const ms = performance.now() - started
    const entries = Object.entries(adjacency)
    const stuck = entries.flatMap(([key, value]) => {
      if (value.state.status === "done") return []
      const moves = Object.values(value.transitions)
        .filter(isMove)
        .some((next) => keyOf(next.state) !== key)
      return moves ? [] : [key]
    })
    return {
      keys: entries.length,
      edges: entries.reduce((sum, [, value]) => sum + Object.keys(value.transitions).length, 0),
      done: entries.filter(([, value]) => value.state.status === "done").length,
      stuck,
      statuses: [...new Set(entries.map(([, value]) => String(value.state.status)))].toSorted(),
      ms,
    } satisfies Walk
  })

// The plan of a folder, after the loader accepted the folder with no failure.
const loaded = (name: string, root?: string) =>
  Effect.gen(function* () {
    const result = yield* Blend.load(path.join(formatDir, name))
    expect(result.failures).toEqual([])
    expect(result.spec?.id).toBe(name.replace(/\.spec$/, ""))
    return yield* loadPlan(name, root)
  })

// The common Then: no stuck state, only active and done snapshots, a done end reached, inside the bound.
const expectNoStuck = (name: string, walked: Walk) => {
  console.log(`[RM20] ${name}: ${walked.keys} keys, ${walked.edges} edges, ${Math.round(walked.ms)} ms`)
  expect({ name, stuck: walked.stuck }).toEqual({ name, stuck: [] })
  expect(walked.statuses).toEqual(["active", "done"])
  expect(walked.done).toBeGreaterThan(0)
  expect(walked.keys).toBeGreaterThan(walked.done)
  expect(walked.ms).toBeLessThan(WITHIN)
}

it.live(
  "[RM20] the live-check plan example-scenarios.spec walks within 60 s with no stuck state",
  () =>
    Effect.gen(function* () {
      const plan = yield* loaded("example-scenarios.spec")
      // The live-check folder: parent T1 with leaf T1.1, and scenario S1.
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1"])
      expect(plan.scenarios.map((scenario) => scenario.id)).toEqual(["S1"])
      expectNoStuck("example-scenarios.spec", yield* walk(plan))
    }),
  WITHIN,
)

it.live(
  "[RM20] the live-check plan example-cascade.spec walks within 60 s with no stuck state",
  () =>
    Effect.gen(function* () {
      const plan = yield* loaded("example-cascade.spec")
      // The live-check folder: parent T1 with T1.1 (a gate that always fails, one attempt), T1.2 after T1.1, T1.3.
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1", "T1.2", "T1.3"])
      expect(plan.tasks.find((task) => task.id === "T1.2")?.afterEffective).toEqual(["T1.1"])
      expect(plan.budget("T1.1")).toBe(1)
      expectNoStuck("example-cascade.spec", yield* walk(plan))
    }),
  WITHIN,
)

it.live(
  "[RM20] the whole example-outside-run.spec plan (phase 3) walks within 60 s with no stuck state",
  () =>
    Effect.gen(function* () {
      const plan = yield* loaded("example-outside-run.spec")
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1", "T1.2"])
      expect(plan.external).toEqual([])
      expectNoStuck("example-outside-run.spec", yield* walk(plan))
    }),
  WITHIN,
)

it.live(
  "[RM20] the T1.2 subtree plan of example-outside-run.spec (phase 3) walks within 60 s with no stuck state",
  () =>
    Effect.gen(function* () {
      const plan = yield* loaded("example-outside-run.spec", "T1.2")
      // The subtree run holds T1.2 only; T1.1, outside the run, is an external region that T1.2 waits on.
      expect(plan.tasks.map((task) => task.id)).toEqual(["T1.2"])
      expect(plan.external).toEqual(["T1.1"])
      expect(engine.waitingOn(engine.initial(plan), "T1.2")).toContain("T1.1")
      expectNoStuck("example-outside-run.spec T1.2", yield* walk(plan))
    }),
  WITHIN,
)

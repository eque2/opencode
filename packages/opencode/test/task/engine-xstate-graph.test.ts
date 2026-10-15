import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, Predicate } from "effect"
import { createMachine, initialTransition } from "@jambudipa/xstate-effect"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { type RunEvent, type RunMachine, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"

// The graph proof (D5, spine AD-7, owner ruling 4): every state of the run machine that the progress alphabet can
// reach is either done or has a fact that changes its key. `machine(plan)` runs the structural totality check
// before any walk, so the walk and the check together are the AC 6 evidence. The main walk uses the canonical
// interleaving: in each state only the first unit in document order that has a fact gets its facts; a unit with a
// fact has only trusted dependencies, and a trusted unit leaves `trusted` only by staleness, which the main walk
// leaves out, so no other unit's fact can disable or change the chosen unit's facts. The reduction check compares it
// with the full interleaving on a small plan; the stale walk (opt-in, see below) adds staleness with the full
// interleaving.

const it = testEffect(NodeServices.layer)

// Each walk's limit is about three times its measured count of dequeued edges (the port counts edges, not keys).
const LIMIT = {
  // measured: 338 keys, 746 edges
  releaseNotes: 2_300,
  // measured: 23 keys, 46 edges
  scenarios: 150,
  // measured: 108 keys, 292 edges
  cascade: 900,
  // measured: 398 keys, 806 edges, 33 stuck
  negative: 2_500,
  // measured: 1 310 edges with the blocked rows
  reductionFull: 4_000,
  // measured: 36 353 keys, 361 474 edges (the opt-in stale walk, 55 min at load 5-13)
  stale: 1_100_000,
}
const WALK = 60_000
const STALE_WALK = 4 * 3_600_000

const stale =
  process.env.TASK_GRAPH_STALE === "1"
    ? it.live
    : (name: string, ..._rest: ReadonlyArray<unknown>) => test.skip(name, () => {})

// The unit a fact of the alphabet belongs to.
const unitOf = (fact: Fact) => {
  if ("task" in fact) return fact.task
  if (fact.type === "scenario.verified") return fact.verdict.id
  if ("id" in fact) return fact.id
  return fact.type
}

/** The canonical interleaving: the facts of the first unit, in document order, that has any. */
const canonical = (snapshot: RunSnapshot): ReadonlyArray<Fact> => {
  const all = TaskAlphabet.alphabet(snapshot)
  const first = all[0]
  if (first === undefined) return []
  return all.filter((fact) => unitOf(fact) === unitOf(first))
}

/** The full interleaving: every fact of the alphabet. */
const full = (snapshot: RunSnapshot): ReadonlyArray<Fact> => TaskAlphabet.alphabet(snapshot)

// The staleness of each obligation whose task is trusted or still in work.
const staleness = (snapshot: RunSnapshot): ReadonlyArray<Fact> => {
  const units = Object.entries(snapshot.context.units)
  const open = (task: string) =>
    snapshot.hasTag(`${task}:active`) || TaskEngineXState.unitState(snapshot, task) === "trusted"
  return units
    .filter(([, slot]) => slot.kind === "obligation" && open(slot.task ?? ""))
    .map(([id]): Fact => ({ type: "obligation.stale", at: TaskAlphabet.AT, id, hash: "stale" }))
}

/** The full interleaving with every staleness. */
const fullStale = (snapshot: RunSnapshot): ReadonlyArray<Fact> => [...full(snapshot), ...staleness(snapshot)]

// A transition of the adjacency map: the port types its values loosely.
const isNext = (next: unknown): next is { readonly state: RunSnapshot } => Predicate.isObject(next) && "state" in next

interface Walked {
  readonly keys: number
  readonly edges: number
  /** The keys of the states that are not done and that no fact of the alphabet moves. */
  readonly stuck: ReadonlyArray<string>
  readonly statuses: ReadonlyArray<string>
}

const walk = (
  plan: Plan,
  machine: RunMachine,
  from: RunSnapshot,
  events: (snapshot: RunSnapshot) => ReadonlyArray<Fact>,
  limit: number,
  mode: "main" | "stale" = "main",
) =>
  Effect.gen(function* () {
    const keyOf = TaskAlphabet.walkKey(plan, mode)
    const keys = new WeakMap<RunSnapshot, string>()
    const key = (snapshot: RunSnapshot) => {
      const found = keys.get(snapshot)
      if (found !== undefined) return found
      const made = keyOf(snapshot)
      keys.set(snapshot, made)
      return made
    }
    const adjacency = yield* getAdjacencyMap<RunSnapshot, RunEvent, unknown>(machine, {
      events: (snapshot) => [...events(snapshot)],
      serializeState: (snapshot) => key(snapshot),
      fromState: from,
      stopWhen: (snapshot) => snapshot.status === "done",
      limit,
    })
    const values = Object.entries(adjacency)
    const stuck = values.flatMap(([name, value]) => {
      if (value.state.status === "done") return []
      const moves = Object.values(value.transitions)
        .filter(isNext)
        .some((next) => key(next.state) !== name)
      return moves ? [] : [name]
    })
    return {
      keys: values.length,
      edges: values.reduce((sum, [, value]) => sum + Object.keys(value.transitions).length, 0),
      stuck,
      statuses: [...new Set(values.map(([, value]) => String(value.state.status)))].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    } satisfies Walked
  })

// The machine of a config copy with the AD-3 `blocked` rows removed (the copy fails the totality check by design, so
// it is built without it).
const withoutBlocked = (plan: Plan) =>
  createMachine(
    TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
      Array.isArray(node.always)
        ? { ...node, always: node.always.filter((row) => typeof row !== "object" || row.target !== "blocked") }
        : node,
    ),
    { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS },
  )

const mainWalk = (name: string, limit: number) =>
  Effect.gen(function* () {
    const plan = yield* loadPlan(name)
    return yield* walk(plan, TaskMachine.machine(plan), TaskEngineXState.initial(plan), canonical, limit)
  })

describe("the graph proof", () => {
  it.live(
    "RM19 walks the release-notes plan: no stuck state, every snapshot active or done",
    () =>
      Effect.gen(function* () {
        const walked = yield* mainWalk("release-notes.spec", LIMIT.releaseNotes)
        console.log("release-notes walk", walked.keys, "keys", walked.edges, "edges")
        expect(walked.stuck).toEqual([])
        expect(walked.statuses).toEqual(["active", "done"])
      }),
    WALK,
  )

  it.live(
    "RM20 walks the two live-check plans: no stuck state",
    () =>
      Effect.gen(function* () {
        const scenarios = yield* mainWalk("example-scenarios.spec", LIMIT.scenarios)
        const cascade = yield* mainWalk("example-cascade.spec", LIMIT.cascade)
        console.log("live-check walks", scenarios.keys, scenarios.edges, cascade.keys, cascade.edges)
        expect(scenarios.stuck).toEqual([])
        expect(cascade.stuck).toEqual([])
        expect(scenarios.statuses).toEqual(["active", "done"])
        expect(cascade.statuses).toEqual(["active", "done"])
      }),
    WALK,
  )

  it.live(
    "RM21 finds the observed stuck state when the blocked rows are removed from a copy of the config",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const machine = withoutBlocked(plan)
        const [from] = yield* initialTransition(machine)
        const walked = yield* walk(plan, machine, from, canonical, LIMIT.negative)
        console.log("negative control", walked.keys, "keys", walked.edges, "edges", walked.stuck.length, "stuck")
        const observed = walked.stuck.filter(
          (name) =>
            ["T1.1:trusted", "T1.2:trusted", "T1.3:trusted", "T1.4:budget_exhausted"].every((part) =>
              name.includes(`|${part}|`),
            ) &&
            name.includes("|T1.5:waiting@") &&
            name.includes("|T1:waiting@"),
        )
        expect(observed.length).toBeGreaterThan(0)
      }),
    WALK,
  )

  it.live(
    "RM22 the canonical and the full walk find the same stuck states, with and without the blocked rows",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("example-cascade.spec")
        const machine = TaskMachine.machine(plan)
        const from = TaskEngineXState.initial(plan)
        const canonicalWalk = yield* walk(plan, machine, from, canonical, LIMIT.cascade)
        const fullWalk = yield* walk(plan, machine, from, full, LIMIT.reductionFull)
        expect(canonicalWalk.stuck).toEqual([])
        expect(fullWalk.stuck).toEqual([])
        const broken = withoutBlocked(plan)
        const [start] = yield* initialTransition(broken)
        const brokenCanonical = yield* walk(plan, broken, start, canonical, LIMIT.cascade)
        const brokenFull = yield* walk(plan, broken, start, full, LIMIT.reductionFull)
        console.log(
          "reduction",
          canonicalWalk.edges,
          fullWalk.edges,
          brokenCanonical.stuck.length,
          brokenFull.stuck.length,
        )
        expect(brokenCanonical.stuck.length).toBeGreaterThan(0)
        // A stuck state is the same configuration in both walks. The key's `dead:` part holds the state of the first
        // death (what the outcome's firstDead guard reads), and the order of deaths is what the canonical interleaving
        // fixes; it changes only the outcome a run settles to, never whether a state can move.
        const configurations = (stuck: ReadonlyArray<string>) =>
          [...new Set(stuck.map((name) => name.replace(/\|dead:[^|]*/, "")))].toSorted()
        expect(configurations(brokenCanonical.stuck)).toEqual(configurations(brokenFull.stuck))
      }),
    WALK * 2,
  )

  // The stale walk is long: staleness multiplies the obligation states of every task in work, and the full
  // interleaving multiplies the tasks (journal defect D1). It runs with TASK_GRAPH_STALE=1, as the conformance suite
  // runs with an arm, and its result is recorded in the task journal.
  stale(
    "walks the cascade plan with staleness and the full interleaving: no stuck state",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("example-cascade.spec")
        const walked = yield* walk(
          plan,
          TaskMachine.machine(plan),
          TaskEngineXState.initial(plan),
          fullStale,
          LIMIT.stale,
          "stale",
        )
        console.log("stale walk", walked.keys, "keys", walked.edges, "edges")
        expect(walked.stuck).toEqual([])
        expect(walked.statuses).toEqual(["active", "done"])
      }),
    STALE_WALK,
  )
})

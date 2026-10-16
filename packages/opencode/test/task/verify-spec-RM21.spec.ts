import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Predicate } from "effect"
import { createMachine, initialTransition } from "@jambudipa/xstate-effect"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { type RunConfig, type RunEvent, type RunMachine, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan, observed, unitState } from "./lib/machine"

// Scenario RM21 (spec task-harness-feedback, D5, spine AD-3, AD-7, @ASSUMPTION:A1.a): the graph walk finds the
// observed stuck state when the cascade rows are removed.
//
//   Given a copy of the release-notes machine config without the blocked rows
//   When the copy is walked
//   Then the walk reports a stuck state with T1.1 to T1.3 trusted, T1.4 budget exhausted, and T1.5 and T1 waiting
//
// The plan comes from the real loader (`loadPlan`: `Blend.load` and `TaskCommand.plan`). The copy is the plan's real
// config (`TaskMachine.config`) passed through `TaskMachine.mapStates`, with each `always` row whose target is
// `blocked` (the AD-3 cascade) removed and nothing else changed; its machine uses the real ACTIONS and GUARDS. The walk
// is the port's `getAdjacencyMap` with the engine's alphabet (canonical interleaving) and walk key. A stuck state is
// one that is not done and that no walk event moves to another key. The unit states are read from each snapshot
// (its state value and its meta through the engine selector), not from the key text.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

// About three times the copy's measured walk (about 800 dequeued edges); the port counts edges, not keys.
const LIMIT = 2_500
const WALK = 120_000

type Row = { readonly target?: unknown }
type Node = { readonly always?: unknown; readonly states?: Readonly<Record<string, Node>> }

const isBlockedRow = (row: unknown) => Predicate.isObject(row) && (row as Row).target === "blocked"

// Every state node of a config's two top regions, depth first.
const nodesOf = (node: Node): ReadonlyArray<Node> => [
  node,
  ...Object.values(node.states ?? {}).flatMap((child) => nodesOf(child)),
]
const rowsOf = (built: RunConfig) =>
  [built.states.active, built.states.outcome]
    .flatMap((top) => nodesOf(top))
    .flatMap((node) => (Array.isArray(node.always) ? node.always : []))

/** The copy of a config without the blocked rows. */
const withoutBlocked = (built: RunConfig) =>
  TaskMachine.mapStates(built, (node) =>
    Array.isArray(node.always) ? { ...node, always: node.always.filter((row) => !isBlockedRow(row)) } : node,
  )

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

const walk = (plan: Plan, machine: RunMachine, from: RunSnapshot) =>
  Effect.gen(function* () {
    const keyOf = TaskAlphabet.walkKey(plan)
    const adjacency = yield* getAdjacencyMap<RunSnapshot, RunEvent, unknown>(machine, {
      events: (snapshot) => canonical(snapshot),
      serializeState: (snapshot) => keyOf(snapshot),
      fromState: from,
      stopWhen: (snapshot) => snapshot.status === "done",
      limit: LIMIT,
    })
    const entries = Object.entries(adjacency)
    const stuck = entries.flatMap(([key, value]) => {
      if (value.state.status === "done") return []
      const moves = Object.values(value.transitions)
        .filter(isMove)
        .some((next) => keyOf(next.state) !== key)
      return moves ? [] : [{ key, snapshot: value.state }]
    })
    return {
      keys: entries.length,
      stuck,
      statuses: [...new Set(entries.map(([, value]) => String(value.state.status)))].toSorted(),
    }
  })

// The observed configuration, read from a snapshot: the machine state and the status name of each unit.
const OBSERVED = {
  "T1.1": "trusted",
  "T1.2": "trusted",
  "T1.3": "trusted",
  "T1.4": "budget_exhausted",
  "T1.5": "waiting",
  T1: "waiting",
} as const
const configuration = (snapshot: RunSnapshot) =>
  Object.fromEntries(Object.keys(OBSERVED).map((id) => [id, unitState(snapshot, id)]))
const statusNames = (snapshot: RunSnapshot) =>
  Object.fromEntries(Object.keys(OBSERVED).map((id) => [id, engine.unitState(snapshot, id)]))
const isObserved = (snapshot: RunSnapshot) =>
  Object.entries(OBSERVED).every(([id, state]) => unitState(snapshot, id) === state)

const scenario = Effect.gen(function* () {
  const plan = yield* loadPlan("release-notes.spec")
  const real = TaskMachine.config(plan)
  const copy = withoutBlocked(real)
  const machine = createMachine(copy, { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS })
  const [from] = yield* initialTransition(machine)
  return { plan, real, copy, machine, from }
})

it.live("[RM21] the copy of the release-notes config has no blocked row and keeps every other row", () =>
  Effect.gen(function* () {
    const { plan, real, copy, from } = yield* scenario
    // The release-notes plan: T1.5 is after T1.3, T1.4 and the outside T9; T1 is the parent of T1.1 to T1.5.
    expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
    expect(plan.tasks.find((task) => task.id === "T1.5")?.afterEffective).toEqual(["T1.3", "T1.4", "T9"])
    const before = rowsOf(real)
    const after = rowsOf(copy)
    expect(before.filter(isBlockedRow).length).toBeGreaterThan(0)
    expect(after.filter(isBlockedRow)).toEqual([])
    expect(after).toEqual(before.filter((row) => !isBlockedRow(row)))
    // The real config passes the generator's checks; the copy fails the totality check (owner ruling 4) by design.
    expect(TaskMachine.check(plan, real)).toBe(real)
    expect(() => TaskMachine.check(plan, copy)).toThrow(/totality/)
    // The copy's first snapshot is a live run of the release-notes plan.
    expect(from.status).toBe("active")
    expect(unitState(from, "T1.5")).toBe("waiting")
  }),
)

it.live(
  "[RM21] the walk of the copy reports a stuck state with T1.1 to T1.3 trusted, T1.4 budget exhausted, and T1.5 and T1 waiting",
  () =>
    Effect.gen(function* () {
      const { plan, machine, from } = yield* scenario
      const walked = yield* walk(plan, machine, from)
      console.log(`[RM21] copy walk: ${walked.keys} keys, ${walked.stuck.length} stuck`)
      expect(walked.statuses).toEqual(["active", "done"])
      expect(walked.stuck.length).toBeGreaterThan(0)
      const found = walked.stuck.filter((each) => isObserved(each.snapshot))
      expect(found.length).toBeGreaterThan(0)
      for (const each of found) {
        // Read from the snapshot: the machine states, and the status names the status file would show.
        expect(configuration(each.snapshot)).toEqual({ ...OBSERVED })
        expect(statusNames(each.snapshot)).toEqual({ ...OBSERVED })
        expect(each.snapshot.status).toBe("active")
        // T1.5 and T1 wait on the dead T1.4 for ever: nothing in the alphabet moves the state to another key.
        expect(engine.waitingOn(each.snapshot, "T1.5")).toContain("T1.4")
        expect(engine.tags(each.snapshot, "T1.5")).not.toContain("blocked")
        expect(engine.tags(each.snapshot, "T1")).not.toContain("blocked")
        // Stuck under the whole alphabet too, not only under the canonical interleaving's choice.
        const keyOf = TaskAlphabet.walkKey(plan)
        expect(each.key).toBe(keyOf(each.snapshot))
        for (const fact of TaskAlphabet.alphabet(each.snapshot))
          expect(keyOf(engine.applyTo(machine, each.snapshot, fact))).toBe(each.key)
      }
    }),
  WALK,
)

it.live(
  "[RM21] the observed facts, folded on the copy, reach that stuck configuration and nothing moves T1.5 or T1",
  () =>
    Effect.gen(function* () {
      const { plan, machine, from } = yield* scenario
      // The observed run: T1.1 to T1.3 trusted, T1.4 failing its proof on each of its three attempts, and T9 trusted.
      const list: ReadonlyArray<Fact> = [...observed(plan), { type: "outside.trusted", at: 100, id: "T9" }]
      const end = list.reduce((snapshot, fact) => engine.applyTo(machine, snapshot, fact), from)
      expect(configuration(end)).toEqual({ ...OBSERVED })
      expect(end.status).toBe("active")
      // Every state that the whole alphabet reaches from there keeps the configuration and never ends; the walk
      // reports its stuck states.
      const keyOf = TaskAlphabet.walkKey(plan)
      const adjacency = yield* getAdjacencyMap<RunSnapshot, RunEvent, unknown>(machine, {
        events: (snapshot) => [...TaskAlphabet.alphabet(snapshot)],
        serializeState: (snapshot) => keyOf(snapshot),
        fromState: end,
        limit: LIMIT,
      })
      const values = Object.entries(adjacency)
      for (const [, value] of values) {
        expect(configuration(value.state)).toEqual({ ...OBSERVED })
        expect(value.state.status).toBe("active")
      }
      const stuck = values.filter(([key, value]) =>
        Object.values(value.transitions)
          .filter(isMove)
          .every((next) => keyOf(next.state) === key),
      )
      expect(stuck.length).toBeGreaterThan(0)
    }),
  WALK,
)

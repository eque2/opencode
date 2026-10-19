import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Predicate } from "effect"
import { createMachine, initialTransition } from "@jambudipa/xstate-effect"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { type RunEvent, type RunMachine, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan, outcome, unitState as machineState } from "./lib/machine"

// Scenario RM19 (spec task-harness-feedback, D5, AD-7, owner ruling 4, @ASSUMPTION:A1.a; tasks T1.9 and T1.10): the
// graph walk finds no stuck state in the release-notes plan.
//
//   Given the release-notes plan and the engine's progress alphabet
//   When every state reachable with the canonical interleaving is walked within 60 seconds
//   Then no state that is not done lacks an event that changes its key
//   And every visited snapshot has status active or done
//
// The plan is `release-notes.spec`, loaded by the real loader (`Blend.load`, then `TaskCommand.plan`, through
// `loadPlan`). Its machine is the generator's (`TaskMachine.machine`), which runs the structural totality check of
// owner ruling 4 before any walk. The walk is the port's breadth-first `getAdjacencyMap` from the engine's first
// snapshot, with the engine's progress alphabet (`TaskAlphabet.alphabet`) under the canonical interleaving (in each
// state only the first unit, in document order, that has a fact gets its facts; owner ruling 4 (a) accepts it as the
// reading of "every reachable state") and the engine's walk key (`TaskAlphabet.walkKey`). A state is stuck when it is
// not done and none of its events leads to a state with another key. A negative control on a small plan whose
// blocked rows are removed shows that this stuck detector reports a stuck state when one exists.

const it = testEffect(NodeServices.layer)

// The walk's hang guard: about three times the edges a walk of this plan dequeues (the port counts each dequeue).
const LIMIT = 5_000
// Owner ruling 8 (goal.md, 2026-10-18) raised the Gherkin's 60 s bound to 180 s: the walk took 68.8 s under the shared
// host's load against about 28 s alone. Ruling 10 (2026-10-19) raised it to 600 s: at load 80-170 the walk passed the
// 300 s test timeout. LIMIT stays the deterministic guard against a state-space blow-up.
const WITHIN_MS = 600_000

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

// A transition of the adjacency map: the port types its values loosely.
const isNext = (next: unknown): next is { readonly state: RunSnapshot } => Predicate.isObject(next) && "state" in next

const walk = (plan: Plan, machine: RunMachine, from: RunSnapshot) =>
  Effect.gen(function* () {
    const keyOf = TaskAlphabet.walkKey(plan)
    const keys = new WeakMap<RunSnapshot, string>()
    const key = (snapshot: RunSnapshot) => {
      const found = keys.get(snapshot)
      if (found !== undefined) return found
      const made = keyOf(snapshot)
      keys.set(snapshot, made)
      return made
    }
    const adjacency = yield* getAdjacencyMap<RunSnapshot, RunEvent, unknown>(machine, {
      events: (snapshot) => [...canonical(snapshot)],
      serializeState: (snapshot) => key(snapshot),
      fromState: from,
      stopWhen: (snapshot) => snapshot.status === "done",
      limit: LIMIT,
    })
    const values = Object.entries(adjacency)
    // Each state that is not done and has no event that changes its key.
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
      statuses: [...new Set(values.map(([, value]) => String(value.state.status)))].toSorted(),
      states: values.map(([, value]) => value.state),
    }
  })

// The machine of a config copy with the AD-3 `blocked` rows removed (it fails the totality check by design, so it is
// built without it).
const withoutBlocked = (plan: Plan): RunMachine =>
  createMachine(
    TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
      Array.isArray(node.always)
        ? { ...node, always: node.always.filter((row) => typeof row !== "object" || row.target !== "blocked") }
        : node,
    ),
    { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS },
  )

it.live("[RM19] owner ruling 4: the release-notes plan passes the structural totality check before any walk", () =>
  Effect.gen(function* () {
    const plan = yield* loadPlan("release-notes.spec")
    expect(plan.tasks.map((task) => task.id)).toEqual(["T1", "T1.1", "T1.2", "T1.3", "T1.4", "T1.5"])
    expect(plan.scenarios).toHaveLength(13)
    // The check returns the config it was given; on a gap it dies with the unit, the state and the uncovered outcome.
    const built = TaskMachine.config(plan)
    expect(TaskMachine.check(plan, built)).toBe(built)
    // The generator runs the same check inside `machine(plan)`; the engine's first snapshot is active.
    expect(TaskMachine.machine(plan)).toBeDefined()
    expect(TaskEngineXState.initial(plan).status).toBe("active")
  }),
)

it.live(
  "[RM19] owner rulings 4, 8 and 10: every state reachable with the canonical interleaving is walked within 600 seconds, no state that is not done lacks an event that changes its key, and every visited snapshot is active or done",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("release-notes.spec")
      const started = performance.now()
      const walked = yield* walk(plan, TaskMachine.machine(plan), TaskEngineXState.initial(plan))
      const elapsed = performance.now() - started
      console.log(`[RM19] release-notes walk: ${walked.keys} keys, ${walked.edges} edges, ${Math.round(elapsed)} ms`)

      // When: the walk ended inside its bound, and it did not stop at its hang guard (the port fails past `limit`).
      expect(elapsed).toBeLessThan(WITHIN_MS)
      expect(walked.edges).toBeLessThan(LIMIT)

      // Then: no state that is not done lacks an event that changes its key.
      expect(walked.stuck).toEqual([])
      // And: every visited snapshot has status active or done.
      expect(walked.statuses).toEqual(["active", "done"])

      // The walk is not vacuous: it covers hundreds of states, reaches done with each outcome the alphabet can give
      // (a clean end and each dead state), and visits the observed cascade (T1.4 budget exhausted after T1.1-T1.3 were
      // trusted), where T1.5 and T1 are blocked, not waiting.
      expect(walked.keys).toBeGreaterThan(100)
      const outcomes = [
        ...new Set(walked.states.filter((state) => state.status === "done").map((state) => outcome(state))),
      ].toSorted()
      expect(outcomes).toEqual(["budget_exhausted", "done", "failed", "needs_human"])
      const observed = walked.states.filter(
        (state) =>
          ["T1.1", "T1.2", "T1.3"].every((id) => machineState(state, id) === "trusted") &&
          machineState(state, "T1.4") === "budget_exhausted",
      )
      expect(observed.length).toBeGreaterThan(0)
      for (const state of observed) {
        expect([machineState(state, "T1.5"), machineState(state, "T1")]).toEqual(["blocked", "blocked"])
      }
    }),
  900_000,
)

it.live(
  "[RM19] the walk's stuck detector reports stuck states on a small plan whose blocked rows are removed",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const intact = yield* walk(plan, TaskMachine.machine(plan), TaskEngineXState.initial(plan))
      expect(intact.stuck).toEqual([])
      const broken = withoutBlocked(plan)
      const [from] = yield* initialTransition(broken)
      const walked = yield* walk(plan, broken, from)
      expect(walked.stuck.length).toBeGreaterThan(0)
      // A stuck state of the copy: T1.1 dead and T1.2, which is after T1.1, still waiting with nothing to move it.
      expect(walked.stuck.some((name) => name.includes("|T1.2:waiting@"))).toBe(true)
    }),
  // Owner ruling 10: two walks of a small plan; at load 170 they passed the 30 s default.
  300_000,
)

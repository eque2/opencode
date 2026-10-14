import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { createActor } from "@jambudipa/xstate-effect"
import type { Fact, History, Plan, Result, Verdict } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"

// The engine on seeded random fact lists over the release-notes plan (spine AD-5, AD-6): facts in any order,
// facts after a run is done, and unknown ids. For every seed, three paths must reach the same snapshot: the pure
// fold through `apply`, a live actor of the run machine sent the same facts, and an actor restored from the
// persisted fold of a prefix and sent the rest. Along the fold, every change is logged, and an entry with no other
// change is the note of a targetless row.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const SEEDS = 40
const STEPS = 100
// Each seed folds its facts three times on the real machine, which takes seconds under load.
const PER_SEED = 600_000

// A seeded generator (mulberry32): every run folds the same fact lists.
const generator = (seed: number) => {
  let current = seed
  const next = () => {
    current = (current + 0x6d2b79f5) | 0
    let t = Math.imul(current ^ (current >>> 15), 1 | current)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(next() * items.length)]
  return { next, pick }
}

type Random = ReturnType<typeof generator>

const KINDS = [
  "started",
  "ready",
  "proved",
  "verified",
  "stalled",
  "repeated",
  "stale",
  "scenario.proved",
  "scenario.verified",
  "run.started",
  "run.resumed",
  "outside",
  "needs_human",
  "failed",
  "cancelled",
  "ended",
] as const

type Kind = (typeof KINDS)[number]

// The facts a task most likely meets next, by its phase tag, so that the folds reach every state.
const LIKELY: Record<string, ReadonlyArray<Kind>> = {
  ready: ["started"],
  building: ["ready", "ready", "ready", "repeated"],
  proving: ["proved"],
  verifying: ["verified"],
}
// A ready parent moves on its review proof, a trusted task on a staleness, a ready scenario on its proof.
const PARENT_READY: ReadonlyArray<Kind> = ["proved"]
const TRUSTED: ReadonlyArray<Kind> = ["stale"]
const SCENARIO: ReadonlyArray<Kind> = ["scenario.proved", "scenario.verified"]

const phaseOf = (snapshot: RunSnapshot, id: string) =>
  ["ready", "building", "proving", "verifying"].find((tag) => snapshot.hasTag(`${id}:${tag}`))

// One random fact: mostly one that moves the chosen task on, otherwise any fact (unknown ids included). The task is
// mostly one with work in hand, so that a slice reaches the later moves before a stop ends it: a task waits until its
// dependencies are trusted, so a uniform choice spends most facts on tasks that cannot move.
const randomFact = (plan: Plan, snapshot: RunSnapshot, { next, pick }: Random, at: number): Fact => {
  const working = plan.tasks.map((item) => item.id).filter((id) => phaseOf(snapshot, id) !== undefined)
  // `T7` is in no plan.
  const task = working.length > 0 && next() < 0.8 ? pick(working) : pick([...plan.tasks.map((item) => item.id), "T7"])
  const own = plan.spec.obligations.filter((item) => item.task === task).map((item) => item.id)
  const leaf = plan.tasks.find((item) => item.id === task)?.children.length === 0
  const phase = phaseOf(snapshot, task)
  const scenarios = plan.scenarios.map((item) => item.id)
  const active = scenarios.filter((id) => phaseOf(snapshot, id) !== undefined)
  const likely =
    phase === "ready" && !leaf
      ? PARENT_READY
      : engine.unitState(snapshot, task) === "trusted"
        ? TRUSTED
        : active.length > 0 && next() < 0.3
          ? SCENARIO
          : LIKELY[phase ?? ""]
  const kind = next() < 0.75 && likely !== undefined ? pick(likely) : pick(KINDS)
  const maybe = (text: string) => (next() < 0.3 ? `${text} ${at}` : undefined)
  switch (kind) {
    case "started":
      return {
        type: "task.started",
        at,
        task,
        worktree: `/wt/${task}`,
        branch: `task/${task}`,
        base: "base",
        session: `ses_${task}`,
      }
    case "ready":
      return { type: "task.ready", at, task, head: `head${at}` }
    case "proved": {
      const results = own
        .filter(() => next() < 0.9)
        .map((id): Result => {
          const roll = next()
          if (roll < 0.08) return { id, status: "failed", reason: maybe("failed") }
          return { id, status: roll < 0.3 ? "passed" : "needs-judge" }
        })
      return { type: "task.proved", at, task, results, reason: next() < 0.05 ? `structural ${at}` : undefined }
    }
    case "verified": {
      const verdicts = own
        .filter(() => next() < 0.92)
        .map(
          (id): Verdict =>
            next() < 0.88 ? { id, verdict: "trusted" } : { id, verdict: "rejected", reason: maybe("weak") },
        )
      return { type: "task.verified", at, task, verdicts }
    }
    case "stalled":
      return { type: "task.stalled", at, task, reason: `idle ${at}` }
    case "repeated":
      return { type: "task.repeated", at, task, reason: `repetition ${at}` }
    case "stale":
      return { type: "obligation.stale", at, id: pick([...own, "T7.c1"]), hash: `hash${at}` }
    case "scenario.proved":
      return {
        type: "scenario.proved",
        at,
        id: pick([...(active.length > 0 ? active : scenarios), "S99"]),
        status: next() < 0.8 ? "passed" : "failed",
        reason: maybe("tests failed"),
      }
    case "scenario.verified": {
      const id = pick(active.length > 0 ? active : scenarios)
      const verdict: Verdict =
        next() < 0.8 ? { id, verdict: "trusted" } : { id, verdict: "rejected", reason: maybe("no") }
      return { type: "scenario.verified", at, verdict }
    }
    case "run.started":
      return { type: "run.started", at }
    case "run.resumed":
      return { type: "run.resumed", at }
    case "outside":
      return { type: "outside.trusted", at, id: pick(Object.keys(plan.spec.outside)) }
    case "needs_human":
      return { type: "task.needs_human", at, task, reason: `quota ${at}` }
    case "failed":
      return { type: "task.failed", at, task, reason: `merge conflict ${at}` }
    case "cancelled":
      return { type: "run.cancelled", at, reason: `aborted ${at}` }
    default:
      return { type: "run.ended", at, state: next() < 0.7 ? "done" : "failed", reason: maybe("ended") }
  }
}

// What a history entry moved, for the coverage check: the unit's kind and its two states.
const moveOf = (plan: Plan, item: History) => {
  const kind =
    item.unit === "run"
      ? "run"
      : item.unit in plan.spec.outside
        ? "outside"
        : plan.scenarios.some((scenario) => scenario.id === item.unit)
          ? "scenario"
          : plan.spec.obligations.some((obligation) => obligation.id === item.unit)
            ? "obligation"
            : "task"
  return `${kind}:${item.from}>${item.to}`
}

// The slices of one seed: 100 random facts, a new slice after each run that is done.
const slicesOf = (plan: Plan, seed: number) => {
  const random = generator(seed)
  const slices: Array<ReadonlyArray<Fact>> = []
  let snapshot = engine.initial(plan)
  let slice: Array<Fact> = []
  for (let step = 1; step <= STEPS; step++) {
    const fact = randomFact(plan, snapshot, random, step)
    snapshot = engine.apply(plan, snapshot, fact)
    slice.push(fact)
    if (!engine.ended(snapshot)) continue
    slices.push(slice)
    slice = []
    snapshot = engine.initial(plan)
  }
  if (slice.length > 0) slices.push(slice)
  return slices
}

// The parts of a snapshot that the three paths must agree on.
const shape = (snapshot: RunSnapshot) => ({ status: snapshot.status, value: snapshot.value, context: snapshot.context })

const withoutLog = (snapshot: RunSnapshot) => {
  const { log: _, ...rest } = snapshot.context
  return { value: snapshot.value, context: rest }
}

describe("XStateEngine on random facts", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it.live(
      `seed ${seed}: the fold, a live actor and a restored actor agree, and the history grows only with a change`,
      () =>
        Effect.gen(function* () {
          const plan = yield* loadPlan("release-notes.spec")
          const machine = TaskMachine.machine(plan)
          for (const slice of slicesOf(plan, seed)) {
            // The pure fold, step by step.
            const prefix = Math.floor(slice.length / 2)
            let folded = engine.initial(plan)
            let half = folded
            for (const [index, fact] of slice.entries()) {
              const next = engine.apply(plan, folded, fact)
              const added = next.context.log.slice(folded.context.log.length)
              expect(next.context.log.slice(0, folded.context.log.length)).toEqual([...folded.context.log])
              const changed = JSON.stringify(withoutLog(next)) !== JSON.stringify(withoutLog(folded))
              // Every change is logged. A history entry with no other change is a note of a targetless row (a run
              // start or resume, a stall): AD-5 has those rows write their own entry, from a state to itself.
              if (changed) expect(added.length).toBeGreaterThan(0)
              if (!changed) expect(added.filter((item) => item.from !== item.to)).toEqual([])
              if (added.length === 0) expect(next).toBe(folded)
              folded = next
              if (index + 1 === prefix) half = folded
            }
            // A fact after the run is done changes nothing.
            if (engine.ended(folded)) expect(engine.apply(plan, folded, { type: "run.resumed", at: 1_000 })).toBe(folded)

            // A live actor sent the same facts.
            const live = yield* Effect.scoped(
              Effect.gen(function* () {
                const actor = yield* createActor(machine)
                yield* actor.start
                for (const fact of slice) yield* actor.send(fact)
                return yield* actor.getSnapshot
              }),
            )
            expect(shape(live)).toEqual(shape(folded))

            // An actor restored from the persisted fold of the prefix, sent the rest.
            const persisted = yield* machine.getPersistedSnapshot(half)
            const restored = yield* Effect.scoped(
              Effect.gen(function* () {
                const actor = yield* createActor(machine, { snapshot: persisted })
                yield* actor.start
                for (const fact of slice.slice(prefix)) yield* actor.send(fact)
                return yield* actor.getSnapshot
              }),
            )
            expect(shape(restored)).toEqual(shape(folded))
          }
        }),
      PER_SEED,
    )
  }

  it.live(
    "reaches the lifecycle's later moves across the seeds",
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan("release-notes.spec")
        const moves = new Set<string>()
        for (let seed = 1; seed <= SEEDS; seed++)
          for (const slice of slicesOf(plan, seed)) {
            const folded = slice.reduce((snapshot, fact) => engine.apply(plan, snapshot, fact), engine.initial(plan))
            for (const item of folded.context.log) moves.add(moveOf(plan, item))
          }
        for (const move of [
          "task:waiting>blocked",
          "task:verifying>trusted",
          "task:proving>building",
          "task:verifying>building",
          "task:trusted>proving",
          "task:building>budget_exhausted",
          "obligation:passed>stale",
          "obligation:trusted>stale",
          "obligation:rejected>passed",
          "scenario:pending>trusted",
          "run:running>done",
          "run:running>cancelled",
        ])
          expect([...moves]).toContain(move)
      }),
    PER_SEED,
  )
})

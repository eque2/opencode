import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import path from "path"
import { Blend } from "@/task/blend"
import { TaskCommand } from "@/task/core/command"
import type { Fact, Plan, Result, State, Verdict } from "@/task/core/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { testEffect } from "../lib/effect"

// The engine on seeded random fact lists over the release-notes plan: facts in any order, unknown ids included. The
// invariants hold for any pure fold of facts into state, so they need no second engine to compare with.

const it = testEffect(NodeServices.layer)

const RELEASE_NOTES = "task-formats/blend/release-notes.spec"
const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")

// The plan of `/task task-formats/blend/release-notes.spec`.
const releaseNotesPlan = Effect.gen(function* () {
  const loaded = yield* Blend.load(path.join(formatDir, "release-notes.spec"))
  expect(loaded.failures).toEqual([])
  if (!loaded.spec) return yield* Effect.die("release-notes.spec did not load")
  return TaskCommand.plan({ spec: loaded.spec, specPath: RELEASE_NOTES, path: RELEASE_NOTES, root: Option.none() })
})

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

// The facts a task's state most likely meets next, so that the folds reach every state.
const LIKELY: Record<string, ReadonlyArray<Kind>> = {
  waiting: ["started"],
  building: ["ready", "ready", "ready", "repeated"],
  proving: ["proved"],
  verifying: ["verified"],
  trusted: ["stale"],
}
// A waiting parent moves on its review proof, not on a start.
const PARENT_WAITING: ReadonlyArray<Kind> = ["proved"]

// One random fact: mostly one that moves the chosen task on, otherwise any fact (unknown ids included).
const randomFact = (plan: Plan, state: State, { next, pick }: Random, at: number): Fact => {
  const task = pick([...plan.tasks.map((item) => item.id), "T7"])
  const own = plan.spec.obligations.filter((item) => item.task === task).map((item) => item.id)
  // `T7` is in no plan.
  const current = Object.hasOwn(state.tasks, task) ? state.tasks[task] : undefined
  const likely = current?.leaf === false && current.state === "waiting" ? PARENT_WAITING : LIKELY[current?.state ?? ""]
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
        id: pick([...plan.scenarios.map((item) => item.id), "S99"]),
        status: next() < 0.8 ? "passed" : "failed",
        reason: maybe("tests failed"),
      }
    case "scenario.verified": {
      const id = pick(plan.scenarios.map((item) => item.id))
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
const moveOf = (plan: Plan, item: State["history"][number]) => {
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

// Until T1.7 and T1.8 rewrite these tests as fact sequences through the snapshot API, they read the engine through
// `view`: this adapter keeps the snapshot behind each `State` it returns. A `State` it did not make has no snapshot.
const snapshots = new WeakMap<State, TaskEngineXState.RunSnapshot>()
const keep = (snapshot: TaskEngineXState.RunSnapshot): State => {
  const state = TaskEngineXState.view(snapshot)
  snapshots.set(state, snapshot)
  return state
}
const snapshotOf = (state: State) => {
  const snapshot = snapshots.get(state)
  if (snapshot === undefined) throw new Error("a State the engine did not make")
  return snapshot
}
const engine = {
  initial: (plan: Plan): State => keep(TaskEngineXState.initial(plan)),
  apply: (plan: Plan, state: State, fact: Fact): State => {
    const before = snapshotOf(state)
    const after = TaskEngineXState.apply(plan, before, fact)
    return after === before ? state : keep(after)
  },
  ended: (state: State) => TaskEngineXState.ended(snapshotOf(state)),
}

describe("XStateEngine on random facts", () => {
  it.live("folds 4,000 random facts without a throw, purely, and reaches the lifecycle's later moves", () =>
    Effect.gen(function* () {
      const plan = yield* releaseNotesPlan
      const moves = new Set<string>()
      let facts = 0
      for (let seed = 1; seed <= 40; seed++) {
        const random = generator(seed)
        let state = engine.initial(plan)
        let run: Fact[] = []
        for (let step = 1; step <= 100; step++) {
          // A run in an end state takes no fact: start a new one.
          if (engine.ended(state)) {
            state = engine.initial(plan)
            run = []
          }
          const fact = randomFact(plan, state, random, step)
          const next = engine.apply(plan, state, fact)
          // History only grows, and a fact that adds none changes nothing: the engine gives back the very state.
          expect(next.history.slice(0, state.history.length)).toStrictEqual([...state.history])
          if (next.history.length === state.history.length) expect(next).toBe(state)
          for (const item of next.history.slice(state.history.length)) moves.add(moveOf(plan, item))
          run = [...run, fact]
          state = next
          facts += 1
        }
        // A resume is the same fold over the stored facts: folding them again gives an equal state.
        expect(run.reduce((acc, fact) => engine.apply(plan, acc, fact), engine.initial(plan))).toStrictEqual(state)
      }
      expect(facts).toBe(4000)
      for (const move of [
        "task:verifying>trusted",
        "task:proving>building",
        "task:verifying>building",
        "task:trusted>proving",
        "task:building>budget_exhausted",
        "obligation:passed>stale",
        "obligation:trusted>stale",
        "obligation:rejected>passed",
        "scenario:verifying>trusted",
        "run:running>done",
        "run:running>cancelled",
      ])
        expect(moves).toContain(move)
    }),
  )
})

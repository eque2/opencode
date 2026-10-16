import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import { createActor } from "@jambudipa/xstate-effect"
import { TaskEvents } from "@/task/core/events"
import type { Fact, Plan, Result, Verdict } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"

// Scenario RM5 (spec task-harness-feedback, spine AD-5 tests (1)-(3), AD-6; task T1.8): a fold, a live actor and a
// resumed actor reach the same snapshot.
//
//   Given 40 seeded sequences of 100 random facts over the release-notes plan, including facts after the run ended
//   When each sequence is folded with apply and also sent to a live actor of the same machine
//   And a prefix is folded, restored into an actor, and sent the rest of the sequence
//   Then the three snapshots are equal for every sequence
//   And the log grows exactly when the state or another context field changes
//
// Each sequence is exactly 100 facts, generated from a seed (mulberry32) and folded from `initial` with `apply`. A
// sequence is not cut when its run ends: every fact after the end goes to the fold, to the live actor and to the
// restored actor. Facts of every stored type occur, and some name ids in no plan (T7, T7.c1, S99). The live actor is
// `createActor(machine(plan))`, started and sent each fact; the restored actor is `createActor(machine, { snapshot })`
// from `machine.getPersistedSnapshot` of the fold of a prefix, sent the rest. All three use the plan's one machine.
//
// The log step is read with the spine's own exception, which this test names and bounds: AD-5 makes a targetless
// row append its note even when it writes nothing else, and the fact table gives `run.resumed` a history entry
// `resumed`. So a second `run.started`, a `run.resumed`, and a `spec.checked` that repeats the warning add one run
// note `from === to` with no other change. Every other step obeys "the log grows exactly when the state or another
// context field changes" both ways, and a step whose log does not grow returns the identical snapshot.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

const SEEDS = 40
const LENGTH = 100
// Each seed folds 100 facts and sends them to two actors on the real machine; a loaded machine takes seconds.
const PER_SEED = 60_000

// The run notes that the spine prescribes with no other change (AD-5 targetless rows, AD-6 fact table).
const NOTES = ["run.started", "run.resumed", "spec.checked"]

// A seeded generator (mulberry32): every run of the test folds the same sequences.
const generator = (seed: number) => {
  let current = seed >>> 0
  const next = () => {
    current = (current + 0x6d2b79f5) | 0
    let t = Math.imul(current ^ (current >>> 15), 1 | current)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(items: ReadonlyArray<T>): T => {
    const item = items[Math.floor(next() * items.length)]
    if (item === undefined) throw new Error("pick from an empty list")
    return item
  }
  return { next, pick }
}
type Random = ReturnType<typeof generator>

const PHASES = ["ready", "building", "proving", "verifying"]
const phaseOf = (snapshot: RunSnapshot, id: string) => PHASES.find((tag) => snapshot.hasTag(`${id}:${tag}`))

// One random fact. Mostly the fact that moves a unit with work in hand (so that runs reach their later moves), at
// times any stored fact type for any task (unknown ids included), and a stop that grows likelier late in the
// sequence, so that most runs end and keep receiving facts after the end.
const randomFact = (plan: Plan, snapshot: RunSnapshot, random: Random, at: number): Fact => {
  const { next, pick } = random
  const taskIds = plan.tasks.map((task) => task.id)
  const working = taskIds.filter((id) => phaseOf(snapshot, id) !== undefined)
  const task = working.length > 0 && next() < 0.85 ? pick(working) : pick([...taskIds, "T7"])
  const own = plan.spec.obligations.filter((item) => item.task === task).map((item) => item.id)
  const leaf = plan.tasks.find((item) => item.id === task)?.children.length === 0
  const phase = phaseOf(snapshot, task)
  const scenarios = plan.scenarios.map((item) => item.id)
  const activeScenarios = scenarios.filter((id) => phaseOf(snapshot, id) !== undefined)
  const outside = Object.keys(plan.spec.outside)
  const stopChance = at > 80 ? 0.15 : at > 55 ? 0.03 : 0.003
  const roll = next()
  if (roll < stopChance)
    return next() < 0.5
      ? { type: "run.cancelled", at, reason: `stop ${at}` }
      : { type: "run.ended", at, state: next() < 0.6 ? "done" : "failed", reason: `ended ${at}` }
  if (roll < stopChance + 0.006) return { type: "task.needs_human", at, task, reason: `quota ${at}` }
  if (roll < stopChance + 0.012) return { type: "task.failed", at, task, reason: `merge conflict ${at}` }
  const proved = (): Fact => ({
    type: "task.proved",
    at,
    task,
    results: own
      .filter(() => next() < 0.92)
      .map((id): Result => {
        const r = next()
        if (r < 0.1) return { id, status: "failed", reason: `red ${at}` }
        return { id, status: r < 0.35 ? "passed" : "needs-judge" }
      }),
    ...(next() < 0.05 ? { reason: `structural ${at}` } : {}),
  })
  const verified = (): Fact => ({
    type: "task.verified",
    at,
    task,
    verdicts: own
      .filter(() => next() < 0.93)
      .map(
        (id): Verdict =>
          next() < 0.88 ? { id, verdict: "trusted" } : { id, verdict: "rejected", reason: `weak ${at}` },
      ),
  })
  const started = (): Fact => ({
    type: "task.started",
    at,
    task,
    worktree: `/wt/${task}`,
    branch: `task/${task}`,
    base: "base",
    session: `ses_${task}`,
  })
  if (roll < 0.7) {
    if (activeScenarios.length > 0 && next() < 0.25) {
      const id = pick(activeScenarios)
      if (phaseOf(snapshot, id) === "verifying")
        return {
          type: "scenario.verified",
          at,
          verdict: next() < 0.85 ? { id, verdict: "trusted" } : { id, verdict: "rejected", reason: `no ${at}` },
        }
      return {
        type: "scenario.proved",
        at,
        id,
        status: next() < 0.85 ? "passed" : "failed",
        ...(next() < 0.3 ? { reason: `tests failed ${at}` } : {}),
      }
    }
    if (phase === "ready") return leaf ? started() : proved()
    if (phase === "building")
      return next() < 0.85
        ? { type: "task.ready", at, task, head: `head${at}` }
        : { type: "task.repeated", at, task, reason: `repetition ${at}` }
    if (phase === "proving") return proved()
    if (phase === "verifying") return verified()
    if (engine.unitState(snapshot, task) === "trusted" && own.length > 0)
      return { type: "obligation.stale", at, id: pick(own), hash: `hash${at}` }
    if (outside.length > 0 && next() < 0.3) return { type: "outside.trusted", at, id: pick(outside) }
  }
  const kind = pick([
    "run.started",
    "run.resumed",
    "outside.trusted",
    "task.started",
    "task.ready",
    "task.proved",
    "task.verified",
    "task.stalled",
    "task.nudged",
    "task.repeated",
    "obligation.stale",
    "spec.checked",
    "scenario.proved",
    "scenario.verified",
  ] as const)
  switch (kind) {
    case "run.started":
      return { type: "run.started", at }
    case "run.resumed":
      return { type: "run.resumed", at }
    case "outside.trusted":
      return { type: "outside.trusted", at, id: pick([...outside, "T1.4", "T7"]) }
    case "task.started":
      return started()
    case "task.ready":
      return { type: "task.ready", at, task, head: `head${at}` }
    case "task.proved":
      return proved()
    case "task.verified":
      return verified()
    case "task.stalled":
      return { type: "task.stalled", at, task, reason: `idle ${at}` }
    case "task.nudged":
      return { type: "task.nudged", at, task, nudge: next() < 0.5 ? 1 : 2, reason: `nudge ${at}` }
    case "task.repeated":
      return { type: "task.repeated", at, task, reason: `repetition ${at}` }
    case "obligation.stale":
      return { type: "obligation.stale", at, id: pick([...own, "T7.c1"]), hash: `hash${at}` }
    case "spec.checked":
      return {
        type: "spec.checked",
        at,
        failures: next() < 0.5 ? [] : [{ rule: "R3", path: "T1.task/TASK.md", message: `fault ${at}` }],
      }
    case "scenario.proved":
      return {
        type: "scenario.proved",
        at,
        id: pick([...scenarios, "S99"]),
        status: next() < 0.8 ? "passed" : "failed",
      }
    default: {
      const id = pick(scenarios)
      return {
        type: "scenario.verified",
        at,
        verdict: next() < 0.8 ? { id, verdict: "trusted" } : { id, verdict: "rejected", reason: `no ${at}` },
      }
    }
  }
}

// The plan and its machine, loaded once: every seed folds through the same memoised machine.
let cached: Plan | undefined
const releaseNotes = Effect.gen(function* () {
  cached ??= yield* loadPlan("release-notes.spec")
  return cached
})

// A sequence of a seed: its 100 facts and the fold's snapshot after each (index 0 is `initial`).
const sequenceOf = (plan: Plan, seed: number) => {
  const random = generator(seed * 7919 + 13)
  const snapshots: Array<RunSnapshot> = [engine.initial(plan)]
  const list: Array<Fact> = []
  for (let at = 1; at <= LENGTH; at++) {
    const before = snapshots[snapshots.length - 1] ?? engine.initial(plan)
    const fact = randomFact(plan, before, random, at)
    list.push(fact)
    snapshots.push(engine.apply(plan, before, fact))
  }
  return { list, snapshots }
}

// The state and every context field but the log, as one comparable text.
const rest = (snapshot: RunSnapshot) => {
  const { log: _, ...others } = snapshot.context
  return JSON.stringify({ status: snapshot.status, value: snapshot.value, context: others })
}

// What the three paths must agree on.
const shape = (snapshot: RunSnapshot) => ({
  status: snapshot.status,
  value: snapshot.value,
  context: snapshot.context,
  tags: [...snapshot.tags].toSorted(),
})

interface Stats {
  readonly seed: number
  readonly types: ReadonlyArray<string>
  readonly ids: ReadonlyArray<string>
  readonly endedAt?: number
  readonly afterEnd: number
  readonly prefix: number
  readonly notes: ReadonlyArray<string>
  readonly changes: number
}
const stats: Array<Stats> = []

for (let seed = 1; seed <= SEEDS; seed++) {
  it.live(
    `[RM5] seed ${seed}: fold, live actor and restored actor agree; the log grows exactly with a change, bar the spine run notes`,
    () =>
      Effect.gen(function* () {
        const plan = yield* releaseNotes
        const machine = TaskMachine.machine(plan)
        const { list, snapshots } = sequenceOf(plan, seed)
        expect(list).toHaveLength(LENGTH)
        const folded = snapshots[LENGTH]
        if (folded === undefined) throw new Error("no fold")
        const endedAt = snapshots.findIndex((snapshot) => engine.ended(snapshot))

        // The log, step by step along the fold.
        const notes: Array<string> = []
        let changes = 0
        let text = rest(snapshots[0] ?? folded)
        for (let index = 1; index <= LENGTH; index++) {
          const before = snapshots[index - 1]
          const after = snapshots[index]
          const fact = list[index - 1]
          if (before === undefined || after === undefined || fact === undefined) throw new Error(`no step ${index}`)
          const nextText = rest(after)
          const changed = nextText !== text
          text = nextText
          const old = before.context.log
          const added = after.context.log.slice(old.length)
          const where = { seed, step: index, fact: fact.type }
          // The log only grows: the old entries stay as they were.
          expect({
            ...where,
            kept: JSON.stringify(after.context.log.slice(0, old.length)) === JSON.stringify(old),
          }).toEqual({ ...where, kept: true })
          if (changed) {
            changes++
            // A change of the state or of another context field appends to the log.
            expect({ ...where, grew: added.length > 0 }).toEqual({ ...where, grew: true })
          } else if (added.length > 0) {
            // No other change, yet the log grew: only the spine's run notes, one entry from a state to itself.
            notes.push(fact.type)
            expect({ ...where, note: NOTES.includes(fact.type) }).toEqual({ ...where, note: true })
            expect(added).toHaveLength(1)
            expect(added[0]).toMatchObject({ unit: "run" })
            expect(added[0]?.from).toBe(added[0]?.to)
          } else {
            // No change and no entry: the identical snapshot.
            expect({ ...where, identical: after === before }).toEqual({ ...where, identical: true })
          }
          // A fact after the run ended changes nothing.
          if (engine.ended(before))
            expect({ ...where, identical: after === before }).toEqual({ ...where, identical: true })
        }

        // The same facts sent to a live actor of the same machine.
        const live = yield* Effect.scoped(
          Effect.gen(function* () {
            const actor = yield* createActor(machine)
            yield* actor.start
            for (const fact of list) yield* actor.send(fact)
            return yield* actor.getSnapshot
          }),
        )
        expect(shape(live)).toEqual(shape(folded))

        // A prefix folded, restored into an actor from its persisted snapshot, and sent the rest. Most prefixes end
        // before the run does; every fourth seed restores a prefix that already holds the end.
        const random = generator(seed * 104729 + 7)
        const last = endedAt > 0 ? endedAt : LENGTH
        const prefix =
          seed % 4 === 0 && endedAt > 0 && endedAt < LENGTH
            ? endedAt + Math.floor(random.next() * (LENGTH - endedAt))
            : 1 + Math.floor(random.next() * Math.max(1, last - 1))
        const half = snapshots[prefix]
        if (half === undefined) throw new Error(`no prefix ${prefix}`)
        const persisted = yield* machine.getPersistedSnapshot(half)
        const restored = yield* Effect.scoped(
          Effect.gen(function* () {
            const actor = yield* createActor(machine, { snapshot: persisted })
            yield* actor.start
            for (const fact of list.slice(prefix)) yield* actor.send(fact)
            return yield* actor.getSnapshot
          }),
        )
        expect(shape(restored)).toEqual(shape(folded))
        expect(shape(restored)).toEqual(shape(live))

        stats.push({
          seed,
          types: list.map((fact) => fact.type),
          ids: list.map((fact) =>
            "task" in fact
              ? fact.task
              : fact.type === "scenario.verified"
                ? fact.verdict.id
                : "id" in fact
                  ? fact.id
                  : "",
          ),
          ...(endedAt > 0 ? { endedAt } : {}),
          afterEnd: endedAt > 0 ? LENGTH - endedAt : 0,
          prefix,
          notes,
          changes,
        })
      }),
    PER_SEED,
  )
}

it.live("[RM5] the 40 sequences hold every fact type, unknown ids and facts after the run ended", () =>
  Effect.gen(function* () {
    // Every seed ran its three paths.
    expect(stats.map((each) => each.seed)).toEqual(Array.from({ length: SEEDS }, (_, index) => index + 1))
    // Every stored fact type occurs, and ids that no plan holds.
    const types = new Set(stats.flatMap((each) => each.types))
    const stored = [
      "run.started",
      "run.resumed",
      "outside.trusted",
      "task.started",
      "task.ready",
      "task.proved",
      "task.verified",
      "task.stalled",
      "task.nudged",
      "task.repeated",
      "task.needs_human",
      "task.failed",
      "obligation.stale",
      "spec.checked",
      "scenario.proved",
      "scenario.verified",
      "run.cancelled",
      "run.ended",
    ]
    expect(stored).toHaveLength(TaskEvents.FactSchema.members.length)
    expect([...types].toSorted()).toEqual(stored.toSorted())
    const ids = new Set(stats.flatMap((each) => each.ids))
    for (const id of ["T7", "T7.c1", "S99"]) expect(ids.has(id)).toBe(true)
    // Most runs end inside their 100 facts and then keep receiving facts.
    const ended = stats.filter((each) => each.endedAt !== undefined)
    expect(ended.length).toBeGreaterThanOrEqual(30)
    expect(stats.reduce((sum, each) => sum + each.afterEnd, 0)).toBeGreaterThan(SEEDS * 5)
    // The restored prefixes: some before the end, some after it.
    expect(ended.filter((each) => each.prefix < (each.endedAt ?? 0)).length).toBeGreaterThanOrEqual(20)
    expect(ended.filter((each) => each.prefix >= (each.endedAt ?? 0)).length).toBeGreaterThanOrEqual(5)
    // The log rule saw real changes on every seed; the spine's run notes are the only growth with no other change.
    for (const each of stats)
      expect({ seed: each.seed, changed: each.changes > 0 }).toEqual({ seed: each.seed, changed: true })
    const notes = stats.flatMap((each) => each.notes)
    for (const note of notes) expect(NOTES).toContain(note)

    // Control: the comparison has power. A restored actor that misses one fact that moved the fold ends elsewhere.
    const plan = yield* releaseNotes
    const machine = TaskMachine.machine(plan)
    const { list, snapshots } = sequenceOf(plan, 1)
    const moved = snapshots.findIndex((snapshot, index) => index > 0 && snapshot !== snapshots[index - 1])
    const from = snapshots[moved - 1]
    if (from === undefined || moved < 1) throw new Error("seed 1 moved nothing")
    const persisted = yield* machine.getPersistedSnapshot(from)
    const skipped = yield* Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* createActor(machine, { snapshot: persisted })
        yield* actor.start
        for (const fact of list.slice(moved)) yield* actor.send(fact)
        return yield* actor.getSnapshot
      }),
    )
    expect(shape(skipped)).not.toEqual(shape(snapshots[LENGTH] ?? from))
  }),
)

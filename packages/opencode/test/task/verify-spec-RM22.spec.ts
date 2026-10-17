import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Predicate } from "effect"
import { createMachine, initialTransition, transition } from "@jambudipa/xstate-effect"
import { getAdjacencyMap } from "@jambudipa/xstate-effect/graph"
import type { Fact, Plan } from "@/task/core/model"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import { TaskAlphabet } from "@/task/engine-xstate/alphabet"
import { type RunConfig, type RunEvent, type RunMachine, TaskMachine } from "@/task/engine-xstate/machine"
import { testEffect } from "../lib/effect"
import { loadPlan } from "./lib/machine"

// Scenario RM22 (spec task-harness-feedback, D5, spine AD-7, owner ruling 4): the walk's reduction and key are sound.
//
//   Given a small plan
//   When the canonical walk and the full walk run with and without the blocked rows
//   Then both walks find the same set of stuck states
//   And the stale walk of the loaded example-cascade plan finds no stuck state
//   And every context path that a guard reads is part of the walk key
//
// Plans come from the real loader (`loadPlan`: `Blend.load` and `TaskCommand.plan`). Walks are the port's
// `getAdjacencyMap` over the real run machine (`TaskMachine.machine(plan)`, totality check included) or over a copy of
// its config with every `always` row whose target is `blocked` removed (the AD-3 cascade), with the engine's progress
// alphabet (`TaskAlphabet.alphabet`) and walk key (`TaskAlphabet.walkKey`). The canonical interleaving gives only the
// first unit, in document order, that has a fact its facts; the full interleaving gives every fact. A stuck state is
// one that is not done and that no walk event moves to another key.
//
// The guard check records at run time what the machine's real guards read: the machine is built from the real config
// with each `TaskMachine.GUARDS` implementation wrapped so that its context is a recording proxy (the guard itself runs
// unchanged), and the walk key is read through the same proxy. Every path that a guard reads must be a path that the
// key reads: for each state, on that state's own context, and over every macrostep.
//
// The stale walk (full interleaving with every staleness, stale key) takes about 3 200 s on this host (task journal
// T1.10, defects D1), so, as in engine-xstate-graph.test.ts, it runs only with TASK_GRAPH_STALE=1. A run without it
// shows that test as skipped, and that step as not proved.

const it = testEffect(NodeServices.layer)
const engine = TaskEngineXState

// Limits: about three times each walk's measured dequeued edges (the port counts edges, not keys).
const LIMIT = { canonical: 900, full: 4_000, stale: 1_100_000 }
const WALK = 120_000
const STALE_WALK = 4 * 3_600_000

const stale =
  process.env.TASK_GRAPH_STALE === "1"
    ? it.live
    : (name: string, ..._rest: ReadonlyArray<unknown>) => test.skip(name, () => {})

// --- the walks -------------------------------------------------------------------------------------------------------

const unitOf = (fact: Fact): string => {
  if ("task" in fact) return fact.task
  if (fact.type === "scenario.verified") return fact.verdict.id
  if ("id" in fact) return fact.id
  return fact.type
}

type Events = (snapshot: RunSnapshot) => ReadonlyArray<Fact>

/** The canonical interleaving: the facts of the first unit, in document order, that has any. */
const canonical: Events = (snapshot) => {
  const all = TaskAlphabet.alphabet(snapshot)
  const first = all[0]
  return first === undefined ? [] : all.filter((fact) => unitOf(fact) === unitOf(first))
}

/** The full interleaving: every fact of the alphabet. */
const full: Events = (snapshot) => TaskAlphabet.alphabet(snapshot)

/** Every staleness: one per obligation whose task is in work or trusted. */
const staleness: Events = (snapshot) =>
  Object.entries(snapshot.context.units)
    .filter(
      ([, slot]) =>
        slot.kind === "obligation" &&
        (snapshot.hasTag(`${slot.task}:active`) || engine.unitState(snapshot, slot.task ?? "") === "trusted"),
    )
    .map(([id]): Fact => ({ type: "obligation.stale", at: TaskAlphabet.AT, id, hash: "stale" }))

const fullStale: Events = (snapshot) => [...full(snapshot), ...staleness(snapshot)]

const isMove = (value: unknown): value is { readonly state: RunSnapshot } =>
  Predicate.isObject(value) && "state" in value

const walk = (
  plan: Plan,
  machine: RunMachine,
  from: RunSnapshot,
  events: Events,
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
    const entries = Object.entries(adjacency)
    const stuck = entries.flatMap(([name, value]) => {
      if (value.state.status === "done") return []
      const moves = Object.values(value.transitions)
        .filter(isMove)
        .some((next) => key(next.state) !== name)
      return moves ? [] : [name]
    })
    return {
      keys: entries.length,
      edges: entries.reduce((sum, [, value]) => sum + Object.keys(value.transitions).length, 0),
      snapshots: entries.map(([, value]) => value.state),
      stuck: stuck.toSorted(),
      statuses: [...new Set(entries.map(([, value]) => String(value.state.status)))].toSorted(),
    }
  })

const isBlockedRow = (row: unknown) => Predicate.isObject(row) && "target" in row && row.target === "blocked"

/** The machine of a copy of the plan's config without the blocked rows (it fails the totality check by design). */
const withoutBlocked = (plan: Plan) =>
  createMachine(
    TaskMachine.mapStates(TaskMachine.config(plan), (node) =>
      Array.isArray(node.always) ? { ...node, always: node.always.filter((row) => !isBlockedRow(row)) } : node,
    ),
    { actions: TaskMachine.ACTIONS, guards: TaskMachine.GUARDS },
  )

// A stuck state's unit configuration: its key without the `dead:` part (the state of the first death, which only the
// outcome's settle rows read, and whose value depends on the order of deaths that the interleaving chooses).
const configurations = (stuck: ReadonlyArray<string>) =>
  [...new Set(stuck.map((name) => name.replace(/\|dead:[^|]*/, "")))].toSorted()

// --- the reduction check ---------------------------------------------------------------------------------------------

for (const name of ["example-cascade.spec", "example-scenarios.spec"])
  it.live(
    `[RM22] on the small plan ${name}, the canonical and the full walk find the same stuck states, with and without the blocked rows`,
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan(name)
        // With the blocked rows: the real machine.
        const machine = TaskMachine.machine(plan)
        const from = engine.initial(plan)
        const canonicalWalk = yield* walk(plan, machine, from, canonical, LIMIT.canonical)
        const fullWalk = yield* walk(plan, machine, from, full, LIMIT.full)
        // Without the blocked rows: the copy.
        const broken = withoutBlocked(plan)
        const [start] = yield* initialTransition(broken)
        const brokenCanonical = yield* walk(plan, broken, start, canonical, LIMIT.canonical)
        const brokenFull = yield* walk(plan, broken, start, full, LIMIT.full)
        console.log(
          `[RM22] ${name}: with rows ${canonicalWalk.keys}/${canonicalWalk.edges} and ${fullWalk.keys}/${fullWalk.edges}` +
            ` keys/edges, 0 stuck expected; without rows ${brokenCanonical.stuck.length} and ${brokenFull.stuck.length}` +
            ` stuck keys, ${configurations(brokenFull.stuck).length} configurations`,
        )
        for (const walked of [canonicalWalk, fullWalk, brokenCanonical, brokenFull])
          expect(walked.statuses).toEqual(["active", "done"])
        // The full walk sees more interleavings than the canonical one.
        expect(fullWalk.keys).toBeGreaterThanOrEqual(canonicalWalk.keys)
        // With the blocked rows: both walks find the same set, and it is empty.
        expect(canonicalWalk.stuck).toEqual([])
        expect(fullWalk.stuck).toEqual(canonicalWalk.stuck)
        // Without them: the canonical walk finds stuck states, and both walks find the same set of stuck
        // configurations. Every stuck key of the canonical walk is a stuck key of the full walk.
        expect(brokenCanonical.stuck.length).toBeGreaterThan(0)
        expect(configurations(brokenCanonical.stuck)).toEqual(configurations(brokenFull.stuck))
        for (const key of brokenCanonical.stuck) expect(brokenFull.stuck).toContain(key)
      }),
    WALK,
  )

// --- the guard reads and the walk key ------------------------------------------------------------------------------

type Reads = Set<string>

// A recording proxy over a copy of `value`: each property read is added to `reads` as its path from the context, and
// each object read is recorded the same way. Function values (array methods) are passed through: their reads of the
// array come back through the proxy.
const record = <T extends object>(value: T, at: ReadonlyArray<string>, reads: Reads): T => {
  const copy: T = Object.assign(Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value)), value)
  const note = (property: string) => {
    const path = [...at, property]
    reads.add(path.join("/"))
    return path
  }
  return new Proxy(copy, {
    get: (target, property, receiver) => {
      const found = Reflect.get(target, property, receiver)
      if (typeof property !== "string" || typeof found === "function" || property === "length") return found
      const path = note(property)
      return Predicate.isObjectOrArray(found) ? record(found, path, reads) : found
    },
    has: (target, property) => {
      if (typeof property === "string") note(property)
      return Reflect.has(target, property)
    },
  })
}

// An array index is one path for every entry.
const general = (path: string) =>
  path
    .split("/")
    .map((part) => (/^\d+$/.test(part) ? "#" : part))
    .join("/")

/** The context paths that the walk key reads on a snapshot. */
const keyReads = (plan: Plan, mode: "main" | "stale", snapshot: RunSnapshot): Reads => {
  const reads: Reads = new Set()
  const context = record(snapshot.context, [], reads)
  const viewed = new Proxy(snapshot, {
    get: (target, property) => (property === "context" ? context : Reflect.get(target, property, target)),
  })
  TaskAlphabet.walkKey(plan, mode)(viewed)
  return reads
}

// What the wrapped guards record: every read (by guard name, over every macrostep), and the reads made on the
// context of `state`, the snapshot a transition starts from.
const makeGuarded = (): { on: boolean; state: RunSnapshot | undefined; own: Reads; all: Map<string, Reads> } => ({
  on: false,
  state: undefined,
  own: new Set(),
  all: new Map(),
})

type Guarded = ReturnType<typeof makeGuarded>

const watch =
  <A extends object, P>(name: string, guard: (args: A, params: P) => boolean, guarded: Guarded) =>
  (args: A, params: P): boolean => {
    const context = "context" in args ? args.context : undefined
    if (!guarded.on || !Predicate.isObject(context)) return guard(args, params)
    const reads: Reads = new Set()
    const result = guard({ ...args, context: record(context, [], reads) }, params)
    const named = guarded.all.get(name) ?? new Set<string>()
    for (const path of reads) named.add(general(path))
    guarded.all.set(name, named)
    // The state's own context: the first microstep of a transition from that state.
    if (Object.is(context, guarded.state?.context)) for (const path of reads) guarded.own.add(path)
    return result
  }

const G = TaskMachine.GUARDS
const watchGuards = (guarded: Guarded) => ({
  firstDead: watch("firstDead", G.firstDead, guarded),
  stopped: watch("stopped", G.stopped, guarded),
  forTask: watch("forTask", G.forTask, guarded),
  result: watch("result", G.result, guarded),
  unproved: watch("unproved", G.unproved, guarded),
  verdict: watch("verdict", G.verdict, guarded),
  proofFailed: watch("proofFailed", G.proofFailed, guarded),
  underBudget: watch("underBudget", G.underBudget, guarded),
  stale: watch("stale", G.stale, guarded),
  scenarioPassed: watch("scenarioPassed", G.scenarioPassed, guarded),
  scenarioProved: watch("scenarioProved", G.scenarioProved, guarded),
  scenarioTrusted: watch("scenarioTrusted", G.scenarioTrusted, guarded),
  scenarioVerified: watch("scenarioVerified", G.scenarioVerified, guarded),
  trusts: watch("trusts", G.trusts, guarded),
})

/** The plan's machine with watched guards: the real config, after the generator's checks. */
const watched = (plan: Plan, guarded: Guarded, built: RunConfig = TaskMachine.config(plan)) =>
  createMachine(TaskMachine.check(plan, built), { actions: TaskMachine.ACTIONS, guards: watchGuards(guarded) })

// The two stops a run can take: not in the progress alphabet, but real facts whose rows read the context.
const STOPS: ReadonlyArray<Fact> = [
  { type: "run.cancelled", at: TaskAlphabet.AT, reason: "walk" },
  { type: "run.ended", at: TaskAlphabet.AT, state: "failed", reason: "walk" },
]

it.live("[RM22] the guards watched here are every guard of the run machine", () =>
  Effect.sync(() => {
    expect(Object.keys(watchGuards(makeGuarded())).toSorted()).toEqual(Object.keys(TaskMachine.GUARDS).toSorted())
  }),
)

for (const [name, root] of [
  ["example-cascade.spec", undefined],
  ["example-scenarios.spec", undefined],
  ["example-outside-run.spec", "T1.2"],
] as const)
  it.live(
    `[RM22] every context path that a guard reads is part of the walk key (${name}${root ? ` ${root}` : ""})`,
    () =>
      Effect.gen(function* () {
        const plan = yield* loadPlan(name, root)
        const guarded = makeGuarded()
        const machine = watched(plan, guarded)
        const [first] = yield* initialTransition(machine)
        // The states: every state the full interleaving reaches, with the guards not yet watched.
        guarded.on = false
        const reached = yield* walk(plan, machine, first, full, LIMIT.full)
        guarded.all.clear()
        guarded.on = true
        const misses: Array<string> = []
        const keyed = { main: new Set<string>(), stale: new Set<string>() }
        let own = 0
        try {
          for (const state of reached.snapshots) {
            if (state.status !== "active") continue
            const main = keyReads(plan, "main", state)
            const staleKey = keyReads(plan, "stale", state)
            for (const path of main) keyed.main.add(general(path))
            for (const path of staleKey) keyed.stale.add(general(path))
            // Each move of the walk (the alphabet; staleness for the stale key) from this state: what the guards read
            // on this state's own context must be read by this state's key.
            const groups: ReadonlyArray<readonly [ReadonlyArray<Fact>, Reads, string]> = [
              [full(state), main, "main"],
              [staleness(state), staleKey, "stale"],
            ]
            for (const [facts, keyPaths, mode] of groups)
              for (const fact of facts) {
                guarded.state = state
                guarded.own = new Set()
                yield* transition(machine, state, fact)
                own += guarded.own.size
                for (const path of guarded.own)
                  if (!keyPaths.has(path)) misses.push(`${mode} key misses ${path} (${fact.type})`)
              }
            // The stops: their rows read the stop, which the key reads once a stop is noted.
            guarded.state = undefined
            for (const fact of STOPS) {
              const [after] = yield* transition(machine, state, fact)
              for (const path of keyReads(plan, "main", after)) keyed.main.add(general(path))
              for (const path of keyReads(plan, "stale", after)) keyed.stale.add(general(path))
            }
          }
        } finally {
          guarded.on = false
          guarded.state = undefined
        }
        const reads = new Map([...guarded.all].map(([guard, paths]) => [guard, [...paths].toSorted()]))
        console.log(
          `[RM22] ${name}${root ? ` ${root}` : ""}: ${reached.keys} states; guard reads`,
          Object.fromEntries(reads),
        )
        // Not vacuous: the guards that read the context were seen reading it, on a state's own context too.
        const every = new Set([...guarded.all.values()].flatMap((paths) => [...paths]))
        expect(every).toContain("log/#/to")
        expect(every).toContain("stop/state")
        expect([...every].some((path) => /^units\/[^/]+\/attempts$/.test(path))).toBe(true)
        expect([...every].some((path) => /^units\/[^/]+\/kind$/.test(path))).toBe(true)
        expect(own).toBeGreaterThan(0)
        // Per state: nothing that a guard read on the state's own context is missing from that state's key.
        expect(misses).toEqual([])
        // Over every macrostep: each path a guard read is a path the key reads (main and stale keys).
        for (const path of every) {
          expect({ path, main: keyed.main.has(path) }).toEqual({ path, main: true })
          expect({ path, stale: keyed.stale.has(path) }).toEqual({ path, stale: true })
        }
      }),
    WALK,
  )

// Run the large walk last so it cannot consume the guard-read checks' time budget.
stale(
  "[RM22] the stale walk of the loaded example-cascade plan (full interleaving with staleness, stale key) finds no stuck state",
  () =>
    Effect.gen(function* () {
      const plan = yield* loadPlan("example-cascade.spec")
      const walked = yield* walk(plan, TaskMachine.machine(plan), engine.initial(plan), fullStale, LIMIT.stale, "stale")
      console.log(`[RM22] stale walk: ${walked.keys} keys, ${walked.edges} edges`)
      expect(walked.stuck).toEqual([])
      expect(walked.statuses).toEqual(["active", "done"])
    }),
  STALE_WALK,
)

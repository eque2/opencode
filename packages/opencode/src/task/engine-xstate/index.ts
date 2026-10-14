import { Effect, Option, Predicate } from "effect"
import { transition, initialTransition } from "@jambudipa/xstate-effect"
import type {
  Fact,
  ObligationModel,
  ObligationState,
  Plan,
  RunState,
  ScenarioModel,
  ScenarioState,
  State,
  TaskModel,
  TaskState,
} from "@/task/core/model"
import {
  CLASS,
  type Cause,
  type Meta,
  type RunMachine,
  type RunSnapshot,
  type Slot,
  TAGS,
  TaskMachine,
} from "./machine"

// The task harness's engine (spine AD-6): a pure fold of the stored facts through the run machine of the plan
// (`./machine`). The runner records each fact; this module folds it into the machine's snapshot and reads the
// snapshot back.
//
// - `initial(plan)` is the machine's first snapshot; `apply(plan, snapshot, fact)` is one pure `transition`. When a
//   fact changes nothing, the port returns the identical snapshot and `apply` returns it. Resume is the same fold
//   over the stored facts of the slice.
// - `apply` returns its input once the run is `done`: a live actor drops events after `done`, but a pure
//   `transition` on a `done` snapshot still runs a microstep. Any other status that is not `active` is a defect
//   (SD-16): a machine error must never become a run that stands still.
// - A snapshot belongs to the machine that made it, so `apply` dies on a snapshot of another plan's machine.
// - The selectors read a snapshot through its tags, its meta and its context; `view` gives the `State` shape that
//   the status projection reads. No function takes a `State` to compute a next state.
// - Cost: about 1–10 ms for a fact on the release-notes plan (the machine checks every eventless row of the units
//   that have not started on each microstep), and tens of ms for `initial`. A fold of a few hundred facts stays
//   near a second, far below a model turn.

export type { RunSnapshot }

/** The harness engine: a pure fold of facts into the run machine's snapshot. */
export interface Engine {
  readonly name: "xstate"
  readonly initial: (plan: Plan) => RunSnapshot
  readonly apply: (plan: Plan, snapshot: RunSnapshot, fact: Fact) => RunSnapshot
}

// The boundary of the synchronous engine: every Effect here is pure and synchronous (no actors, no delays), and a
// failure is a defect of the machine.
const runPure = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(Effect.orDie(effect))

const defect = (message: string): never => Effect.runSync(Effect.die(new Error(message)))

const errorOf = (snapshot: RunSnapshot) =>
  Option.match(Option.fromNullishOr(snapshot.error), {
    onNone: () => "no error",
    onSome: (error) => String(error),
  })

// One first snapshot per plan, as one machine per plan: it is pure, and its first macrostep enters every unit state.
const initials = new WeakMap<Plan, RunSnapshot>()

/** The run's first snapshot: each unit in its first state, after the first macrostep's readiness rows. */
export const initial = (plan: Plan): RunSnapshot => {
  const found = initials.get(plan)
  if (found !== undefined) return found
  const [snapshot] = runPure(initialTransition(TaskMachine.machine(plan)))
  if (snapshot.status !== "active")
    return defect(`the first snapshot of ${plan.path} has status ${snapshot.status}: ${errorOf(snapshot)}`)
  initials.set(plan, snapshot)
  return snapshot
}

/** One fold step on a given machine: the `apply` of a plan's machine, and of a machine a test builds. */
export const applyTo = (machine: RunMachine, snapshot: RunSnapshot, fact: Fact): RunSnapshot => {
  if (snapshot.machine !== machine) return defect("a snapshot of another plan's machine was applied")
  if (snapshot.status === "done") return snapshot
  if (snapshot.status !== "active") return defect(`the run machine has status ${snapshot.status}: ${errorOf(snapshot)}`)
  const [next] = runPure(transition(machine, snapshot, fact))
  if (next.status === "error") return defect(`the run machine failed on ${fact.type}: ${errorOf(next)}`)
  return next
}

/** One fold step. Pure: the same plan, snapshot and fact always give the same snapshot. */
export const apply = (plan: Plan, snapshot: RunSnapshot, fact: Fact): RunSnapshot =>
  applyTo(TaskMachine.machine(plan), snapshot, fact)

export const XStateEngine: Engine = { name: "xstate", initial, apply }

// --- selectors -------------------------------------------------------------------------------------------------------

const isMeta = (value: unknown): value is Meta =>
  Predicate.isObject(value) && "unit" in value && "kind" in value && "state" in value

const metas = (snapshot: RunSnapshot): ReadonlyArray<Meta> => Object.values(snapshot.getMeta()).filter(isMeta)

const natural = new Intl.Collator([], { numeric: true })

/** The status name of a unit's state (`run` for the outcome), from its state's meta. */
export const unitState = (snapshot: RunSnapshot, id: string): string | undefined =>
  metas(snapshot).find((meta) => meta.unit === id)?.state

/** A unit's class tags, in the contract's order. */
export const tags = (snapshot: RunSnapshot, id: string) => TAGS.filter((tag) => snapshot.hasTag(`${id}:${tag}`))

/** What a waiting unit waits on: the dependency of each of its `waits:` tags, in natural order; else nothing. */
export const waitingOn = (snapshot: RunSnapshot, id: string): ReadonlyArray<string> => {
  if (!snapshot.hasTag(`${id}:waiting`)) return []
  const prefix = `${id}:waits:`
  return snapshot.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .toSorted((a, b) => natural.compare(a, b))
}

/** The cause of a blocked unit: the dead dependency its `blocked` row named. */
export const blockedBy = (snapshot: RunSnapshot, id: string): Cause | undefined => {
  if (!snapshot.hasTag(`${id}:blocked`)) return undefined
  return snapshot.context.units[id]?.blockedBy
}

/** Whether the run has ended: its machine is final, so nothing moves any more. */
export const ended = (snapshot: RunSnapshot) => snapshot.status === "done"

// The status name of a state, typed by the names its kind shows in `CLASS`.
const showsIn = <T extends Readonly<Record<string, { readonly shows: string }>>>(states: T, state: string) =>
  Object.entries(states).find(([name]) => name === state)?.[1].shows as T[keyof T]["shows"] | undefined

const optional = (slot: Slot) => ({
  ...(slot.worktree === undefined ? {} : { worktree: slot.worktree }),
  ...(slot.branch === undefined ? {} : { branch: slot.branch }),
  ...(slot.base === undefined ? {} : { base: slot.base }),
  ...(slot.head === undefined ? {} : { head: slot.head }),
  ...(slot.session === undefined ? {} : { session: slot.session }),
  ...(slot.reason === undefined ? {} : { reason: slot.reason }),
})

/** The snapshot as the `State` shape that the status projection and the phase-1 runner read. */
export const view = (snapshot: RunSnapshot): State => {
  const context = snapshot.context
  const units = Object.entries(context.units)
  const run = context.units.run
  const runState: RunState = showsIn(CLASS.run, run?.state ?? "running") ?? "running"
  const tasks = units.flatMap(([id, slot]): ReadonlyArray<[string, TaskModel]> => {
    if (slot.kind !== "task") return []
    const state: TaskState = showsIn(CLASS.task, slot.state) ?? "waiting"
    return [[id, { id, leaf: slot.leaf ?? true, state, attempts: slot.attempts ?? 0, ...optional(slot) }]]
  })
  const obligations = units.flatMap(([id, slot]): ReadonlyArray<[string, ObligationModel]> => {
    if (slot.kind !== "obligation") return []
    const state: ObligationState = showsIn(CLASS.obligation, slot.state) ?? "pending"
    return [
      [
        id,
        {
          id,
          task: slot.task ?? "",
          state,
          hash: slot.hash ?? "",
          ...(slot.reason === undefined ? {} : { reason: slot.reason }),
        },
      ],
    ]
  })
  const scenarios = units.flatMap(([id, slot]): ReadonlyArray<[string, ScenarioModel]> => {
    if (slot.kind !== "scenario") return []
    const state: ScenarioState = showsIn(CLASS.scenario, slot.state) ?? "waiting"
    return [[id, { id, state, ...(slot.reason === undefined ? {} : { reason: slot.reason }) }]]
  })
  return {
    run: {
      state: runState,
      ...(run?.reason === undefined ? {} : { reason: run.reason }),
      spec: context.spec,
      path: context.path,
    },
    tasks: Object.fromEntries(tasks),
    obligations: Object.fromEntries(obligations),
    scenarios: Object.fromEntries(scenarios),
    history: context.log,
  }
}

export * as TaskEngineXState from "."

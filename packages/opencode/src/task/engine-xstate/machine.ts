import { Effect, HashSet, Predicate } from "effect"
import {
  type Guard as PortGuard,
  type StateNodeConfig,
  type TransitionConfig,
  and,
  assign,
  createMachine,
  not,
  or,
  stateIn,
} from "@jambudipa/xstate-effect"
import type { BlendModel } from "@/task/blend/model"
import type { Fact, History, Plan } from "@/task/core/model"

// The run machine (spine AD-1 to AD-5): one xstate machine per plan, generated as plain data, that holds the whole
// run. Its root is parallel with two regions. `active` is parallel too, with one region per unit: each task (an
// `evidence` region with one sub-region per obligation, then `work`), each scenario, each `outside` precondition
// and each folder task outside a subtree run (`external`). `outcome` decides how the run ends.
//
// - Every unit state has the explicit id `<unit id with "." as "_">/<state>`, a `meta` of `{ unit, kind, state }`
//   (`state` is the status-contract name) and tags `<unit>:<tag>` from a closed vocabulary. Guards name states
//   only by these ids, through `stateIn`; the port splits a `#id` on `.`, so ids never hold one.
// - The machine is fold-safe: its actions are `assign` and `raise` with no delay. It has no `after`, `invoke`,
//   `spawn` or custom action, so the pure `transition` runs it exactly as a live actor does.
// - `CLASS` is the definition of every state of every unit kind: its class tags, the name it shows, whether it is
//   final and its phase tag. `DEAD` is the task states that block a dependant. Only this generator reads them.
// - The context keeps what each unit's history needs: its state name, reason, attempts and the facts' fields. A
//   transition's action puts the move's `from` and reason in a slot; the target state's entry action writes it.

export type Kind = "task" | "obligation" | "scenario" | "outside" | "external" | "run"
type ClassTag = "waiting" | "active" | "ended" | "stopped" | "blocked" | "dead"
type PhaseTag = "ready" | "building" | "proving" | "verifying"

/** One state of a unit kind: its class tags, its status name, whether it is final, and its phase tag. */
interface StateClass {
  readonly tags: ReadonlyArray<ClassTag>
  readonly shows: string
  readonly final: boolean
  readonly phase?: PhaseTag
  /** The name its history entries use, when it differs from `shows`. */
  readonly logs?: string
}

/** The class of every state of every unit kind (spine AD-2, AD-13). The order is the state order of each region. */
export const CLASS = {
  task: {
    waiting: { tags: ["waiting"], shows: "waiting", final: false },
    ready: { tags: ["waiting"], shows: "waiting", final: false, phase: "ready" },
    building: { tags: ["active"], shows: "building", final: false, phase: "building" },
    proving: { tags: ["active"], shows: "proving", final: false, phase: "proving" },
    verifying: { tags: ["active"], shows: "verifying", final: false, phase: "verifying" },
    judging: { tags: ["active"], shows: "verifying", final: false, phase: "verifying" },
    trusted: { tags: ["ended"], shows: "trusted", final: true },
    needs_human: { tags: ["ended", "stopped", "dead"], shows: "needs_human", final: true },
    budget_exhausted: { tags: ["ended", "stopped", "dead"], shows: "budget_exhausted", final: true },
    failed: { tags: ["ended", "stopped", "dead"], shows: "failed", final: true },
    blocked: { tags: ["ended", "stopped", "blocked"], shows: "blocked", final: true },
    cancelled: { tags: ["ended", "stopped"], shows: "cancelled", final: true },
  },
  obligation: {
    pending: { tags: ["waiting"], shows: "pending", final: true },
    passed: { tags: ["active"], shows: "passed", final: true },
    failed: { tags: ["active"], shows: "failed", final: true },
    trusted: { tags: ["ended"], shows: "trusted", final: true },
    rejected: { tags: ["active"], shows: "rejected", final: true },
    stale: { tags: ["waiting"], shows: "stale", final: true },
  },
  scenario: {
    waiting: { tags: ["waiting"], shows: "waiting", final: false },
    ready: { tags: ["active"], shows: "pending", final: false, phase: "ready", logs: "waiting" },
    parked: { tags: ["waiting"], shows: "waiting", final: true },
    verifying: { tags: ["active"], shows: "pending", final: false, phase: "verifying" },
    trusted: { tags: ["ended"], shows: "trusted", final: true },
    rejected: { tags: ["ended", "stopped"], shows: "rejected", final: true },
    failed: { tags: ["ended", "stopped"], shows: "failed", final: true },
    blocked: { tags: ["ended", "stopped", "blocked"], shows: "blocked", final: true },
    cancelled: { tags: ["ended", "stopped"], shows: "cancelled", final: true },
  },
  outside: {
    untrusted: { tags: ["waiting"], shows: "untrusted", final: true },
    trusted: { tags: ["ended"], shows: "trusted", final: true },
  },
  external: {
    untrusted: { tags: ["waiting"], shows: "untrusted", final: true },
    trusted: { tags: ["ended"], shows: "trusted", final: true },
  },
  run: {
    running: { tags: ["active"], shows: "running", final: false },
    waiting: { tags: ["waiting"], shows: "waiting", final: false },
    done: { tags: ["ended"], shows: "done", final: true },
    failed: { tags: ["ended", "stopped"], shows: "failed", final: true },
    needs_human: { tags: ["ended", "stopped"], shows: "needs_human", final: true },
    budget_exhausted: { tags: ["ended", "stopped"], shows: "budget_exhausted", final: true },
    cancelled: { tags: ["ended", "stopped"], shows: "cancelled", final: true },
  },
} as const satisfies Record<Kind, Record<string, StateClass>>

/** The task states that block a dependant (spine AD-3), in the order of its `blocked` rows. */
export const DEAD = ["needs_human", "budget_exhausted", "failed", "blocked"] as const

export type TaskWork = keyof typeof CLASS.task
export type ScenarioPhase = keyof typeof CLASS.scenario
export type OutcomeState = keyof typeof CLASS.run

// --- the context ---------------------------------------------------------------------------------------------------

export interface Cause {
  readonly id: string
  readonly state: string
}

export interface Span {
  readonly state: string
  readonly from: number
  readonly to?: number
}

/** What the context keeps of one unit. Only this machine's actions write it. */
export interface Slot {
  readonly kind: Kind
  /** The status name of the unit's state: its state's `meta.state`. */
  readonly state: string
  /** An obligation's task. */
  readonly task?: string
  readonly reason?: string
  readonly blockedBy?: Cause
  readonly startedAt?: number
  readonly endedAt?: number
  /** A task's returns to the builder: 1 for the first build; a parent stays 0 until reviewed, then 1. */
  readonly attempts?: number
  readonly worktree?: string
  readonly branch?: string
  readonly base?: string
  readonly head?: string
  readonly session?: string
  /** An obligation's unit hash. */
  readonly hash?: string
  readonly spans?: ReadonlyArray<Span>
}

/** A move that a transition started and the target state's entry action writes. */
interface Move {
  readonly from?: string
  readonly reason?: string
  readonly blockedBy?: Cause
}

export interface RunContext {
  readonly units: Readonly<Record<string, Slot>>
  readonly moves: Readonly<Record<string, Move>>
  readonly log: ReadonlyArray<History>
}

/** The machine's events: the stored facts, and the event `active` raises when every unit region is final. */
export type RunEvent = Fact | { readonly type: "run.settled" }

const RUN = "run"

// --- reads shared by guards and actions ----------------------------------------------------------------------------

/** The time of an event: its own `at`, or for a raised or done event, which has none, the last history entry's. */
const atOf = (context: RunContext, event: RunEvent): number | undefined => {
  if ("at" in event) return event.at
  return context.log.at(-1)?.at
}

const joined = (parts: ReadonlyArray<string | undefined>) => {
  const text = parts.filter((part): part is string => part !== undefined && part !== "").join("; ")
  if (text === "") return undefined
  return text
}

const slotOf = (context: RunContext, unit: string): Slot => context.units[unit] ?? { kind: "task", state: "waiting" }

const obligationsOf = (context: RunContext, task: string) =>
  Object.entries(context.units).filter(([, slot]) => slot.kind === "obligation" && slot.task === task)

// The reason a unit's new state carries, from the fact and the context after the fact's other moves.
const reasonOf = (context: RunContext, event: RunEvent, unit: string, to: string): string | undefined => {
  const slot = slotOf(context, unit)
  if (slot.kind === "obligation") {
    if (to === "failed" && event.type === "task.proved")
      return event.results.find((result) => result.id === unit)?.reason
    if (to === "rejected" && event.type === "task.verified")
      return event.verdicts.find((verdict) => verdict.id === unit)?.reason
    return undefined
  }
  if (slot.kind === "scenario") {
    if (to === "failed" && event.type === "scenario.proved") return event.reason
    if (to === "rejected" && event.type === "scenario.verified") return event.verdict.reason
    if (to === "cancelled" && (event.type === "run.cancelled" || event.type === "run.ended")) return event.reason
    return undefined
  }
  if (slot.kind === "outside" || slot.kind === "external") return slot.kind
  switch (event.type) {
    case "task.proved": {
      if (to === "verifying") return undefined
      const failures = event.results.filter((result) => result.status === "failed")
      return joined([event.reason, ...failures.map((result) => `${result.id}: ${result.reason ?? "failed"}`)])
    }
    case "task.verified":
      if (to === "trusted") return undefined
      return joined(
        obligationsOf(context, unit)
          .filter(([, obligation]) => obligation.state !== "trusted")
          .map(([id, obligation]) =>
            obligation.state === "rejected" ? `${id}: ${obligation.reason ?? "rejected"}` : `${id}: not judged`,
          ),
      )
    case "obligation.stale":
      return `stale: ${event.id}`
    case "task.stalled":
    case "task.repeated":
    case "task.needs_human":
    case "task.failed":
    case "run.cancelled":
    case "run.ended":
      return event.reason
    default:
      return undefined
  }
}

const withUnit = (context: RunContext, unit: string, change: Partial<Slot>) => ({
  ...context.units,
  [unit]: { ...slotOf(context, unit), ...change },
})

const entryOf = (
  at: number,
  unit: string,
  from: string | undefined,
  to: string,
  reason: string | undefined,
): History => ({
  at,
  unit,
  ...(from === undefined ? {} : { from }),
  to,
  ...(reason === undefined ? {} : { reason }),
})

// --- guards and actions ---------------------------------------------------------------------------------------------

interface UnitParams {
  readonly unit: string
}

/** The params of a unit state's entry action: its status name and the name its history entries use. */
interface EnterParams extends UnitParams {
  readonly state: string
  readonly logs: string
}

interface MoveParams extends UnitParams {
  readonly from?: string
  readonly to: string
}

/** The machine's actions: `assign` and `raise` only, each a named implementation that the config refers to. */
export const ACTIONS = {
  /** A unit state's entry: its state name, and the move a transition started, written to the history. */
  enter: assign<RunContext, RunEvent, EnterParams, RunEvent>(({ context, event }, params) => {
    const move = context.moves[params.unit]
    const units = withUnit(context, params.unit, {
      state: params.state,
      ...(move === undefined ? {} : { reason: move.reason, blockedBy: move.blockedBy }),
    })
    if (move === undefined) return { units }
    const { [params.unit]: _, ...moves } = context.moves
    const at = atOf(context, event)
    if (at === undefined) return { units, moves }
    return { units, moves, log: [...context.log, entryOf(at, params.unit, move.from, params.logs, move.reason)] }
  }),
  /** A transition's move: its `from` and reason, for the target state's entry action. */
  move: assign<RunContext, RunEvent, MoveParams, RunEvent>(({ context, event }, params) => ({
    moves: {
      ...context.moves,
      [params.unit]: { from: params.from, reason: reasonOf(context, event, params.unit, params.to) },
    },
  })),
  /** A move that stays in its state (a stall, a repetition, a second failure): it writes its own entry. */
  again: assign<RunContext, RunEvent, EnterParams, RunEvent>(({ context, event }, params) => {
    const reason = reasonOf(context, event, params.unit, params.state)
    const units = withUnit(context, params.unit, { reason })
    const at = atOf(context, event)
    if (at === undefined) return { units }
    return { units, log: [...context.log, entryOf(at, params.unit, params.logs, params.logs, reason)] }
  }),
  start: assign<RunContext, RunEvent, UnitParams, RunEvent>(({ context, event }, params) => {
    if (event.type !== "task.started") return {}
    const { worktree, branch, base, session } = event
    return { units: withUnit(context, params.unit, { attempts: 1, worktree, branch, base, session }) }
  }),
  ready: assign<RunContext, RunEvent, UnitParams, RunEvent>(({ context, event }, params) => {
    if (event.type !== "task.ready") return {}
    return { units: withUnit(context, params.unit, { head: event.head }) }
  }),
  /** A return to the builder. */
  retry: assign<RunContext, RunEvent, UnitParams, RunEvent>(({ context }, params) => ({
    units: withUnit(context, params.unit, { attempts: (slotOf(context, params.unit).attempts ?? 0) + 1 }),
  })),
  /** A parent counts its one review. */
  reviewed: assign<RunContext, RunEvent, UnitParams, RunEvent>(({ context }, params) => ({
    units: withUnit(context, params.unit, { attempts: 1 }),
  })),
  rehash: assign<RunContext, RunEvent, UnitParams, RunEvent>(({ context, event }, params) => {
    if (event.type !== "obligation.stale") return {}
    return { units: withUnit(context, params.unit, { hash: event.hash }) }
  }),
}

interface IdParams {
  readonly id: string
}

type Facts = { readonly event: RunEvent }

const GUARDS = {
  /** The fact names this task. */
  forTask: ({ event }: Facts, params: IdParams) => "task" in event && event.task === params.id,
  /** A proof result of the obligation has this status. */
  result: ({ event }: Facts, params: IdParams & { readonly status: string }) =>
    event.type === "task.proved" &&
    event.results.some((result) => result.id === params.id && result.status === params.status),
  /** A proof round gave the obligation (a parent's review) no result: it waits for the reviewer. */
  unproved: ({ event }: Facts, params: IdParams) =>
    event.type === "task.proved" && !event.results.some((result) => result.id === params.id),
  verdict: ({ event }: Facts, params: IdParams & { readonly verdict: string }) =>
    event.type === "task.verified" &&
    event.verdicts.some((verdict) => verdict.id === params.id && verdict.verdict === params.verdict),
  /** A proof result failed: a leaf goes back to the builder. */
  proofFailed: ({ event }: Facts) =>
    event.type === "task.proved" && event.results.some((result) => result.status === "failed"),
  underBudget: ({ context }: { readonly context: RunContext }, params: IdParams & { readonly budget: number }) =>
    (slotOf(context, params.id).attempts ?? 0) < params.budget,
  /** The staleness fact names this obligation. */
  stale: ({ event }: Facts, params: IdParams) => event.type === "obligation.stale" && event.id === params.id,
  scenarioPassed: ({ event }: Facts, params: IdParams) =>
    event.type === "scenario.proved" && event.id === params.id && event.status === "passed",
  scenarioProved: ({ event }: Facts, params: IdParams) => event.type === "scenario.proved" && event.id === params.id,
  scenarioTrusted: ({ event }: Facts, params: IdParams) =>
    event.type === "scenario.verified" && event.verdict.id === params.id && event.verdict.verdict === "trusted",
  scenarioVerified: ({ event }: Facts, params: IdParams) =>
    event.type === "scenario.verified" && event.verdict.id === params.id,
  /** `/task trust` (or the start-up step of a subtree run) names this region. */
  trusts: ({ event }: Facts, params: IdParams) => event.type === "outside.trusted" && event.id === params.id,
}

// --- the config ----------------------------------------------------------------------------------------------------

const natural = new Intl.Collator([], { numeric: true })
const byId = (a: string, b: string) => natural.compare(a, b)

/** A unit id as xstate holds it: `.` becomes `_`. */
export const key = (id: string) => id.replaceAll(".", "_")

/** The explicit id of a unit state. */
export const stateId = (unit: string, state: string) => `${key(unit)}/${state}`

const at = (unit: string, state: string): Guard => stateIn<RunContext, RunEvent>(`#${stateId(unit, state)}`)

/** A unit state's meta: its unit, the unit's kind, and the status name of the state. */
export interface Meta {
  readonly unit: string
  readonly kind: Kind
  readonly state: string
}

type Guard = PortGuard<RunContext, RunEvent>
type Named = { readonly type: keyof typeof GUARDS; readonly params: object }
type Action = { readonly type: keyof typeof ACTIONS; readonly params: object }
type Row = TransitionConfig<RunContext, RunEvent, Meta>
type StateNode = StateNodeConfig<RunContext, RunEvent, Meta>

const named = (type: keyof typeof GUARDS, params: object): Named => ({ type, params })

type Rows = { readonly on?: Readonly<Record<string, ReadonlyArray<Row>>>; readonly always?: ReadonlyArray<Row> }

/** The class of a state of a kind; every state the generator names is in `CLASS`. */
const classOf = (kind: Kind, state: string): StateClass => {
  const states: Readonly<Record<string, StateClass>> = CLASS[kind]
  return states[state] ?? { tags: [], shows: state, final: false }
}

const enter = (unit: string, def: StateClass): Action => ({
  type: "enter",
  params: { unit, state: def.shows, logs: def.logs ?? def.shows },
})

/** A unit state node: its id, meta, tags and entry action, with its rows. */
const unitState = (
  unit: string,
  kind: Kind,
  state: string,
  rows: Rows,
  extraTags: ReadonlyArray<string>,
): StateNode => {
  const def = classOf(kind, state)
  return {
    id: stateId(unit, state),
    ...(def.final ? { type: "final" } : {}),
    meta: { unit, kind, state: def.shows },
    tags: [...def.tags.map((tag) => `${unit}:${tag}`), ...(def.phase ? [`${unit}:${def.phase}`] : []), ...extraTags],
    entry: [enter(unit, def)],
    ...(rows.on === undefined ? {} : { on: rows.on }),
    ...(rows.always === undefined ? {} : { always: rows.always }),
  }
}

/** A unit's region: every state of its kind in `CLASS` order, with the rows the table gives it. */
const unitRegion = (
  unit: string,
  kind: Kind,
  initial: string,
  table: Readonly<Record<string, Rows>>,
  extraTags: (state: string) => ReadonlyArray<string> = () => [],
): StateNode => ({
  initial,
  states: Object.fromEntries(
    Object.keys(CLASS[kind]).map((state) => [
      state,
      unitState(unit, kind, state, table[state] ?? {}, extraTags(state)),
    ]),
  ),
})

const move = (unit: string, from: string, to: string): Action => ({ type: "move", params: { unit, from, to } })
/** A region's trust: its history entry names no `from`, as the trust entry always has. */
const trust = (unit: string): Action => ({ type: "move", params: { unit, to: "trusted" } })
const again = (unit: string, kind: Kind, state: string): Action => {
  const shows = classOf(kind, state).shows
  return { type: "again", params: { unit, state: shows, logs: shows } }
}

// One obligation of a task. Its rows take the task's proof and verdict facts only while the task is in a proof
// round (`proof`) or in verification.
const obligationRegion = (obligation: BlendModel.Obligation, proof: Guard, review: boolean): StateNode => {
  const id = obligation.id
  const task = obligation.task
  const verification = at(task, "verifying")
  const result = (status: string) => and([proof, named("result", { id, status })])
  const to = (from: string, target: string): Row => ({ target, actions: [move(id, from, target)] })
  const fail = (from: string): Row => ({ guard: result("failed"), ...to(from, "failed") })
  const pass = (from: string): Row => ({ guard: result("passed"), ...to(from, "trusted") })
  const judge = (from: string): Row => ({ guard: result("needs-judge"), ...to(from, "passed") })
  const unproved = (from: string): ReadonlyArray<Row> =>
    review ? [{ guard: and([proof, named("unproved", { id })]), ...to(from, "passed") }] : []
  const verdicts = (from: string): ReadonlyArray<Row> => [
    { guard: and([verification, named("verdict", { id, verdict: "trusted" })]), ...to(from, "trusted") },
    from === "rejected"
      ? {
          guard: and([verification, named("verdict", { id, verdict: "rejected" })]),
          actions: [again(id, "obligation", "rejected")],
        }
      : { guard: and([verification, named("verdict", { id, verdict: "rejected" })]), ...to(from, "rejected") },
  ]
  const stale = (from: string): ReadonlyArray<Row> => [
    {
      guard: named("stale", { id }),
      target: "stale",
      actions: [{ type: "rehash", params: { unit: id } }, move(id, from, "stale")],
    },
  ]
  const refail: Row = { guard: result("failed"), actions: [again(id, "obligation", "failed")] }
  const table: Readonly<Record<keyof typeof CLASS.obligation, Readonly<Record<string, ReadonlyArray<Row>>>>> = {
    pending: {
      "task.proved": [fail("pending"), pass("pending"), judge("pending"), ...unproved("pending")],
      "task.verified": verdicts("pending"),
    },
    passed: {
      "task.proved": [fail("passed"), pass("passed")],
      "task.verified": verdicts("passed"),
      "obligation.stale": stale("passed"),
    },
    failed: { "task.proved": [refail, pass("failed"), judge("failed")], "task.verified": verdicts("failed") },
    trusted: { "task.proved": [fail("trusted")], "obligation.stale": stale("trusted") },
    rejected: {
      "task.proved": [fail("rejected"), pass("rejected"), judge("rejected")],
      "task.verified": verdicts("rejected"),
    },
    stale: {
      "task.proved": [fail("stale"), pass("stale"), judge("stale"), ...unproved("stale")],
      "task.verified": verdicts("stale"),
    },
  }
  return unitRegion(id, "obligation", "pending", {
    pending: { on: table.pending },
    passed: { on: table.passed },
    failed: { on: table.failed },
    trusted: { on: table.trusted },
    rejected: { on: table.rejected },
    stale: { on: table.stale },
  })
}

// The work of one task: its own state, from waiting to an end state.
const workRegion = (
  plan: Plan,
  task: BlendModel.Task,
  obligations: ReadonlyArray<BlendModel.Obligation>,
): StateNode => {
  const id = task.id
  const leaf = task.children.length === 0
  const budget = plan.budget(id)
  const mine = named("forTask", { id })
  const fact = (guard?: Guard): Guard => (guard === undefined ? mine : and([mine, guard]))
  const to = (from: string, target: string, ...actions: ReadonlyArray<Action>): Row => ({
    target,
    actions: [...actions, move(id, from, target)],
  })
  const halts = (from: string) => ({
    "task.needs_human": [{ guard: mine, ...to(from, "needs_human") }],
    "task.failed": [{ guard: mine, ...to(from, "failed") }],
  })
  const underBudget = named("underBudget", { id, budget })
  const retry: Action = { type: "retry", params: { unit: id } }
  const allTrusted = and(obligations.map((obligation) => at(obligation.id, "trusted")))
  const staleRows = obligations.map(
    (obligation): Row => ({
      guard: and([
        named("stale", { id: obligation.id }),
        or([at(obligation.id, "passed"), at(obligation.id, "trusted")]),
      ]),
      ...to("trusted", "proving"),
    }),
  )
  const rows: Readonly<Record<TaskWork, Rows>> = {
    waiting: { on: { "task.failed": [{ guard: mine, ...to("waiting", "failed") }] } },
    ready: {
      on: {
        ...(leaf
          ? { "task.started": [{ guard: mine, ...to("waiting", "building", { type: "start", params: { unit: id } }) }] }
          : { "task.proved": [{ guard: mine, ...to("waiting", "verifying") }] }),
        "task.failed": [{ guard: mine, ...to("waiting", "failed") }],
      },
    },
    building: {
      on: {
        "task.ready": [{ guard: mine, ...to("building", "proving", { type: "ready", params: { unit: id } }) }],
        // The supervisor cut the stream and prompts the same attempt again.
        "task.stalled": [{ guard: mine, actions: [again(id, "task", "building")] }],
        "task.repeated": [
          { guard: fact(underBudget), actions: [retry, again(id, "task", "building")] },
          { guard: mine, ...to("building", "budget_exhausted") },
        ],
        ...halts("building"),
      },
    },
    proving: {
      on: {
        "task.proved": [
          ...(leaf
            ? [
                { guard: fact(and([named("proofFailed", {}), underBudget])), ...to("proving", "building", retry) },
                {
                  guard: fact(and([named("proofFailed", {}), not(underBudget)])),
                  ...to("proving", "budget_exhausted"),
                },
              ]
            : []),
          { guard: mine, ...to("proving", "verifying") },
        ],
        ...halts("proving"),
      },
    },
    verifying: { on: { "task.verified": [{ guard: mine, target: "judging" }], ...halts("verifying") } },
    // The verdicts have moved the obligations: decide on the obligations after them.
    judging: {
      always: leaf
        ? [
            { guard: allTrusted, ...to("verifying", "trusted") },
            { guard: underBudget, ...to("verifying", "building", retry) },
            { ...to("verifying", "budget_exhausted") },
          ]
        : [
            { guard: allTrusted, ...to("verifying", "trusted", { type: "reviewed", params: { unit: id } }) },
            // A parent is never rebuilt.
            { ...to("verifying", "failed") },
          ],
    },
    trusted: staleRows.length === 0 ? {} : { on: { "obligation.stale": staleRows } },
    needs_human: {},
    budget_exhausted: {},
    failed: {},
    blocked: {},
    cancelled: {},
  }
  return unitRegion(id, "task", "waiting", rows)
}

const taskRegion = (plan: Plan, task: BlendModel.Task): StateNode => {
  const obligations = plan.spec.obligations.filter((obligation) => obligation.task === task.id)
  const leaf = task.children.length === 0
  // A leaf proves in `proving`; a parent's review proof comes in `ready`, and a stale one in `proving`.
  const proof = leaf ? at(task.id, "proving") : or([at(task.id, "ready"), at(task.id, "proving")])
  const evidence: ReadonlyArray<[string, StateNode]> =
    obligations.length === 0
      ? []
      : [
          [
            "evidence",
            {
              type: "parallel",
              states: Object.fromEntries(
                obligations.map((obligation) => [
                  key(obligation.id),
                  obligationRegion(obligation, proof, !leaf && obligation.proof.kind === "review"),
                ]),
              ),
            },
          ],
        ]
  return { type: "parallel", states: Object.fromEntries([...evidence, ["work", workRegion(plan, task, obligations)]]) }
}

const scenarioRegion = (scenario: BlendModel.Scenario): StateNode => {
  const id = scenario.id
  const to = (from: string, target: string): Row => ({ target, actions: [move(id, from, target)] })
  const rows: Readonly<Record<ScenarioPhase, Rows>> = {
    waiting: {},
    ready: {
      on: {
        "scenario.proved": [
          { guard: named("scenarioPassed", { id }), ...to("waiting", "verifying") },
          { guard: named("scenarioProved", { id }), ...to("waiting", "failed") },
        ],
      },
    },
    parked: {},
    verifying: {
      on: {
        "scenario.verified": [
          { guard: named("scenarioTrusted", { id }), ...to("pending", "trusted") },
          { guard: named("scenarioVerified", { id }), ...to("pending", "rejected") },
        ],
      },
    },
    trusted: {},
    rejected: {},
    failed: {},
    blocked: {},
    cancelled: {},
  }
  return unitRegion(id, "scenario", "waiting", rows)
}

/** An `outside` precondition or a folder task outside a subtree run: untrusted until a fact trusts it. */
const trustRegion = (id: string, kind: "outside" | "external"): StateNode =>
  unitRegion(id, kind, "untrusted", {
    untrusted: {
      on: { "outside.trusted": [{ guard: named("trusts", { id }), target: "trusted", actions: [trust(id)] }] },
    },
  })

const outcomeRegion = (): StateNode => unitRegion(RUN, "run", "running", {})

/** The first context: every unit in its region's first state. */
const firstContext = (plan: Plan): RunContext => {
  const ids = plan.tasks.map((task) => task.id)
  const slots: ReadonlyArray<[string, Slot]> = [
    ...plan.tasks.map((task): [string, Slot] => [task.id, { kind: "task", state: "waiting", attempts: 0 }]),
    ...plan.spec.obligations
      .filter((obligation) => ids.includes(obligation.task))
      .map((obligation): [string, Slot] => [
        obligation.id,
        { kind: "obligation", state: "pending", task: obligation.task, hash: obligation.hash },
      ]),
    ...plan.scenarios.map((scenario): [string, Slot] => [scenario.id, { kind: "scenario", state: "waiting" }]),
    ...Object.keys(plan.spec.outside).map((id): [string, Slot] => [id, { kind: "outside", state: "untrusted" }]),
    ...plan.external.map((id): [string, Slot] => [id, { kind: "external", state: "untrusted" }]),
    [RUN, { kind: "run", state: "running" }],
  ]
  return { units: Object.fromEntries(slots), moves: {}, log: [] }
}

/** The regions of `active`, keyed by unit: tasks, scenarios, `outside` preconditions, external folder tasks. */
const regionsOf = (plan: Plan): ReadonlyArray<readonly [string, string, StateNode]> => [
  ...plan.tasks.map((task) => [task.id, key(task.id), taskRegion(plan, task)] as const),
  ...plan.scenarios
    .toSorted((a, b) => byId(a.id, b.id))
    .map((scenario) => [scenario.id, key(scenario.id), scenarioRegion(scenario)] as const),
  ...Object.keys(plan.spec.outside)
    .toSorted(byId)
    .map((id) => [id, key(id), trustRegion(id, "outside")] as const),
  ...plan.external.toSorted(byId).map((id) => [id, key(id), trustRegion(id, "external")] as const),
]

/** The machine config of a plan, as plain data. */
export const config = (plan: Plan) => ({
  id: "run",
  type: "parallel" as const,
  options: { maxIterations: 1000 },
  context: firstContext(plan),
  states: {
    active: {
      type: "parallel" as const,
      states: Object.fromEntries(regionsOf(plan).map(([, region, node]) => [region, node])),
    },
    outcome: outcomeRegion(),
  },
})

export type RunConfig = ReturnType<typeof config>

// --- the generator's checks ------------------------------------------------------------------------------------------

/** A broken invariant of a generated machine: a defect, never a run that freezes. */
const defect = (message: string): never => Effect.runSync(Effect.die(new Error(message)))

type Plain = { readonly [key: string]: unknown }
const isPlain = (value: unknown): value is Plain => Predicate.isObject(value)
const listOf = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : value === undefined ? [] : [value]

// Every state node of a config, depth first.
const nodesOf = (node: Plain): ReadonlyArray<Plain> => [
  node,
  ...Object.values(isPlain(node.states) ? node.states : {}).flatMap((child) => (isPlain(child) ? nodesOf(child) : [])),
]

// Every transition row of a state node: its event rows, its eventless rows and its done row.
const rowsOf = (node: Plain): ReadonlyArray<Plain> =>
  [
    ...Object.values(isPlain(node.on) ? node.on : {}).flatMap(listOf),
    ...listOf(node.always),
    ...listOf(node.onDone),
  ].filter(isPlain)

// Every `stateIn` id a guard names.
const stateIds = (guard: unknown): ReadonlyArray<string> => {
  if (!isPlain(guard) || !isPlain(guard.params)) return []
  const params = guard.params
  if (guard.type === "xstate.stateIn" && typeof params.stateValue === "string")
    return [params.stateValue.replace(/^#/, "")]
  if (Array.isArray(params.guards)) return params.guards.flatMap(stateIds)
  return stateIds(params.guard)
}

/**
 * Checks a config before any run: every unit key and explicit id is unique, and every `stateIn` id names a node.
 * The port keeps the last of two equal ids without a warning, and a guard on an unknown id gives an `error` snapshot,
 * so each is a defect here.
 */
export const check = (plan: Plan, built: RunConfig) => {
  if (plan.tasks.length === 0) return defect(`${plan.spec.id}: the plan has no task, so a run of it could never end`)
  const units = regionsOf(plan)
  const keys = units.map(([, region]) => region)
  const clash = keys.find((region, index) => keys.indexOf(region) !== index)
  if (clash !== undefined)
    return defect(
      `duplicate unit ${clash}: ${units
        .filter(([, region]) => region === clash)
        .map(([id]) => id)
        .join(", ")}`,
    )
  const nodes = nodesOf(built)
  const ids = nodes.flatMap((node) => (typeof node.id === "string" ? [node.id] : []))
  const twice = ids.find((id, index) => ids.indexOf(id) !== index)
  if (twice !== undefined) return defect(`duplicate state id ${twice}`)
  const known = HashSet.fromIterable(ids)
  const unknown = nodes
    .flatMap(rowsOf)
    .flatMap((row) => stateIds(row.guard))
    .find((id) => !HashSet.has(known, id))
  if (unknown !== undefined) return defect(`a guard names the unknown state id ${unknown}`)
  return built
}

/** The machine of a config, after its checks. */
export const fromConfig = (plan: Plan, built: RunConfig) =>
  createMachine(check(plan, built), { actions: ACTIONS, guards: GUARDS })

export type RunMachine = ReturnType<typeof fromConfig>

// One machine per plan: a snapshot's nodes belong to the machine that made it, so every reader shares this one.
const machines = new WeakMap<Plan, RunMachine>()

/** The run machine of a plan, built once per plan. */
export const machine = (plan: Plan): RunMachine => {
  const found = machines.get(plan)
  if (found !== undefined) return found
  const made = fromConfig(plan, config(plan))
  machines.set(plan, made)
  return made
}

export * as TaskMachine from "./machine"

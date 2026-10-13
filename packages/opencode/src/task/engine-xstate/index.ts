import { Effect } from "effect"
import { and, assign, getInitialSnapshot, not, or, setup, stateIn, transition } from "@jambudipa/xstate-effect"
import type {
  Engine,
  Fact,
  History,
  ObligationModel,
  ObligationState,
  Plan,
  Result,
  RunState,
  ScenarioModel,
  ScenarioState,
  State,
  TaskModel,
  TaskState,
  Verdict,
} from "@/task/core/model"

// O2's engine: the harness lifecycle on @jambudipa/xstate-effect. O1's runner, facts and `State` are reused
// unchanged; only the fold step differs from O1's transition table (`@/task/engine-table`), and it gives the same
// `State`, history included.
//
// A task is ONE machine with two parallel regions. `evidence` holds what the task's obligations prove (open,
// proved, reopened, stale, trusted); `work` holds the task's own state (waiting ... trusted, and the end states).
// The context holds the attempts, the budget, the worktree/branch/base/head/session, the reason and one slot per
// obligation (its state, hash and reason). Facts are the events. Guards are named entries of each machine's
// registry; every context change is a named `assign` action. One obligation's move is a transition of a small
// obligation machine, which the evidence region's `moveObligations` action runs for each slot; a scenario and the
// run have a small machine each. The run follows a task into its end states through the internal `task.moved`
// event, which the fold sends after every task move.
//
// `apply` is a pure fold step: it rebuilds the affected unit's snapshot from `State` (`machine.resolveState` from
// the state value and the context), runs the pure `transition` synchronously (the machines have no actors and no
// delays) and maps the next snapshot back to `State`. Each transition's actions append the history entry the
// table engine appends (`context.log`), in the same order: the evidence region comes first in document order, so
// its obligation entries precede the task's. A step whose log stays empty changed nothing, and `apply` returns
// the state it received. Resume is the same fold over the stored facts.
//
// Deviations from the brief:
// - Timeouts: the brief asks for delayed (`after`) transitions on the Effect clock. The shared runner (reused
//   unchanged, D3) already measures stream stalls, proof time-outs and wall clocks and records them as facts
//   (`task.stalled`, `task.proved` with a `timed out` reason, ...), and a pure fold over stored facts cannot fire
//   a delay. The machines therefore have no delayed transitions.
// - `State` has no field for the evidence region (O1's model keeps only the obligation states). A rebuilt snapshot
//   therefore puts the region in its transient `assessing` state, whose eventless rows settle it on what the slots
//   show within the step. No guard reads the region, so this changes no decision.

type FactOf<T extends Fact["type"]> = Extract<Fact, { readonly type: T }>
type TaskFact = Extract<Fact, { readonly task: string }>

/** A task machine's events: its own facts, the cancel of the run and the staleness of one of its obligations. */
type TaskEvent = TaskFact | FactOf<"run.cancelled" | "obligation.stale">

/** What the fold sends the run after a task moved; the run follows the task into some of its end states. */
interface TaskMoved {
  readonly type: "task.moved"
  readonly at: number
  readonly task: string
  readonly state: TaskState
  readonly reason?: string
}

type RunEvent = FactOf<"run.started" | "run.resumed" | "run.ended" | "run.cancelled" | "outside.trusted"> | TaskMoved
type ScenarioEvent = FactOf<"scenario.proved" | "scenario.verified">

/** The params of the action that records a move: the unit's state before and after it. */
interface Move<S extends string> {
  readonly from: S
  readonly to: S
}

/**
 * A setup's phantom `types`: the setup reads them for their types only. Every member is optional, so `{}` is one,
 * with no `{} as { ... }` assertion.
 */
interface Phantom<C, E, I> {
  readonly context?: C
  readonly events?: E
  readonly input?: I
}

const phantom = <C, E, I = undefined>(): Phantom<C, E, I> => ({})

/** The run's unit id in `history`. */
const RUN = "run"

// --- reads shared by the guards and actions ----------------------------------------------------------------------

const resultOf = (event: TaskEvent, id: string): Result | undefined => {
  if (event.type !== "task.proved") return undefined
  return event.results.find((result) => result.id === id)
}

const verdictOf = (event: TaskEvent | ScenarioEvent, id: string): Verdict | undefined => {
  if (event.type === "task.verified") return event.verdicts.find((verdict) => verdict.id === id)
  if (event.type === "scenario.verified" && event.verdict.id === id) return event.verdict
  return undefined
}

const joined = (parts: ReadonlyArray<string | undefined>) => {
  const text = parts.filter((part): part is string => part !== undefined && part !== "").join("; ")
  if (text === "") return undefined
  return text
}

const entry = (at: number, unit: string, from: string, to: string, reason: string | undefined): History => ({
  at,
  unit,
  from,
  to,
  reason,
})

// --- the obligation machine --------------------------------------------------------------------------------------

/** One obligation as its machine sees it. Its state is the machine's state value. */
interface ObligationContext {
  readonly id: string
  readonly hash: string
  readonly reason?: string
  /** A parent's review obligation: a proof round that gives it no result leaves it waiting for the reviewer. */
  readonly review: boolean
  readonly log: ReadonlyArray<History>
}

const obligationReason = (event: TaskEvent, id: string, to: ObligationState) => {
  if (to === "failed") return resultOf(event, id)?.reason
  if (to === "rejected") return verdictOf(event, id)?.reason
  return undefined
}

const obligationMove = (from: ObligationState, to: ObligationState) =>
  ({ type: "enter", params: { from, to } }) as const

const failRow = (from: ObligationState) =>
  ({ guard: "resultFailed", target: "failed", actions: obligationMove(from, "failed") }) as const

const passRow = (from: ObligationState) =>
  ({ guard: "resultPassed", target: "trusted", actions: obligationMove(from, "trusted") }) as const

const proofRows = (from: ObligationState) =>
  [
    failRow(from),
    passRow(from),
    { guard: "resultNeedsJudge", target: "passed", actions: obligationMove(from, "passed") },
  ] as const

const reviewRow = (from: ObligationState) =>
  ({ guard: "unprovedReview", target: "passed", actions: obligationMove(from, "passed") }) as const

const verdictRows = (from: ObligationState) =>
  [
    { guard: "verdictTrusted", target: "trusted", actions: obligationMove(from, "trusted") },
    { guard: "verdictRejected", target: "rejected", actions: obligationMove(from, "rejected") },
  ] as const

const staleRow = (from: ObligationState) =>
  ({ guard: "named", target: "stale", actions: ["rehash", obligationMove(from, "stale")] }) as const

/**
 * One obligation. A trusted one takes no verdict and stays trusted on `needs-judge`: only a failure or staleness
 * reopens it. A `passed` one already waits for a judge, so `needs-judge` leaves it as it is.
 */
export const obligationMachine = setup({
  types: phantom<ObligationContext, TaskEvent, ObligationContext>(),
  guards: {
    resultFailed: ({ context, event }) => resultOf(event, context.id)?.status === "failed",
    /** A machine-judged proof (gate, unchanged) passed: no judge is needed. */
    resultPassed: ({ context, event }) => resultOf(event, context.id)?.status === "passed",
    resultNeedsJudge: ({ context, event }) => resultOf(event, context.id)?.status === "needs-judge",
    unprovedReview: ({ context, event }) =>
      event.type === "task.proved" && context.review && resultOf(event, context.id) === undefined,
    verdictTrusted: ({ context, event }) => verdictOf(event, context.id)?.verdict === "trusted",
    verdictRejected: ({ context, event }) => verdictOf(event, context.id)?.verdict === "rejected",
    /** The staleness fact names this obligation. */
    named: ({ context, event }) => event.type === "obligation.stale" && event.id === context.id,
  },
  actions: {
    enter: assign(({ context, event }, move: Move<ObligationState>) => {
      const reason = obligationReason(event, context.id, move.to)
      return { reason, log: [...context.log, entry(event.at, context.id, move.from, move.to, reason)] }
    }),
    rehash: assign(({ context, event }) => ({ hash: event.type === "obligation.stale" ? event.hash : context.hash })),
  },
}).createMachine({
  id: "obligation",
  context: ({ input }) => input,
  initial: "pending",
  states: {
    pending: {
      on: { "task.proved": [...proofRows("pending"), reviewRow("pending")], "task.verified": verdictRows("pending") },
    },
    passed: {
      on: {
        "task.proved": [failRow("passed"), passRow("passed")],
        "task.verified": verdictRows("passed"),
        "obligation.stale": staleRow("passed"),
      },
    },
    failed: { on: { "task.proved": proofRows("failed"), "task.verified": verdictRows("failed") } },
    trusted: { on: { "task.proved": failRow("trusted"), "obligation.stale": staleRow("trusted") } },
    rejected: { on: { "task.proved": proofRows("rejected"), "task.verified": verdictRows("rejected") } },
    stale: {
      on: { "task.proved": [...proofRows("stale"), reviewRow("stale")], "task.verified": verdictRows("stale") },
    },
  },
})

// --- the task machine --------------------------------------------------------------------------------------------

/** One obligation of a task, as the task's context keeps it. */
interface Slot {
  readonly id: string
  readonly state: ObligationState
  readonly hash: string
  readonly reason?: string
  readonly review: boolean
}

interface TaskContext {
  readonly id: string
  readonly leaf: boolean
  /** `policy.budgets.taskAttempts` of the task. */
  readonly budget: number
  /** Returns to the builder: 1 for the first build; parents stay 0 until reviewed, then 1. */
  readonly attempts: number
  readonly worktree?: string
  readonly branch?: string
  readonly base?: string
  readonly head?: string
  readonly session?: string
  readonly reason?: string
  /** The task's obligations, in plan order. */
  readonly obligations: ReadonlyArray<Slot>
  readonly log: ReadonlyArray<History>
}

type TaskInput = Pick<TaskContext, "id" | "leaf" | "budget" | "obligations">

const slots = (context: Pick<TaskContext, "obligations">) => context.obligations

// The reason a task's new state carries, read from the context after the fact's obligation moves.
const taskReason = (context: TaskContext, event: TaskEvent, to: TaskState) => {
  switch (event.type) {
    case "task.proved":
      if (to === "verifying") return undefined
      return joined([
        event.reason,
        ...event.results
          .filter((result) => result.status === "failed")
          .map((result) => `${result.id}: ${result.reason ?? "failed"}`),
      ])
    case "task.verified":
      if (to === "trusted") return undefined
      return joined(
        slots(context)
          .filter((slot) => slot.state !== "trusted")
          .map((slot) =>
            slot.state === "rejected" ? `${slot.id}: ${slot.reason ?? "rejected"}` : `${slot.id}: not judged`,
          ),
      )
    case "task.stalled":
    case "task.repeated":
    case "task.needs_human":
    case "task.failed":
    case "run.cancelled":
      return event.reason
    case "obligation.stale":
      return `stale: ${event.id}`
    default:
      return undefined
  }
}

// One obligation's move: its machine's snapshot from the slot, the pure transition, the slot and log after it.
const stepObligation = (slot: Slot, event: TaskEvent) =>
  Effect.gen(function* () {
    const snapshot = yield* obligationMachine.resolveState({
      value: slot.state,
      context: { id: slot.id, hash: slot.hash, reason: slot.reason, review: slot.review, log: [] },
    })
    const [next] = yield* transition(obligationMachine, snapshot, event)
    if (next.context.log.length === 0) return { slot, log: [] }
    const moved: Slot = { ...slot, state: next.value, hash: next.context.hash, reason: next.context.reason }
    return { slot: moved, log: next.context.log }
  }).pipe(Effect.orDie)

const taskMove = (from: TaskState, to: TaskState) => ({ type: "enter", params: { from, to } }) as const

const inWork = (state: TaskState) => stateIn<TaskContext, TaskEvent>({ work: state })

// The facts that end an active task, from each state that has a builder or proof round going on.
const halts = (from: TaskState) =>
  ({
    "task.needs_human": { target: "needs_human", actions: taskMove(from, "needs_human") },
    "task.failed": { target: "failed", actions: taskMove(from, "failed") },
    "run.cancelled": { target: "cancelled", actions: taskMove(from, "cancelled") },
  }) as const

/** A task, leaf or parent (told apart by the `leaf` and `parent` guards). */
export const taskMachine = setup({
  types: phantom<TaskContext, TaskEvent, TaskInput>(),
  guards: {
    leaf: ({ context }) => context.leaf,
    parent: ({ context }) => !context.leaf,
    underBudget: ({ context }) => context.attempts < context.budget,
    proofFailed: ({ event }) =>
      event.type === "task.proved" && event.results.some((result) => result.status === "failed"),
    /** A leaf's proof failed and it may go back to the builder. */
    retryProof: and(["leaf", "proofFailed", "underBudget"]),
    /** A leaf's proof failed and its budget is spent. */
    exhaustProof: and(["leaf", "proofFailed", not("underBudget")]),
    /** The task is in a proof round: a leaf proving, or a parent waiting for its review proof. */
    inProof: or([inWork("proving"), and([inWork("waiting"), "parent"])]),
    inVerification: inWork("verifying"),
    /** Every obligation of the task is trusted. */
    allTrusted: ({ context }) => slots(context).every((slot) => slot.state === "trusted"),
    anyStale: ({ context }) => slots(context).some((slot) => slot.state === "stale"),
    /** An obligation failed its proof or was rejected: the task goes back to the builder. */
    anyReopened: ({ context }) => slots(context).some((slot) => slot.state === "failed" || slot.state === "rejected"),
    /** Nothing is proved yet. */
    allOpen: ({ context }) => slots(context).every((slot) => slot.state === "pending"),
  },
  actions: {
    /** Runs the obligation machine of every slot on the fact, in plan order. */
    moveObligations: assign(({ context, event }) =>
      Effect.map(
        Effect.forEach(slots(context), (slot) => stepObligation(slot, event)),
        (steps) => ({
          obligations: steps.map((step) => step.slot),
          log: [...context.log, ...steps.flatMap((step) => step.log)],
        }),
      ),
    ),
    start: assign(({ event }) =>
      event.type === "task.started"
        ? { attempts: 1, worktree: event.worktree, branch: event.branch, base: event.base, session: event.session }
        : {},
    ),
    ready: assign(({ event }) => (event.type === "task.ready" ? { head: event.head } : {})),
    /** A return to the builder. */
    retry: assign(({ context }) => ({ attempts: context.attempts + 1 })),
    /** A parent counts its one review. */
    reviewed: assign({ attempts: 1 }),
    enter: assign(({ context, event }, move: Move<TaskState>) => {
      const reason = taskReason(context, event, move.to)
      return { reason, log: [...context.log, entry(event.at, context.id, move.from, move.to, reason)] }
    }),
  },
}).createMachine({
  id: "task",
  type: "parallel",
  context: ({ input }) => ({ ...input, attempts: 0, log: [] }),
  states: {
    // First in document order, so its obligation moves (and their history) come before the work region's.
    evidence: {
      initial: "open",
      on: {
        "task.proved": { guard: "inProof", target: ".assessing", actions: "moveObligations" },
        "task.verified": { guard: "inVerification", target: ".assessing", actions: "moveObligations" },
        "obligation.stale": { target: ".assessing", actions: "moveObligations" },
      },
      states: {
        open: {},
        proved: {},
        reopened: {},
        stale: {},
        trusted: {},
        // Reads the slots and settles on the state they show. A rebuilt snapshot starts here (see the header).
        assessing: {
          always: [
            { guard: "anyStale", target: "stale" },
            { guard: "anyReopened", target: "reopened" },
            { guard: "allTrusted", target: "trusted" },
            { guard: "allOpen", target: "open" },
            { target: "proved" },
          ],
        },
      },
    },
    work: {
      initial: "waiting",
      states: {
        waiting: {
          on: {
            "task.started": { guard: "leaf", target: "building", actions: ["start", taskMove("waiting", "building")] },
            "task.proved": { guard: "parent", target: "verifying", actions: taskMove("waiting", "verifying") },
            "task.failed": { target: "failed", actions: taskMove("waiting", "failed") },
          },
        },
        building: {
          on: {
            "task.ready": { target: "proving", actions: ["ready", taskMove("building", "proving")] },
            // The runner cut the stream and prompts the same attempt again.
            "task.stalled": { actions: taskMove("building", "building") },
            "task.repeated": [
              { guard: "underBudget", actions: ["retry", taskMove("building", "building")] },
              { target: "budget_exhausted", actions: taskMove("building", "budget_exhausted") },
            ],
            ...halts("building"),
          },
        },
        proving: {
          on: {
            "task.proved": [
              { guard: "retryProof", target: "building", actions: ["retry", taskMove("proving", "building")] },
              { guard: "exhaustProof", target: "budget_exhausted", actions: taskMove("proving", "budget_exhausted") },
              { target: "verifying", actions: taskMove("proving", "verifying") },
            ],
            ...halts("proving"),
          },
        },
        verifying: {
          on: { "task.verified": { target: "judging" }, ...halts("verifying") },
        },
        // The verdicts have moved the obligations: decide on the context after them.
        judging: {
          always: [
            {
              guard: and(["allTrusted", "parent"]),
              target: "trusted",
              actions: ["reviewed", taskMove("verifying", "trusted")],
            },
            { guard: "allTrusted", target: "trusted", actions: taskMove("verifying", "trusted") },
            // A parent is never rebuilt.
            { guard: "parent", target: "failed", actions: taskMove("verifying", "failed") },
            { guard: "underBudget", target: "building", actions: ["retry", taskMove("verifying", "building")] },
            { target: "budget_exhausted", actions: taskMove("verifying", "budget_exhausted") },
          ],
        },
        // Every obligation of a trusted task is trusted, so the named one has gone stale with this fact.
        trusted: { on: { "obligation.stale": { target: "proving", actions: taskMove("trusted", "proving") } } },
        // A state of the model that no fact enters (a stall keeps the task building), here so that every
        // `TaskState` resolves.
        stalled: {},
        needs_human: { type: "final" },
        budget_exhausted: { type: "final" },
        cancelled: { type: "final" },
        failed: { type: "final" },
      },
    },
  },
})

// --- the scenario machine ----------------------------------------------------------------------------------------

interface ScenarioContext {
  readonly id: string
  readonly reason?: string
  readonly log: ReadonlyArray<History>
}

const scenarioReason = (event: ScenarioEvent, to: ScenarioState) => {
  if (event.type === "scenario.proved" && to === "failed") return event.reason
  if (event.type === "scenario.verified" && to === "rejected") return event.verdict.reason
  return undefined
}

const scenarioMove = (from: ScenarioState, to: ScenarioState) => ({ type: "enter", params: { from, to } }) as const

const scenarioProved = (from: ScenarioState) =>
  [
    { guard: "scenarioPassed", target: "verifying", actions: scenarioMove(from, "verifying") },
    { target: "failed", actions: scenarioMove(from, "failed") },
  ] as const

/** A scenario: its tests run once its needs are trusted, then a scenario verifier judges it. */
export const scenarioMachine = setup({
  types: phantom<ScenarioContext, ScenarioEvent, { readonly id: string }>(),
  guards: {
    scenarioPassed: ({ event }) => event.type === "scenario.proved" && event.status === "passed",
    verdictTrusted: ({ context, event }) => verdictOf(event, context.id)?.verdict === "trusted",
  },
  actions: {
    enter: assign(({ context, event }, move: Move<ScenarioState>) => {
      const reason = scenarioReason(event, move.to)
      return { reason, log: [...context.log, entry(event.at, context.id, move.from, move.to, reason)] }
    }),
  },
}).createMachine({
  id: "scenario",
  context: ({ input }) => ({ id: input.id, log: [] }),
  initial: "waiting",
  states: {
    waiting: { on: { "scenario.proved": scenarioProved("waiting") } },
    pending: { on: { "scenario.proved": scenarioProved("pending") } },
    verifying: {
      on: {
        "scenario.verified": [
          { guard: "verdictTrusted", target: "trusted", actions: scenarioMove("verifying", "trusted") },
          { target: "rejected", actions: scenarioMove("verifying", "rejected") },
        ],
      },
    },
    trusted: { type: "final" },
    rejected: { type: "final" },
    failed: { type: "final" },
  },
})

// --- the run machine ---------------------------------------------------------------------------------------------

interface RunContext {
  readonly reason?: string
  readonly log: ReadonlyArray<History>
}

// `reason` is what the run keeps; `noted` is what its history entry says.
const runWhy = (event: RunEvent): { readonly reason?: string; readonly noted?: string } => {
  switch (event.type) {
    case "run.resumed":
      return { noted: "resumed" }
    case "run.ended":
    case "run.cancelled":
      return { reason: event.reason, noted: event.reason }
    case "task.moved": {
      const why = event.reason === undefined ? event.task : `${event.task}: ${event.reason}`
      return { reason: why, noted: why }
    }
    default:
      return {}
  }
}

const runMove = (from: RunState, to: RunState) => ({ type: "enter", params: { from, to } }) as const

// A live run (running or waiting): the run facts, an outside trust, and the task end states the run follows.
const live = (from: RunState) =>
  ({
    "run.started": { target: "running", actions: runMove(from, "running") },
    "run.resumed": { target: "running", actions: runMove(from, "running") },
    "run.ended": [
      { guard: "endedDone", target: "done", actions: runMove(from, "done") },
      { target: "failed", actions: runMove(from, "failed") },
    ],
    "run.cancelled": { target: "cancelled", actions: runMove(from, "cancelled") },
    "outside.trusted": { actions: "trustOutside" },
    "task.moved": [
      {
        guard: { type: "taskReached", params: { state: "needs_human" } },
        target: "needs_human",
        actions: runMove(from, "needs_human"),
      },
      {
        guard: { type: "taskReached", params: { state: "budget_exhausted" } },
        target: "budget_exhausted",
        actions: runMove(from, "budget_exhausted"),
      },
      {
        guard: { type: "taskReached", params: { state: "failed" } },
        target: "failed",
        actions: runMove(from, "failed"),
      },
    ],
  }) as const

/** The run. Its end states are final: a run in one of them takes no event, and nothing else changes either. */
export const runMachine = setup({
  types: phantom<RunContext, RunEvent>(),
  guards: {
    endedDone: ({ event }) => event.type === "run.ended" && event.state === "done",
    taskReached: ({ event }, params: { readonly state: TaskState }) =>
      event.type === "task.moved" && event.state === params.state,
  },
  actions: {
    enter: assign(({ context, event }, move: Move<RunState>) => {
      const why = runWhy(event)
      return { reason: why.reason, log: [...context.log, entry(event.at, RUN, move.from, move.to, why.noted)] }
    }),
    /** An `outside` precondition the state store records as trusted: a history entry, no state change. */
    trustOutside: assign(({ context, event }) =>
      event.type === "outside.trusted"
        ? { log: [...context.log, { at: event.at, unit: event.id, to: "trusted", reason: "outside" }] }
        : {},
    ),
  },
}).createMachine({
  id: "run",
  context: { log: [] },
  initial: "running",
  states: {
    running: { on: live("running") },
    waiting: { on: live("waiting") },
    refused: { type: "final" },
    done: { type: "final" },
    cancelled: { type: "final" },
    needs_human: { type: "final" },
    budget_exhausted: { type: "final" },
    failed: { type: "final" },
  },
})

// --- the fold ----------------------------------------------------------------------------------------------------

// The boundary of the synchronous `Engine` interface: every Effect here is pure and synchronous (no actors, no
// delays), and a failure is a defect of the machine definitions.
const runPure = <A>(effect: Effect.Effect<A, unknown>): A => Effect.runSync(Effect.orDie(effect))

const appended = (state: State, log: ReadonlyArray<History>): ReadonlyArray<History> => [...state.history, ...log]

// The work region's state after a macrostep. `judging` is transient: its last row has no guard, so no macrostep
// ends in it.
const settled = (work: TaskState | "judging"): Effect.Effect<TaskState> =>
  work === "judging" ? Effect.die("the task machine ended a step in `judging`") : Effect.succeed(work)

const isReview = (plan: Plan, id: string) =>
  plan.spec.obligations.some((obligation) => obligation.id === id && obligation.proof.kind === "review")

const taskInput = (plan: Plan, state: State, task: TaskModel): TaskInput => ({
  id: task.id,
  leaf: task.leaf,
  budget: plan.budget(task.id),
  obligations: Object.values(state.obligations)
    .filter((obligation) => obligation.task === task.id)
    .map((obligation) => ({
      id: obligation.id,
      state: obligation.state,
      hash: obligation.hash,
      reason: obligation.reason,
      review: !task.leaf && isReview(plan, obligation.id),
    })),
})

const runSnapshot = (state: State) =>
  runMachine.resolveState({ value: state.run.state, context: { reason: state.run.reason, log: [] } })

// The run on one event: unchanged when its machine takes no transition.
const stepRun = (state: State, event: RunEvent) =>
  Effect.gen(function* () {
    const [next] = yield* transition(runMachine, yield* runSnapshot(state), event)
    const log = next.context.log
    if (log.length === 0) return state
    const run = log.some((item) => item.unit === RUN)
      ? { ...state.run, state: next.value, reason: next.context.reason }
      : state.run
    return { ...state, run, history: appended(state, log) }
  })

// One task on one event; then the run follows the task's move.
const stepTask = (plan: Plan, state: State, id: string, event: TaskEvent) =>
  Effect.gen(function* () {
    const task: TaskModel | undefined = state.tasks[id]
    if (task === undefined) return state
    const input = taskInput(plan, state, task)
    const context: TaskContext = {
      ...input,
      attempts: task.attempts,
      worktree: task.worktree,
      branch: task.branch,
      base: task.base,
      head: task.head,
      session: task.session,
      reason: task.reason,
      log: [],
    }
    // `State` keeps no evidence state: the region starts in `assessing` and settles on what the slots show.
    const snapshot = yield* taskMachine.resolveState({ value: { evidence: "assessing", work: task.state }, context })
    const [next] = yield* transition(taskMachine, snapshot, event)
    const log = next.context.log
    if (log.length === 0) return state
    const movedIds = log.map((item) => item.unit)
    const obligations = Object.fromEntries(
      next.context.obligations
        .filter((slot) => movedIds.includes(slot.id))
        .map((slot): [string, ObligationModel] => [
          slot.id,
          { ...state.obligations[slot.id], state: slot.state, hash: slot.hash, reason: slot.reason },
        ]),
    )
    const after: State = {
      ...state,
      obligations: { ...state.obligations, ...obligations },
      history: appended(state, log),
    }
    if (!movedIds.includes(id)) return after
    const work = yield* settled(next.value.work)
    const moved: TaskModel = {
      ...task,
      worktree: next.context.worktree,
      branch: next.context.branch,
      base: next.context.base,
      head: next.context.head,
      session: next.context.session,
      state: work,
      attempts: next.context.attempts,
      reason: next.context.reason,
    }
    return yield* stepRun(
      { ...after, tasks: { ...after.tasks, [id]: moved } },
      { type: "task.moved", at: event.at, task: id, state: work, reason: next.context.reason },
    )
  })

// Cancel: when the run takes it, every active task is cancelled first, then the run.
const cancel = (plan: Plan, state: State, fact: FactOf<"run.cancelled">) =>
  Effect.gen(function* () {
    if (!(yield* (yield* runSnapshot(state)).can(fact))) return state
    const tasks = yield* Effect.reduce(
      Object.keys(state.tasks),
      () => state,
      (current, id) => stepTask(plan, current, id, fact),
    )
    return yield* stepRun(tasks, fact)
  })

const stepScenario = (state: State, fact: ScenarioEvent) =>
  Effect.gen(function* () {
    const id = fact.type === "scenario.proved" ? fact.id : fact.verdict.id
    const scenario: ScenarioModel | undefined = state.scenarios[id]
    if (scenario === undefined) return state
    const snapshot = yield* scenarioMachine.resolveState({
      value: scenario.state,
      context: { id, reason: scenario.reason, log: [] },
    })
    const [next] = yield* transition(scenarioMachine, snapshot, fact)
    const log = next.context.log
    if (log.length === 0) return state
    return {
      ...state,
      scenarios: { ...state.scenarios, [id]: { ...scenario, state: next.value, reason: next.context.reason } },
      history: appended(state, log),
    }
  })

/** The first state of a run: each unit in its machine's initial state. */
export const initial = (plan: Plan): State =>
  runPure(
    Effect.gen(function* () {
      const empty: State = {
        run: { state: "running", spec: plan.specPath, path: plan.path },
        tasks: {},
        obligations: {},
        scenarios: {},
        history: [],
      }
      const run = yield* getInitialSnapshot(runMachine)
      const tasks = yield* Effect.forEach(plan.tasks, (task) =>
        Effect.gen(function* () {
          const snapshot = yield* getInitialSnapshot(taskMachine, {
            id: task.id,
            leaf: task.children.length === 0,
            budget: plan.budget(task.id),
            obligations: [],
          })
          const model: TaskModel = {
            id: task.id,
            leaf: snapshot.context.leaf,
            state: yield* settled(snapshot.value.work),
            attempts: snapshot.context.attempts,
          }
          return [task.id, model] as const
        }),
      )
      const ids = plan.tasks.map((task) => task.id)
      const obligations = yield* Effect.forEach(
        plan.spec.obligations.filter((obligation) => ids.includes(obligation.task)),
        (obligation) =>
          Effect.map(
            getInitialSnapshot(obligationMachine, { id: obligation.id, hash: obligation.hash, review: false, log: [] }),
            (snapshot): [string, ObligationModel] => [
              obligation.id,
              { id: obligation.id, task: obligation.task, state: snapshot.value, hash: snapshot.context.hash },
            ],
          ),
      )
      const scenarios = yield* Effect.forEach(plan.scenarios, (scenario) =>
        Effect.map(getInitialSnapshot(scenarioMachine, { id: scenario.id }), (snapshot): [string, ScenarioModel] => [
          scenario.id,
          { id: scenario.id, state: snapshot.value },
        ]),
      )
      return {
        ...empty,
        run: { ...empty.run, state: run.value },
        tasks: Object.fromEntries(tasks),
        obligations: Object.fromEntries(obligations),
        scenarios: Object.fromEntries(scenarios),
      }
    }),
  )

/** One fold step. Pure: the same plan, state and fact always give the same new state. */
export const apply = (plan: Plan, state: State, fact: Fact): State =>
  runPure(
    Effect.gen(function* () {
      if ((yield* runSnapshot(state)).status === "done") return state
      switch (fact.type) {
        case "outside.trusted":
        case "run.started":
        case "run.resumed":
        case "run.ended":
          return yield* stepRun(state, fact)
        case "run.cancelled":
          return yield* cancel(plan, state, fact)
        case "obligation.stale": {
          const obligation: ObligationModel | undefined = state.obligations[fact.id]
          if (obligation === undefined) return state
          return yield* stepTask(plan, state, obligation.task, fact)
        }
        case "scenario.proved":
        case "scenario.verified":
          return yield* stepScenario(state, fact)
        default:
          return yield* stepTask(plan, state, fact.task, fact)
      }
    }),
  )

export const XStateEngine: Engine = { name: "xstate", initial, apply }

export * as TaskEngineXState from "."

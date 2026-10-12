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

// O1's engine: the harness lifecycle as data. Each unit kind (the run, a task, an obligation, a scenario) has a
// table from its state to a fact type to a list of rows `{ guard?, to }`. The first row whose named guard holds
// (a row without a guard always holds) gives the next state. A fact that finds no row changes nothing and adds
// no history; a row that matches appends one history entry for its unit, even when `to` equals the state.
//
// `apply` is a pure fold step. For `task.proved` and `task.verified` the task's own row decides whether the fact
// applies at all: only then do the obligations of that task move (per result, per verdict), and the task's guards
// read the state after those moves. A task that reaches an end state takes the run with it (`runFollows`). Once
// the run is in an end state, no fact changes anything.

type FactType = Fact["type"]
type FactOf<T extends FactType> = Extract<Fact, { readonly type: T }>
type TaskFact = Extract<Fact, { readonly task: string }>
type RunFact = FactOf<"run.started" | "run.resumed" | "run.ended" | "run.cancelled">
type ScenarioFact = FactOf<"scenario.proved" | "scenario.verified">

/** What a guard reads: the plan, the state so far, the fact, and the id of the unit the row would move. */
export interface GuardInput {
  readonly plan: Plan
  readonly state: State
  readonly fact: Fact
  readonly id: string
}

export type Guard = (input: GuardInput) => boolean

/** One row: when `guard` holds (or is absent), the unit moves to `to`. */
export interface Row<S extends string> {
  readonly guard?: GuardName
  readonly to: S
}

/** Unit state → fact type → rows, first match wins. */
export type Table<S extends string> = {
  readonly [K in S]?: { readonly [F in FactType]?: ReadonlyArray<Row<S>> }
}

/** The run's unit id in `history`. */
export const RUN = "run"

/** The run states that end a run. Nothing changes a run in one of them. */
export const endStates: ReadonlyArray<RunState> = [
  "refused",
  "cancelled",
  "needs_human",
  "budget_exhausted",
  "failed",
  "done",
]

export const ended = (state: RunState) => endStates.includes(state)

// --- guards -------------------------------------------------------------------------------------------------------

const resultOf = (fact: Fact, id: string): Result | undefined => {
  if (fact.type !== "task.proved") return undefined
  return fact.results.find((result) => result.id === id)
}

const verdictOf = (fact: Fact, id: string): Verdict | undefined => {
  if (fact.type === "task.verified") return fact.verdicts.find((verdict) => verdict.id === id)
  if (fact.type === "scenario.verified" && fact.verdict.id === id) return fact.verdict
  return undefined
}

// A lookup that may miss: a fact can name a unit the plan does not hold.
const taskOf = (state: State, id: string): TaskModel | undefined => state.tasks[id]
const obligationOf = (state: State, id: string): ObligationModel | undefined => state.obligations[id]

const obligationsOf = (state: State, task: string) =>
  Object.values(state.obligations).filter((obligation) => obligation.task === task)

const isLeaf = ({ state, id }: GuardInput) => taskOf(state, id)?.leaf === true
const isParent = ({ state, id }: GuardInput) => taskOf(state, id)?.leaf === false
const underBudget = ({ plan, state, id }: GuardInput) => (taskOf(state, id)?.attempts ?? 0) < plan.budget(id)
const proofFailed = ({ fact }: GuardInput) =>
  fact.type === "task.proved" && fact.results.some((result) => result.status === "failed")

/** The named guards. Every one is a pure predicate of its input. */
export const guards = {
  leaf: isLeaf,
  parent: isParent,
  underBudget,
  /** A leaf's proof failed and it may go back to the builder. */
  retryProof: (input: GuardInput) => isLeaf(input) && proofFailed(input) && underBudget(input),
  /** A leaf's proof failed and its budget is spent. */
  exhaustProof: (input: GuardInput) => isLeaf(input) && proofFailed(input) && !underBudget(input),
  /** Every obligation of the task is trusted. */
  allTrusted: ({ state, id }: GuardInput) =>
    obligationsOf(state, id).every((obligation) => obligation.state === "trusted"),
  resultFailed: ({ fact, id }: GuardInput) => resultOf(fact, id)?.status === "failed",
  /** A machine-judged proof (gate, unchanged) passed: no judge is needed. */
  resultPassed: ({ fact, id }: GuardInput) => resultOf(fact, id)?.status === "passed",
  resultNeedsJudge: ({ fact, id }: GuardInput) => resultOf(fact, id)?.status === "needs-judge",
  /** A parent's review obligation that the proof round gave no result: it waits for the reviewer. */
  unprovedReview: ({ plan, state, fact, id }: GuardInput) =>
    fact.type === "task.proved" &&
    resultOf(fact, id) === undefined &&
    taskOf(state, obligationOf(state, id)?.task ?? "")?.leaf === false &&
    plan.spec.obligations.some((obligation) => obligation.id === id && obligation.proof.kind === "review"),
  verdictTrusted: ({ fact, id }: GuardInput) => verdictOf(fact, id)?.verdict === "trusted",
  verdictRejected: ({ fact, id }: GuardInput) => verdictOf(fact, id)?.verdict === "rejected",
  scenarioPassed: ({ fact }: GuardInput) => fact.type === "scenario.proved" && fact.status === "passed",
  endedDone: ({ fact }: GuardInput) => fact.type === "run.ended" && fact.state === "done",
} satisfies Record<string, Guard>

export type GuardName = keyof typeof guards

// --- tables -------------------------------------------------------------------------------------------------------

const live: Table<RunState>["running"] = {
  "run.started": [{ to: "running" }],
  "run.resumed": [{ to: "running" }],
  "run.ended": [{ guard: "endedDone", to: "done" }, { to: "failed" }],
  "run.cancelled": [{ to: "cancelled" }],
}

/** The run. The end states have no rows. */
export const runTable: Table<RunState> = { running: live, waiting: live }

/** A task: leaf rows and parent rows share the table, told apart by the `leaf` and `parent` guards. */
export const taskTable: Table<TaskState> = {
  waiting: {
    "task.started": [{ guard: "leaf", to: "building" }],
    "task.proved": [{ guard: "parent", to: "verifying" }],
    "task.failed": [{ to: "failed" }],
  },
  building: {
    "task.ready": [{ to: "proving" }],
    "task.stalled": [{ to: "building" }],
    "task.repeated": [{ guard: "underBudget", to: "building" }, { to: "budget_exhausted" }],
    "task.needs_human": [{ to: "needs_human" }],
    "task.failed": [{ to: "failed" }],
    "run.cancelled": [{ to: "cancelled" }],
  },
  proving: {
    "task.proved": [
      { guard: "retryProof", to: "building" },
      { guard: "exhaustProof", to: "budget_exhausted" },
      { to: "verifying" },
    ],
    "task.needs_human": [{ to: "needs_human" }],
    "task.failed": [{ to: "failed" }],
    "run.cancelled": [{ to: "cancelled" }],
  },
  verifying: {
    "task.verified": [
      { guard: "allTrusted", to: "trusted" },
      // A parent is never rebuilt.
      { guard: "parent", to: "failed" },
      { guard: "underBudget", to: "building" },
      { to: "budget_exhausted" },
    ],
    "task.needs_human": [{ to: "needs_human" }],
    "task.failed": [{ to: "failed" }],
    "run.cancelled": [{ to: "cancelled" }],
  },
  trusted: {
    "obligation.stale": [{ to: "proving" }],
  },
}

const proofRows: ReadonlyArray<Row<ObligationState>> = [
  { guard: "resultFailed", to: "failed" },
  { guard: "resultPassed", to: "trusted" },
  { guard: "resultNeedsJudge", to: "passed" },
]
const verdictRows: ReadonlyArray<Row<ObligationState>> = [
  { guard: "verdictTrusted", to: "trusted" },
  { guard: "verdictRejected", to: "rejected" },
]

/** An obligation. A trusted one takes no verdict and stays trusted on `needs-judge`: only a failure or staleness reopens it. */
export const obligationTable: Table<ObligationState> = {
  pending: {
    "task.proved": [...proofRows, { guard: "unprovedReview", to: "passed" }],
    "task.verified": verdictRows,
  },
  passed: {
    // Already waiting for a judge: `needs-judge` leaves it as it is.
    "task.proved": [
      { guard: "resultFailed", to: "failed" },
      { guard: "resultPassed", to: "trusted" },
    ],
    "task.verified": verdictRows,
    "obligation.stale": [{ to: "stale" }],
  },
  failed: { "task.proved": proofRows, "task.verified": verdictRows },
  trusted: {
    "task.proved": [{ guard: "resultFailed", to: "failed" }],
    "obligation.stale": [{ to: "stale" }],
  },
  rejected: { "task.proved": proofRows, "task.verified": verdictRows },
  stale: {
    "task.proved": [...proofRows, { guard: "unprovedReview", to: "passed" }],
    "task.verified": verdictRows,
  },
}

const scenarioProved: ReadonlyArray<Row<ScenarioState>> = [
  { guard: "scenarioPassed", to: "verifying" },
  { to: "failed" },
]

/** A scenario. */
export const scenarioTable: Table<ScenarioState> = {
  waiting: { "scenario.proved": scenarioProved },
  pending: { "scenario.proved": scenarioProved },
  verifying: { "scenario.verified": [{ guard: "verdictTrusted", to: "trusted" }, { to: "rejected" }] },
}

/** A task that reaches one of these states ends the run in the state given. */
export const runFollows: Partial<Record<TaskState, RunState>> = {
  needs_human: "needs_human",
  budget_exhausted: "budget_exhausted",
  failed: "failed",
}

/** The facts that count as a return to the builder when a task's row leads to `building`. */
export const returnsToBuilder: ReadonlyArray<FactType> = ["task.proved", "task.verified", "task.repeated"]

// --- the fold -----------------------------------------------------------------------------------------------------

const pick = <S extends string>(table: Table<S>, from: S, input: GuardInput): Row<S> | undefined => {
  const rows = table[from]?.[input.fact.type]
  if (rows === undefined) return undefined
  return rows.find((row) => row.guard === undefined || guards[row.guard](input))
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

const appended = (state: State, item: History): ReadonlyArray<History> => [...state.history, item]

// The reason a task's new state carries, read from the state after the fact's obligation moves.
const taskReason = (state: State, fact: TaskFact | RunFact | FactOf<"obligation.stale">, id: string, to: TaskState) => {
  switch (fact.type) {
    case "task.proved":
      if (to === "verifying") return undefined
      return joined([
        fact.reason,
        ...fact.results
          .filter((result) => result.status === "failed")
          .map((result) => `${result.id}: ${result.reason ?? "failed"}`),
      ])
    case "task.verified":
      if (to === "trusted") return undefined
      return joined(
        obligationsOf(state, id)
          .filter((obligation) => obligation.state !== "trusted")
          .map((obligation) =>
            obligation.state === "rejected"
              ? `${obligation.id}: ${obligation.reason ?? "rejected"}`
              : `${obligation.id}: not judged`,
          ),
      )
    case "task.stalled":
    case "task.repeated":
    case "task.needs_human":
    case "task.failed":
    case "run.cancelled":
      return fact.reason
    case "obligation.stale":
      return `stale: ${fact.id}`
    default:
      return undefined
  }
}

const taskFields = (fact: Fact): Partial<TaskModel> => {
  if (fact.type === "task.started")
    return { worktree: fact.worktree, branch: fact.branch, base: fact.base, session: fact.session }
  if (fact.type === "task.ready") return { head: fact.head }
  return {}
}

const attemptsAfter = (task: TaskModel, fact: Fact, to: TaskState) => {
  if (fact.type === "task.started") return 1
  // A parent counts its one review.
  if (!task.leaf && to === "trusted") return 1
  if (to === "building" && returnsToBuilder.includes(fact.type)) return task.attempts + 1
  return task.attempts
}

// `reason` is what the run keeps; `noted` is what its history entry says.
const moveRun = (
  state: State,
  at: number,
  to: RunState,
  why: { readonly reason?: string; readonly noted?: string },
): State => ({
  ...state,
  run: { ...state.run, state: to, reason: why.reason },
  history: appended(state, entry(at, RUN, state.run.state, to, why.noted)),
})

const moveTask = (
  state: State,
  fact: TaskFact | RunFact | FactOf<"obligation.stale">,
  id: string,
  to: TaskState,
): State => {
  const task = state.tasks[id]
  const reason = taskReason(state, fact, id, to)
  const next: TaskModel = { ...task, ...taskFields(fact), state: to, attempts: attemptsAfter(task, fact, to), reason }
  const moved: State = {
    ...state,
    tasks: { ...state.tasks, [id]: next },
    history: appended(state, entry(fact.at, id, task.state, to, reason)),
  }
  const run = runFollows[to]
  if (run === undefined || ended(moved.run.state)) return moved
  const why = reason === undefined ? id : `${id}: ${reason}`
  return moveRun(moved, fact.at, run, { reason: why, noted: why })
}

const obligationReason = (fact: Fact, id: string, to: ObligationState) => {
  if (to === "failed") return resultOf(fact, id)?.reason
  if (to === "rejected") return verdictOf(fact, id)?.reason
  return undefined
}

const moveObligation = (state: State, fact: Fact, obligation: ObligationModel, to: ObligationState): State => {
  const reason = obligationReason(fact, obligation.id, to)
  const hash = fact.type === "obligation.stale" ? fact.hash : obligation.hash
  return {
    ...state,
    obligations: { ...state.obligations, [obligation.id]: { ...obligation, state: to, hash, reason } },
    history: appended(state, entry(fact.at, obligation.id, obligation.state, to, reason)),
  }
}

// Moves every obligation of `task` that has a matching row, in plan order.
const moveObligations = (plan: Plan, state: State, fact: Fact, task: string): State =>
  obligationsOf(state, task).reduce((current, obligation) => {
    const row = pick(obligationTable, obligation.state, { plan, state: current, fact, id: obligation.id })
    if (row === undefined) return current
    return moveObligation(current, fact, obligation, row.to)
  }, state)

const applyTask = (plan: Plan, state: State, fact: TaskFact): State => {
  const task = taskOf(state, fact.task)
  if (task === undefined || taskTable[task.state]?.[fact.type] === undefined) return state
  const judged =
    fact.type === "task.proved" || fact.type === "task.verified" ? moveObligations(plan, state, fact, task.id) : state
  const row = pick(taskTable, task.state, { plan, state: judged, fact, id: task.id })
  if (row === undefined) return state
  return moveTask(judged, fact, task.id, row.to)
}

const applyRun = (plan: Plan, state: State, fact: RunFact): State => {
  const row = pick(runTable, state.run.state, { plan, state, fact, id: RUN })
  if (row === undefined) return state
  // Only `run.cancelled` has task rows: it cancels every active task before the run.
  const tasks = Object.values(state.tasks).reduce((current, task) => {
    const taskRow = pick(taskTable, task.state, { plan, state: current, fact, id: task.id })
    if (taskRow === undefined) return current
    return moveTask(current, fact, task.id, taskRow.to)
  }, state)
  switch (fact.type) {
    case "run.resumed":
      return moveRun(tasks, fact.at, row.to, { noted: "resumed" })
    case "run.ended":
    case "run.cancelled":
      return moveRun(tasks, fact.at, row.to, { reason: fact.reason, noted: fact.reason })
    default:
      return moveRun(tasks, fact.at, row.to, {})
  }
}

const applyStale = (plan: Plan, state: State, fact: FactOf<"obligation.stale">): State => {
  const obligation = obligationOf(state, fact.id)
  if (obligation === undefined) return state
  const row = pick(obligationTable, obligation.state, { plan, state, fact, id: obligation.id })
  if (row === undefined) return state
  const staled = moveObligation(state, fact, obligation, row.to)
  const task = taskOf(staled, obligation.task)
  if (task === undefined) return staled
  const taskRow = pick(taskTable, task.state, { plan, state: staled, fact, id: task.id })
  if (taskRow === undefined) return staled
  return moveTask(staled, fact, task.id, taskRow.to)
}

const scenarioReason = (fact: ScenarioFact, to: ScenarioState) => {
  if (fact.type === "scenario.proved" && to === "failed") return fact.reason
  if (fact.type === "scenario.verified" && to === "rejected") return fact.verdict.reason
  return undefined
}

const applyScenario = (plan: Plan, state: State, fact: ScenarioFact): State => {
  const id = fact.type === "scenario.proved" ? fact.id : fact.verdict.id
  const scenario: ScenarioModel | undefined = state.scenarios[id]
  if (scenario === undefined) return state
  const row = pick(scenarioTable, scenario.state, { plan, state, fact, id })
  if (row === undefined) return state
  const reason = scenarioReason(fact, row.to)
  return {
    ...state,
    scenarios: { ...state.scenarios, [id]: { ...scenario, state: row.to, reason } },
    history: appended(state, entry(fact.at, id, scenario.state, row.to, reason)),
  }
}

/** The first state of a run: every task waiting, every obligation pending, every scenario waiting. */
export const initial = (plan: Plan): State => {
  const ids = plan.tasks.map((task) => task.id)
  return {
    run: { state: "running", spec: plan.specPath, path: plan.path },
    tasks: Object.fromEntries(
      plan.tasks.map((task): [string, TaskModel] => [
        task.id,
        { id: task.id, leaf: task.children.length === 0, state: "waiting", attempts: 0 },
      ]),
    ),
    obligations: Object.fromEntries(
      plan.spec.obligations
        .filter((obligation) => ids.includes(obligation.task))
        .map((obligation): [string, ObligationModel] => [
          obligation.id,
          { id: obligation.id, task: obligation.task, state: "pending", hash: obligation.hash },
        ]),
    ),
    scenarios: Object.fromEntries(
      plan.scenarios.map((scenario): [string, ScenarioModel] => [scenario.id, { id: scenario.id, state: "waiting" }]),
    ),
    history: [],
  }
}

/** One fold step. Pure: the same plan, state and fact always give the same new state. */
export const apply = (plan: Plan, state: State, fact: Fact): State => {
  if (ended(state.run.state)) return state
  switch (fact.type) {
    case "outside.trusted":
      return { ...state, history: appended(state, { at: fact.at, unit: fact.id, to: "trusted", reason: "outside" }) }
    case "run.started":
    case "run.resumed":
    case "run.ended":
    case "run.cancelled":
      return applyRun(plan, state, fact)
    case "obligation.stale":
      return applyStale(plan, state, fact)
    case "scenario.proved":
    case "scenario.verified":
      return applyScenario(plan, state, fact)
    default:
      return applyTask(plan, state, fact)
  }
}

export const TableEngine: Engine = { name: "table", initial, apply }

export * as TaskEngineTable from "."

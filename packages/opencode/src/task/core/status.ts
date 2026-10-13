import { Effect, FileSystem, Path, Random, Schema } from "effect"
import type { Plan, RunState, State, TaskState } from "./model"

// The status file of the harness contract (section 3): a projection of the folded state, rewritten atomically
// (temp file, then rename) after every fact. The real state lives in the durable facts (`./events`).

const Text = Schema.String
const Reason = Schema.optional(Schema.String)

const RunStateSchema = Schema.Literals([
  "running",
  "refused",
  "waiting",
  "done",
  "cancelled",
  "needs_human",
  "budget_exhausted",
  "failed",
])
const TaskStateSchema = Schema.Literals([
  "waiting",
  "building",
  "proving",
  "verifying",
  "trusted",
  "stalled",
  "needs_human",
  "budget_exhausted",
  "cancelled",
  "failed",
])
const ObligationStateSchema = Schema.Literals(["pending", "passed", "failed", "trusted", "rejected", "stale"])
// The contract has no `verifying` scenario: a scenario under judgement is `pending`.
const ScenarioStateSchema = Schema.Literals(["waiting", "pending", "trusted", "rejected", "failed"])

const TaskStatus = Schema.Struct({
  state: TaskStateSchema,
  attempts: Schema.Number,
  waitingOn: Schema.Array(Text),
  worktree: Reason,
  reason: Reason,
}).annotate({ identifier: "TaskStatus.Task" })

const ObligationStatus = Schema.Struct({ state: ObligationStateSchema, reason: Reason }).annotate({
  identifier: "TaskStatus.Obligation",
})

const ScenarioStatus = Schema.Struct({
  state: ScenarioStateSchema,
  waitingOn: Schema.Array(Text),
  reason: Reason,
}).annotate({ identifier: "TaskStatus.Scenario" })

const HistoryEntry = Schema.Struct({
  at: Schema.Number,
  unit: Text,
  from: Reason,
  to: Text,
  reason: Reason,
}).annotate({ identifier: "TaskStatus.History" })

export const Harness = Schema.Literals(["o1", "o2", "o3"])
export type Harness = typeof Harness.Type

export const Status = Schema.Struct({
  harness: Harness,
  run: Schema.Struct({ state: RunStateSchema, reason: Reason, spec: Text, path: Text }),
  tasks: Schema.Record(Text, TaskStatus),
  obligations: Schema.Record(Text, ObligationStatus),
  scenarios: Schema.Record(Text, ScenarioStatus),
  history: Schema.Array(HistoryEntry),
}).annotate({ identifier: "TaskStatus" })
export type Status = typeof Status.Type

const encode = Schema.encodeSync(Schema.fromJsonString(Status))

const ACTIVE: ReadonlyArray<TaskState> = ["building", "proving", "verifying"]

/** The input of the projection: the folded state, its plan, and the `outside` ids the store records as trusted. */
export interface Input {
  readonly harness: Harness
  readonly plan: Plan
  readonly state: State
  readonly outside: ReadonlyArray<string>
}

/**
 * Whether an id that a task or scenario depends on is trusted: a plan task by its state, an `outside` id by the
 * trusted set. An id that is neither counts as not trusted.
 */
export const trusted = (input: Omit<Input, "harness">) => (id: string) => {
  const task = input.state.tasks[id]
  if (task) return task.state === "trusted"
  if (id in input.plan.spec.outside) return input.outside.includes(id)
  return false
}

/** The ids of `ids` that are not trusted. */
export const waitingOn = (input: Omit<Input, "harness">, ids: ReadonlyArray<string>) =>
  ids.filter((id) => !trusted(input)(id))

const runState = (input: Input): RunState => {
  const stored = input.state.run.state
  if (stored !== "running") return stored
  const tasks = Object.values(input.state.tasks)
  const scenarios = Object.values(input.state.scenarios)
  const busy = tasks.some((task) => ACTIVE.includes(task.state)) || scenarios.some((s) => s.state === "verifying")
  const waits = tasks.some((task) => task.state === "waiting") || scenarios.some((s) => s.state === "waiting")
  return !busy && waits ? "waiting" : "running"
}

/** The status of a run (contract section 3). */
export const project = (input: Input): Status => {
  const { plan, state } = input
  const after = (id: string) => plan.tasks.find((task) => task.id === id)?.afterEffective ?? []
  const needs = (id: string) => plan.scenarios.find((scenario) => scenario.id === id)?.needs ?? []
  return {
    harness: input.harness,
    run: { state: runState(input), reason: state.run.reason, spec: state.run.spec, path: state.run.path },
    tasks: Object.fromEntries(
      Object.values(state.tasks).map((task) => [
        task.id,
        {
          state: task.state,
          attempts: task.attempts,
          waitingOn: waitingOn(input, after(task.id)),
          worktree: task.worktree,
          reason: task.reason,
        },
      ]),
    ),
    obligations: Object.fromEntries(
      Object.values(state.obligations).map((obligation) => [
        obligation.id,
        { state: obligation.state, reason: obligation.reason },
      ]),
    ),
    scenarios: Object.fromEntries(
      Object.values(state.scenarios).map((scenario) => [
        scenario.id,
        {
          state: scenario.state === "verifying" ? "pending" : scenario.state,
          waitingOn: waitingOn(input, needs(scenario.id)),
          reason: scenario.reason,
        },
      ]),
    ),
    history: state.history.map((entry) => ({ ...entry })),
  }
}

/** The status of a refused `/task`: the first failing rule, and no records. */
export const refused = (input: { harness: Harness; spec: string; path: string; reason: string }): Status => ({
  harness: input.harness,
  run: { state: "refused", reason: input.reason, spec: input.spec, path: input.path },
  tasks: {},
  obligations: {},
  scenarios: {},
  history: [],
})

/** `<directory>/.opencode/task/status.json`. */
export const file = (path: Path.Path, directory: string) => path.join(directory, ".opencode", "task", "status.json")

/**
 * `<directory>/.opencode/task/proofs/<name>.log`: the live output of a proving pass, `name` a task id or `scenarios`.
 * The task UI reads the same path.
 */
export const proofLogFile = (path: Path.Path, directory: string, name: string) =>
  path.join(directory, ".opencode", "task", "proofs", `${name}.log`)

/** Writes the status atomically: a temp file next to it, then a rename. A failed write is logged, not raised. */
export const write = Effect.fn("TaskStatus.write")(
  function* (directory: string, status: Status) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = file(path, directory)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    const temp = `${target}.${yield* Random.nextIntBetween(0, 0x7fffffff)}.tmp`
    yield* fs.writeFileString(temp, `${encode(status)}\n`)
    yield* fs.rename(temp, target)
  },
  Effect.catch((error) => Effect.logWarning("task harness: the status write failed", { error: error.message })),
)

export * as TaskStatus from "./status"

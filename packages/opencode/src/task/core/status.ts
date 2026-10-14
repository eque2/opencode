import { Effect, FileSystem, Path, Random, Schema } from "effect"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import type { Plan } from "./model"

// The status file of the harness contract (section 3): a projection of the run machine's snapshot through the
// engine's `view`, rewritten atomically (temp file, then rename) after every fact. The real state lives in the
// durable facts (`./events`).

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
  "blocked",
])
const ObligationStateSchema = Schema.Literals(["pending", "passed", "failed", "trusted", "rejected", "stale"])
// The contract has no `verifying` scenario: a scenario under judgement is `pending`.
const ScenarioStateSchema = Schema.Literals([
  "waiting",
  "pending",
  "trusted",
  "rejected",
  "failed",
  "blocked",
  "cancelled",
])

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

export const Status = Schema.Struct({
  run: Schema.Struct({ state: RunStateSchema, reason: Reason, spec: Text, path: Text }),
  tasks: Schema.Record(Text, TaskStatus),
  obligations: Schema.Record(Text, ObligationStatus),
  scenarios: Schema.Record(Text, ScenarioStatus),
  history: Schema.Array(HistoryEntry),
}).annotate({ identifier: "TaskStatus" })
export type Status = typeof Status.Type

const encode = Schema.encodeSync(Schema.fromJsonString(Status))

/** The input of the projection: the run machine's snapshot and its plan. */
export interface Input {
  readonly plan: Plan
  readonly snapshot: RunSnapshot
}

/** Whether a unit that a task or scenario depends on is trusted: a plan task, an `outside` or an external region. */
export const trusted = (input: Input) => (id: string) => TaskEngineXState.unitState(input.snapshot, id) === "trusted"

/**
 * The status of a run (contract section 3): the snapshot read through the engine's `view`. The run's `running` or
 * `waiting` is the machine's; a unit's `waitingOn` is the engine's selector, the dependencies it waits on.
 */
export const project = (input: Input): Status => {
  const { snapshot } = input
  const state = TaskEngineXState.view(snapshot)
  return {
    run: { state: state.run.state, reason: state.run.reason, spec: state.run.spec, path: state.run.path },
    tasks: Object.fromEntries(
      Object.values(state.tasks).map((task) => [
        task.id,
        {
          state: task.state,
          attempts: task.attempts,
          waitingOn: [...TaskEngineXState.waitingOn(snapshot, task.id)],
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
          waitingOn: [...TaskEngineXState.waitingOn(snapshot, scenario.id)],
          reason: scenario.reason,
        },
      ]),
    ),
    history: state.history.map((entry) => ({ ...entry })),
  }
}

/** The status of a refused `/task`: the first failing rule, and no records. */
export const refused = (input: { spec: string; path: string; reason: string }): Status => ({
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

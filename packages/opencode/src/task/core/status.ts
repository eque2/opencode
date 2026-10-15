import { Effect, FileSystem, Path, Random, Schema } from "effect"
import { type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import type { Plan } from "./model"

// The status file of the harness (AD-13): a projection of the run machine's snapshot, rewritten atomically (temp file,
// then rename). The real state lives in the durable facts (`./events`); the TUI reads this file and decides nothing.

const Text = Schema.String
const At = Schema.Number
const optional = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)

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
const OutsideStateSchema = Schema.Literals(["untrusted", "trusted"])

/** The class tags (AD-13): the file never holds a phase tag or a `waits:` tag. */
const Tag = Schema.Literals(["waiting", "active", "ended", "stopped", "blocked", "dead"]).annotate({
  identifier: "TaskStatus.Tag",
})
const Tags = Schema.Array(Tag)
const Cause = Schema.Struct({ id: Text, state: Text }).annotate({ identifier: "TaskStatus.Cause" })
const Span = Schema.Struct({ state: Text, from: At, to: optional(At) }).annotate({ identifier: "TaskStatus.Span" })

const RunStatus = Schema.Struct({
  state: RunStateSchema,
  tags: Tags,
  /** The outcome reason, one line per item; for a refusal, one line per failure. */
  reason: optional(Text),
  /** The latest spec.checked failures, one line each (AD-14); absent when none. */
  warning: optional(Text),
  /** The spec folder, relative to the directory. */
  spec: Text,
  /** The spec id: the folder name. */
  specId: Text,
  /** The `/task` argument. */
  path: Text,
  /** The SPEC.md H1; the spec id when the H1 is empty or the spec did not load. */
  title: Text,
  /** A subtree run's root task: the only task title in the file. */
  task: optional(Schema.Struct({ id: Text, title: Text })),
  startedAt: optional(At),
  endedAt: optional(At),
  /** The heartbeat: when the status writer last wrote (AD-9). `project` never emits it; `write` stamps it. */
  aliveAt: optional(At),
}).annotate({ identifier: "TaskStatus.Run" })

const TaskStatus = Schema.Struct({
  state: TaskStateSchema,
  tags: Tags,
  attempts: Schema.Number,
  /** Every id the task waits on: plan tasks, outside and external (AD-3); empty unless tagged waiting. */
  waitingOn: Schema.Array(Text),
  /** The ids of `waitingOn` that are keys of `outside`. */
  waitingOnOutside: Schema.Array(Text),
  worktree: optional(Text),
  reason: optional(Text),
  blockedBy: optional(Cause),
  startedAt: optional(At),
  endedAt: optional(At),
  spans: Schema.Array(Span),
}).annotate({ identifier: "TaskStatus.Task" })

const ObligationStatus = Schema.Struct({
  state: ObligationStateSchema,
  tags: Tags,
  reason: optional(Text),
  startedAt: optional(At),
  endedAt: optional(At),
}).annotate({ identifier: "TaskStatus.Obligation" })

const ScenarioStatus = Schema.Struct({
  state: ScenarioStateSchema,
  tags: Tags,
  /** The loader's scenario title, with no leading id. */
  title: Text,
  waitingOn: Schema.Array(Text),
  waitingOnOutside: Schema.Array(Text),
  reason: optional(Text),
  blockedBy: optional(Cause),
  startedAt: optional(At),
  endedAt: optional(At),
}).annotate({ identifier: "TaskStatus.Scenario" })

const RegionStatus = Schema.Struct({ state: OutsideStateSchema, tags: Tags }).annotate({
  identifier: "TaskStatus.Region",
})

const HistoryEntry = Schema.Struct({
  at: At,
  unit: Text,
  from: optional(Text),
  to: Text,
  reason: optional(Text),
}).annotate({ identifier: "TaskStatus.History" })

/** The status file (AD-13). */
export const Status = Schema.Struct({
  run: RunStatus,
  tasks: Schema.Record(Text, TaskStatus),
  obligations: Schema.Record(Text, ObligationStatus),
  scenarios: Schema.Record(Text, ScenarioStatus),
  /** The spec's outside preconditions. */
  outside: Schema.Record(Text, RegionStatus),
  /** The folder tasks outside a subtree run that it waits on (AD-15). */
  external: Schema.Record(Text, RegionStatus),
  history: Schema.Array(HistoryEntry),
}).annotate({ identifier: "TaskStatus" })
export type Status = typeof Status.Type
type Tag = typeof Tag.Type

const encode = Schema.encodeSync(Schema.fromJsonString(Status))

// An absent optional value is an absent key, never `undefined` (AD-13): each optional field is spread only when set.
const has = <V>(value: V | undefined): value is V => value !== undefined

/** The spec id of a spec folder: its last path segment. */
const specIdOf = (spec: string) => spec.split("/").filter((part) => part !== "").at(-1) ?? spec

/**
 * The status of a run (AD-13): the snapshot's meta (through `view`), tags and context, and the plan's static text
 * (titles, spec id, path). It decides nothing: every class is a tag of the run machine.
 */
export const project = (plan: Plan, snapshot: RunSnapshot): Status => {
  const state = TaskEngineXState.view(snapshot)
  const units = snapshot.context.units
  const outside = Object.keys(plan.spec.outside)
  const tags = (id: string): Array<Tag> => [...TaskEngineXState.tags(snapshot, id)]
  const waits = (id: string) => {
    const on = [...TaskEngineXState.waitingOn(snapshot, id)]
    return { waitingOn: on, waitingOnOutside: on.filter((each) => outside.includes(each)) }
  }
  const times = (id: string) => {
    const startedAt = units[id]?.startedAt
    const endedAt = units[id]?.endedAt
    return { ...(has(startedAt) ? { startedAt } : {}), ...(has(endedAt) ? { endedAt } : {}) }
  }
  const cause = (id: string) => {
    const blockedBy = TaskEngineXState.blockedBy(snapshot, id)
    return has(blockedBy) ? { blockedBy } : {}
  }
  const region = (id: string) => ({
    state: TaskEngineXState.unitState(snapshot, id) === "trusted" ? ("trusted" as const) : ("untrusted" as const),
    tags: tags(id),
  })
  const specId = specIdOf(plan.specPath)
  const root = plan.tasks.find((task) => task.id === plan.root)
  return {
    run: {
      state: state.run.state,
      tags: tags("run"),
      ...(has(state.run.reason) ? { reason: state.run.reason } : {}),
      spec: plan.specPath,
      specId,
      path: plan.path,
      title: plan.spec.title === "" ? specId : plan.spec.title,
      ...(has(root) ? { task: { id: root.id, title: root.title } } : {}),
      ...times("run"),
    },
    tasks: Object.fromEntries(
      Object.values(state.tasks).map((task) => [
        task.id,
        {
          state: task.state,
          tags: tags(task.id),
          attempts: task.attempts,
          ...waits(task.id),
          ...(has(task.worktree) ? { worktree: task.worktree } : {}),
          ...(has(task.reason) ? { reason: task.reason } : {}),
          ...cause(task.id),
          ...times(task.id),
          spans: (units[task.id]?.spans ?? []).map((span) => ({
            state: span.state,
            from: span.from,
            ...(has(span.to) ? { to: span.to } : {}),
          })),
        },
      ]),
    ),
    obligations: Object.fromEntries(
      Object.values(state.obligations).map((obligation) => [
        obligation.id,
        {
          state: obligation.state,
          tags: tags(obligation.id),
          ...(has(obligation.reason) ? { reason: obligation.reason } : {}),
          ...times(obligation.id),
        },
      ]),
    ),
    scenarios: Object.fromEntries(
      Object.values(state.scenarios).map((scenario) => [
        scenario.id,
        {
          state: scenario.state,
          tags: tags(scenario.id),
          title: plan.scenarios.find((each) => each.id === scenario.id)?.title ?? scenario.id,
          ...waits(scenario.id),
          ...(has(scenario.reason) ? { reason: scenario.reason } : {}),
          ...cause(scenario.id),
          ...times(scenario.id),
        },
      ]),
    ),
    outside: Object.fromEntries(outside.map((id) => [id, region(id)])),
    external: Object.fromEntries(plan.external.map((id) => [id, region(id)])),
    history: state.history.map((entry) => ({
      at: entry.at,
      unit: entry.unit,
      ...(has(entry.from) ? { from: entry.from } : {}),
      to: entry.to,
      ...(has(entry.reason) ? { reason: entry.reason } : {}),
    })),
  }
}

/** The status of a refused `/task` (AD-14): the failures, and no records. */
export const refused = (input: {
  readonly spec: string
  readonly path: string
  readonly reason: string
  readonly title?: string
}): Status => {
  const specId = specIdOf(input.spec)
  return {
    run: {
      state: "refused",
      tags: ["ended", "stopped"],
      reason: input.reason,
      spec: input.spec,
      specId,
      path: input.path,
      title: has(input.title) && input.title !== "" ? input.title : specId,
    },
    tasks: {},
    obligations: {},
    scenarios: {},
    outside: {},
    external: {},
    history: [],
  }
}

/** `<directory>/.opencode/task/status.json`. */
export const file = (path: Path.Path, directory: string) => path.join(directory, ".opencode", "task", "status.json")

/**
 * `<directory>/.opencode/task/proofs/<name>.log`: the live output of a proving pass, `name` a task id or `scenarios`.
 * The task UI reads the same path.
 */
export const proofLogFile = (path: Path.Path, directory: string, name: string) =>
  path.join(directory, ".opencode", "task", "proofs", `${name}.log`)

/**
 * Writes the status atomically: a temp file next to it, then a rename. `aliveAt` stamps the heartbeat (AD-9, AD-13).
 * A failed write is logged, not raised.
 */
export const write = Effect.fn("TaskStatus.write")(
  function* (directory: string, status: Status, aliveAt?: number) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const target = file(path, directory)
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    const temp = `${target}.${yield* Random.nextIntBetween(0, 0x7fffffff)}.tmp`
    const stamped = aliveAt === undefined ? status : { ...status, run: { ...status.run, aliveAt } }
    yield* fs.writeFileString(temp, `${encode(stamped)}\n`)
    yield* fs.rename(temp, target)
  },
  Effect.catch((error) => Effect.logWarning("task harness: the status write failed", { error: error.message })),
)

export * as TaskStatus from "./status"

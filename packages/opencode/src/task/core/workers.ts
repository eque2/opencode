import { Clock, Duration, Effect, Fiber, FileSystem, Option, Path, Schedule, Schema, Stream } from "effect"
import { type EventObject, fromCallback } from "@jambudipa/xstate-effect"
import type { EventV2 } from "@opencode-ai/core/event"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import type { TaskLimits } from "@/task/limits"
import { TaskProof } from "@/task/proof"
import type { Locks } from "./harness"
import { TaskHooks } from "./hooks"
import type { Plan, Result as Proved, State, TaskModel, Verdict } from "./model"
import type { Recorder, Unstamped } from "./recorder"
import { TaskSessions } from "./sessions"
import { TaskStatus } from "./status"
import { TaskWorkspace } from "./workspace"

// The stateless workers of a run (spine AD-8, AD-11, D7): each one runs one Effect and returns, and none keeps
// anything between calls. A supervisor invokes them; to stop one, it interrupts the Effect, and the Effect's
// finalizer cancels its session turn within `limits.cancelDeadline`. Every merge, proof on the base branch, scenario
// proof and stale check reads or moves the root checkout only under the lease's checkout lock, and worktree creation
// takes the lease's git lock (AD-19). A worker that needs a wider view reads the run actor's snapshot.

/** What the workers of one run read. The current spec is an argument, because the run supervisor holds it (AD-12). */
export interface Run {
  readonly env: TaskSessions.Env
  readonly id: string
  /** The instance directory: the root checkout. */
  readonly directory: string
  /** The branch the leaves branch from and merge into. */
  readonly base: string
  /** The spec folder, absolute. */
  readonly specDir: string
  readonly plan: Plan
  /** The root session of the latest `/task`: the parent of every child session. */
  readonly root: SessionID
  readonly model: TaskSessions.Model
  readonly limits: TaskLimits.Limits
  readonly locks: Locks
  readonly recorder: Pick<Recorder, "actor" | "record" | "touch">
  /** `session.claim` on the harness root: records the owner and waits until the index holds it (AD-11). */
  readonly claim: (input: {
    readonly session: string
    readonly owner: string
    readonly watch: boolean
  }) => Effect.Effect<void, unknown>
}

/** A worker could not do its work; the supervisor counts it toward its failure rule. */
export class WorkerError extends Schema.TaggedError<WorkerError>()("TaskWorkerError", { message: Schema.String }) {}

/** A merge is tried this many more times before it fails (the index lock of a concurrent git call clears). */
export const MERGE_RETRY = 3

/** The reason of a builder that ended without `task_ready` after its last nudge. */
export const NO_READY = "the builder ended without task_ready"

// --- pure helpers (moved from the polled runner) ------------------------------------------------------------------

/**
 * One verdict per id: the last one the judge recorded. A judge that records an id twice (rejected, then trusted)
 * must not let the merge decision and the engine read different verdicts.
 */
export const latestVerdicts = (verdicts: ReadonlyArray<Verdict>) =>
  verdicts.filter((verdict, index) => verdicts.findLastIndex((other) => other.id === verdict.id) === index)

const judged = (judges: ReadonlyArray<string>) => judges.includes("verifier") || judges.includes("reviewer")

/**
 * The proof results as facts: a failed proof is `failed` (a structural violation fails every test obligation and
 * names the path); a passed proof that a verifier or reviewer must judge, or a review, is `needs-judge`; a passed
 * proof the runner or engine alone judges is `passed`. A failed gate of the task (its VERIFY.md `gates`) fails every
 * test obligation that did not fail on its own, as a structural violation does, so the task goes back to the builder.
 */
export const results = (
  spec: Pick<BlendModel.Spec, "obligations">,
  proof: TaskProof.TaskProof,
  taskGates: ReadonlyArray<string>,
) => {
  const gates = proof.gates.flatMap((gate) =>
    gate.status === "failed" && taskGates.includes(gate.gate) ? [`gate ${gate.gate} failed: ${gate.reason}`] : [],
  )
  const blocked = gates.join("; ")
  const mapped = proof.obligations.map((item): Proved => {
    const obligation = spec.obligations.find((candidate) => candidate.id === item.id)
    if (item.status === "failed") return { id: item.id, status: "failed", reason: item.reason }
    if (gates.length > 0 && item.proof === "test") return { id: item.id, status: "failed", reason: blocked }
    if (item.status === "needs-review") return { id: item.id, status: "needs-judge" }
    return { id: item.id, status: judged(obligation?.judges ?? []) ? "needs-judge" : "passed" }
  })
  const structural =
    proof.structural.status === "failed"
      ? [`structural: ${proof.structural.violations.map((violation) => violation.path).join(", ")}`]
      : []
  const reasons = [...structural, ...gates]
  return { results: mapped, reason: reasons.length > 0 ? Option.some(reasons.join("; ")) : Option.none<string>() }
}

/** The payload of a `task.proved`: the results, and the reason when the proof failed as a whole. */
export type Proof = ReturnType<typeof results>

/** A scenario's tag result as a fact: passed stays passed; failed, and skipped (no test ran), are failed. */
export const scenarioOutcome = (
  proof: TaskProof.ScenarioProof,
): { readonly status: "passed" } | { readonly status: "failed"; readonly reason: string } => {
  const result = proof.result
  if (result.status === "passed") return { status: "passed" }
  if (result.status === "failed") return { status: "failed", reason: result.reason }
  return { status: "failed", reason: `skipped: every test titled [${proof.scenario}] was skipped` }
}

/**
 * When a task's wall clock started: its latest `building` entry after its latest `trusted` entry, so a trusted task
 * reopened later starts afresh; never before `runStart` (the latest start or resume), so downtime does not count.
 * None for a task with no such entry.
 */
export const taskClockStart = (history: State["history"], task: string, runStart: number): Option.Option<number> => {
  const own = history.filter((entry) => entry.unit === task)
  const after = own.slice(own.findLastIndex((entry) => entry.to === "trusted") + 1)
  return Option.map(Option.fromNullishOr(after.findLast((entry) => entry.to === "building")), (entry) =>
    Math.max(entry.at, runStart),
  )
}

/**
 * The live output of one proving pass, `<directory>/.opencode/task/proofs/<name>.log`, emptied at the start of the
 * pass: the proof runner appends each test and gate command and its output as they arrive, so the task UI can show
 * the proofs running. It is telemetry: when the file cannot be made, the pass runs without it.
 */
export const proofLog = Effect.fnUntraced(function* (directory: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = TaskStatus.proofLogFile(path, directory, name)
  const made = yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.andThen(fs.writeFileString(file, "")), Effect.as(file), Effect.option)
  return Option.getOrUndefined(made)
})

const obligationsOf = (spec: BlendModel.Spec, task: string) =>
  spec.obligations.filter((obligation) => obligation.task === task)

/**
 * The obligations a later attempt reopens, with the reason of each: failed proofs, rejected verdicts, or, when the
 * attempt ended otherwise (a repetition), every obligation not yet trusted with the task's reason.
 */
export const reopened = (spec: BlendModel.Spec, state: State, task: TaskModel): ReadonlyArray<TaskSessions.Reopen> => {
  const own = obligationsOf(spec, task.id).flatMap((obligation) =>
    Option.toArray(Option.fromNullishOr(state.obligations[obligation.id])),
  )
  const open = own.filter((obligation) => obligation.state === "failed" || obligation.state === "rejected")
  if (open.length > 0) {
    return open.map((obligation) => ({ id: obligation.id, reason: obligation.reason ?? obligation.state }))
  }
  const reason = task.reason ?? "the previous attempt did not finish"
  return own.filter((obligation) => obligation.state !== "trusted").map((obligation) => ({ id: obligation.id, reason }))
}

// --- sessions -----------------------------------------------------------------------------------------------------

const snapshotOf = (run: Run) => run.recorder.actor.getSnapshot

const taskModel = Effect.fnUntraced(function* (run: Run, task: string) {
  const model = TaskEngineXState.view(yield* snapshotOf(run)).tasks[task]
  if (model === undefined) return yield* new WorkerError({ message: `${task} is not a task of the run` })
  return model
})

// Cancels a turn in its own instance, bounded by the cancel deadline. It runs in an interruption finalizer, which is
// uninterruptible, so the bound is made interruptible explicitly.
const cancelTurn = (run: Run, directory: string, session: SessionID) =>
  TaskSessions.cancel(run.env, directory, session).pipe(
    Effect.interruptible,
    Effect.timeoutOption(run.limits.cancelDeadline),
    Effect.ignore,
  )

/** The end of a turn: its session, when it started, and the spend-cap error that ended it, if one did. */
export interface Turn {
  readonly session: SessionID
  readonly started: number
  readonly spendCap: Option.Option<string>
}

// One turn: claim the session for its owner and wait for the index entry, then prompt until the turn ends. An
// interruption cancels the turn.
const turn = Effect.fnUntraced(function* (
  run: Run,
  input: {
    readonly directory: string
    readonly session: SessionID
    readonly agent: string
    readonly text: string
    readonly owner: string
    readonly watch: boolean
  },
) {
  yield* run.claim({ session: input.session, owner: input.owner, watch: input.watch })
  const started = yield* Clock.currentTimeMillis
  yield* TaskSessions.prompt(run.env, input.directory, {
    session: input.session,
    agent: input.agent,
    model: run.model,
    text: input.text,
  }).pipe(Effect.onInterrupt(() => cancelTurn(run, input.directory, input.session)))
  const cap = yield* TaskSessions.spendCapError(run.env, input.session, started)
  return {
    session: input.session,
    started,
    spendCap: Option.map(cap, (text) => `spend cap: ${TaskSessions.oneLine(text)}`),
  } satisfies Turn
})

/**
 * A leaf whose dependencies are trusted: its worktree (under the git lock) and its builder session. The supervisor
 * records `task.started` with the result.
 */
export const begin = Effect.fn("TaskWorkers.begin")(function* (run: Run, task: BlendModel.Task) {
  const tree = yield* run.locks.git.withPermit(
    TaskWorkspace.ensureWorktree(run.directory, run.id, task.id, run.base, run.limits),
  )
  const session = yield* TaskSessions.create(run.env, tree.worktree, {
    parentID: run.root,
    title: `${task.id} builder`,
    agent: TaskHooks.BUILDER,
  })
  return { worktree: tree.worktree, branch: tree.branch, base: tree.base, session: session.id }
})

/** What a builder turn sends: the attempt's message (or `continue` for a session that has it), or a short prompt. */
export type BuilderPrompt = "attempt" | "continue" | "nudge"

/** The text of a builder turn. An attempt's message is sent once per attempt: a session that has it continues. */
export const builderText = Effect.fn("TaskWorkers.builderText")(function* (
  run: Run,
  input: { readonly task: BlendModel.Task; readonly spec: BlendModel.Spec; readonly prompt: BuilderPrompt },
) {
  if (input.prompt === "continue") return TaskSessions.continueMessage
  if (input.prompt === "nudge") return TaskSessions.nudgeMessage
  const snapshot = yield* snapshotOf(run)
  const model = yield* taskModel(run, input.task.id)
  if (model.session === undefined) return yield* new WorkerError({ message: `${input.task.id} has no builder session` })
  const history = yield* TaskSessions.builderHistory(run.env, SessionID.make(model.session))
  if (history.marked && history.attempt >= model.attempts) return TaskSessions.continueMessage
  return TaskSessions.builderMessage({
    first: !history.marked,
    attempt: model.attempts,
    reopen: reopened(input.spec, TaskEngineXState.view(snapshot), model),
    task: input.task,
    spec: input.spec,
    trusted: (id) => TaskEngineXState.unitState(snapshot, id) === "trusted",
  })
})

/**
 * One builder turn in the task's worktree: the supervisor's `sessionEvents` actor watches it, and the supervisor
 * interrupts it on a stall or a wall clock. The session is claimed for `owner` with `watch: true` first.
 */
export const builderTurn = Effect.fn("TaskWorkers.builderTurn")(function* (
  run: Run,
  input: {
    readonly task: BlendModel.Task
    readonly spec: BlendModel.Spec
    readonly prompt: BuilderPrompt
    readonly owner: string
  },
) {
  const model = yield* taskModel(run, input.task.id)
  if (model.session === undefined || model.worktree === undefined)
    return yield* new WorkerError({ message: `${input.task.id} is building without a builder session` })
  const text = yield* builderText(run, input)
  return yield* turn(run, {
    directory: model.worktree,
    session: SessionID.make(model.session),
    agent: TaskHooks.BUILDER,
    text,
    owner: input.owner,
    watch: true,
  })
})

/** Commits whatever the builder left in its worktree and returns the head: the `head` of a `task.ready`. */
export const commit = Effect.fn("TaskWorkers.commit")(function* (run: Run, task: string, message: string) {
  const model = yield* taskModel(run, task)
  if (model.worktree === undefined) return yield* new WorkerError({ message: `${task} has no worktree` })
  return yield* TaskWorkspace.commitAll(model.worktree, run.limits, message)
})

/**
 * One verifier prompt in `directory`: a new session titled `title` when `session` is none (the `ask` of a round),
 * else the same session (the `askMissing`). The verdicts reach the owner as `hook.verdicts`.
 */
export const verifierPrompt = Effect.fn("TaskWorkers.verifierPrompt")(function* (
  run: Run,
  input: {
    readonly directory: string
    readonly session: Option.Option<SessionID>
    readonly title: string
    readonly text: string
    readonly owner: string
  },
) {
  const session = Option.isSome(input.session)
    ? input.session.value
    : (yield* TaskSessions.create(run.env, input.directory, {
        parentID: run.root,
        title: input.title,
        agent: TaskHooks.VERIFIER,
      })).id
  return yield* turn(run, {
    directory: input.directory,
    session,
    agent: TaskHooks.VERIFIER,
    text: input.text,
    owner: input.owner,
    watch: false,
  })
})

/**
 * One prompt of a scenario's judge round in the root checkout, for the scenario supervisor that owns it: the `ask`
 * (a new session, the scenario's judge message; attempt 2 is titled "again") when `session` is none, else the
 * `askMissing` in the same session. The verdict reaches the owner as `hook.verdicts`.
 */
export const scenarioJudge = Effect.fn("TaskWorkers.scenarioJudge")(function* (
  run: Run,
  input: {
    readonly scenario: BlendModel.Scenario
    readonly session: Option.Option<SessionID>
    readonly attempt: number
    readonly owner: string
  },
) {
  const judge = [{ id: input.scenario.id, text: input.scenario.title }]
  return yield* verifierPrompt(run, {
    directory: run.directory,
    session: input.session,
    title: `${input.scenario.id} verifier${input.attempt > 1 ? " (again)" : ""}`,
    text: Option.isSome(input.session)
      ? TaskSessions.judgeMissingMessage(judge)
      : TaskSessions.judgeMessage({
          role: "verifier",
          kind: "scenario",
          unit: input.scenario.id,
          judge,
          about: [`You judge scenario ${input.scenario.id}: ${input.scenario.title}.`, ...input.scenario.steps],
        }),
    owner: input.owner,
  })
})

/** Restores a judge's directory to its HEAD; the root checkout only under the checkout lock. */
export const restore = (run: Run, directory: string) => {
  const reset = TaskWorkspace.restore(directory, run.limits)
  return directory === run.directory ? run.locks.checkout.withPermit(reset) : reset
}

// --- proofs, merges, scenarios, stale checks ------------------------------------------------------------------------

// Proves obligations of a task on the base branch in the root checkout: the stale obligations of a task that was
// trusted, or the obligations of a parent before its review. Reviews need no run; they are judged.
const proveOnBase = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task, spec: BlendModel.Spec, state: State) {
  // Emptied first, so a task that waits for the lock (or needs only reviews) never shows the previous pass.
  const log = yield* proofLog(run.directory, task.id)
  const own = obligationsOf(spec, task.id)
  const stale = own.filter((obligation) => state.obligations[obligation.id]?.state === "stale")
  const targets = stale.length > 0 ? stale : own
  if (targets.every((obligation) => obligation.proof.kind === "review")) {
    const items = targets.map((obligation): Proved => ({ id: obligation.id, status: "needs-judge" }))
    return { results: items, reason: Option.none<string>() } satisfies Proof
  }
  return yield* run.locks.checkout.withPermit(
    Effect.gen(function* () {
      const head = yield* TaskWorkspace.baseHead(run.directory, run.limits, run.base)
      const proof = yield* TaskProof.proveTask({
        spec: {
          gates: spec.gates,
          obligations: [...spec.obligations.filter((item) => item.task !== task.id), ...targets],
        },
        task: { id: task.id, touches: [], gates: [] },
        cwd: run.directory,
        base: head,
        head,
        limits: run.limits,
        log,
      })
      return results(spec, proof, [])
    }),
  )
})

// The proofs of a leaf in its worktree between `base` and `head`. The tests and the structural rule run first; the
// gates run only when nothing failed, so a hung test reaches the builder without waiting for every gate.
const proveLeaf = Effect.fnUntraced(function* (
  run: Run,
  task: BlendModel.Task,
  spec: BlendModel.Spec,
  tree: { readonly worktree: string; readonly base: string; readonly head: string },
) {
  const input = {
    cwd: tree.worktree,
    base: tree.base,
    head: tree.head,
    limits: run.limits,
    log: yield* proofLog(run.directory, task.id),
  }
  const quick = yield* TaskProof.proveTask({
    ...input,
    spec: {
      gates: spec.gates,
      obligations: spec.obligations.filter((item) => item.task !== task.id || item.proof.kind !== "gate"),
    },
    task: { id: task.id, touches: task.touches, gates: [] },
  })
  const first = results(spec, quick, [])
  if (first.results.some((item) => item.status === "failed")) return first
  const full = yield* TaskProof.proveTask({
    ...input,
    spec: { gates: spec.gates, obligations: spec.obligations },
    task: { id: task.id, touches: task.touches, gates: task.gates },
  })
  return results(spec, full, task.gates)
})

/**
 * The proofs of a task in `proving`: a leaf's in its worktree, or stale obligations and a parent's obligations on
 * the base branch. The supervisor records `task.proved` with the result.
 */
export const proof = Effect.fn("TaskWorkers.proof")(function* (run: Run, task: BlendModel.Task, spec: BlendModel.Spec) {
  const state = TaskEngineXState.view(yield* snapshotOf(run))
  const model = yield* taskModel(run, task.id)
  const stale = obligationsOf(spec, task.id).some((obligation) => state.obligations[obligation.id]?.state === "stale")
  const { worktree, base, head } = model
  if (model.leaf && !stale && worktree !== undefined && base !== undefined && head !== undefined)
    return yield* proveLeaf(run, task, spec, { worktree, base, head })
  return yield* proveOnBase(run, task, spec, state)
})

/**
 * Merges the proved and verified `head` into the base branch, never the branch tip: a commit added to the branch
 * after `task.ready` (a verifier can run git) must not reach the base branch unproven. A head already there is not
 * merged again. Tried `MERGE_RETRY` more times before it fails.
 */
export const merge = (run: Run, head: string) =>
  run.locks.checkout
    .withPermit(
      Effect.gen(function* () {
        if (yield* TaskWorkspace.merged(run.directory, run.limits, run.base, head)) return
        yield* TaskWorkspace.merge(run.directory, run.limits, run.base, head)
      }),
    )
    .pipe(Effect.retry({ times: MERGE_RETRY, schedule: Schedule.exponential(Duration.millis(200)) }))

/** One `scenario.proved` payload. */
export type ScenarioResult = { readonly id: string } & ReturnType<typeof scenarioOutcome>

/** The scenarios whose needs became trusted together: one `bun test` run on the base branch for the batch. */
export const scenarioProof = Effect.fn("TaskWorkers.scenarioProof")(function* (run: Run, batch: ReadonlyArray<string>) {
  return yield* run.locks.checkout.withPermit(
    Effect.gen(function* () {
      const head = yield* TaskWorkspace.baseHead(run.directory, run.limits, run.base)
      const proofs = yield* TaskProof.proveScenarios({
        scenarios: batch.map((id) => ({ id })),
        cwd: run.directory,
        head,
        limits: run.limits,
        log: yield* proofLog(run.directory, "scenarios"),
      })
      return proofs.map((item): ScenarioResult => ({ id: item.scenario, ...scenarioOutcome(item) }))
    }),
  )
})

/** What a stale check found: the reloaded spec (none when it did not load), the stale obligations and the failures. */
export interface Stale {
  readonly spec: Option.Option<BlendModel.Spec>
  readonly stale: ReadonlyArray<{ readonly id: string; readonly hash: string }>
  readonly failures: ReadonlyArray<BlendModel.Failure>
}

/**
 * Loads the spec from the root checkout under the checkout lock. An obligation whose unit hash changed after it
 * passed or was trusted is stale. The run supervisor records `obligation.stale` and keeps the new spec.
 */
export const staleCheck = Effect.fn("TaskWorkers.staleCheck")(function* (run: Run) {
  const loaded = yield* run.locks.checkout.withPermit(Blend.load(run.specDir))
  if (!loaded.spec) return { spec: Option.none(), stale: [], failures: loaded.failures } satisfies Stale
  const state = TaskEngineXState.view(yield* snapshotOf(run))
  const stale = loaded.spec.obligations.flatMap((obligation) => {
    const current = state.obligations[obligation.id]
    if (!current || current.hash === obligation.hash) return []
    if (current.state !== "trusted" && current.state !== "passed") return []
    return [{ id: obligation.id, hash: obligation.hash }]
  })
  return { spec: Option.some(loaded.spec), stale, failures: loaded.failures } satisfies Stale
})

/** Records one fact through the run's Recorder (AD-9). */
export const record = (run: Run, fact: Unstamped) => run.recorder.record(fact)

/** Asks the status writer to rewrite the last snapshot with a fresh heartbeat; fire and forget. */
export const touch = (run: Run) => run.recorder.touch

// --- the session events of a turn -----------------------------------------------------------------------------------

/** What `sessionEvents` sends its parent about one session. */
export type TurnEvent =
  | { readonly type: "turn.activity" }
  | { readonly type: "turn.tool"; readonly running: boolean }
  | { readonly type: "turn.status"; readonly status: SessionStatus.Info["type"]; readonly message?: string }

// A tool part that runs, or that has stopped running; any other part says nothing about tools.
const toolEvents = (part: typeof SessionV1.Part.Type): ReadonlyArray<TurnEvent> => {
  if (part.type !== "tool") return []
  if (part.state.status === "running") return [{ type: "turn.tool", running: true }]
  if (part.state.status === "completed" || part.state.status === "error") return [{ type: "turn.tool", running: false }]
  return []
}

const statusEvent = (status: SessionStatus.Info): TurnEvent =>
  status.type === "retry"
    ? { type: "turn.status", status: "retry", message: status.message }
    : { type: "turn.status", status: status.type }

// Narrows an event of the bus to one definition by its type tag, as the bus's typed streams do.
const of =
  <D extends EventV2.Definition>(definition: D) =>
  (event: EventV2.Payload): event is EventV2.Payload<D> =>
    event.type === definition.type

/**
 * The events of one session as typed events for its supervisor (AD-11): every part update or delta is
 * `turn.activity`, a tool part that starts or stops running is `turn.tool { running }`, and each
 * `SessionStatus.Event.Status` (not the deprecated `Event.Idle`) is `turn.status`. One subscription to the bus keeps
 * the publish order across the three kinds. A `fromCallback` actor, because `fromStream` would deliver snapshots, not
 * events. Its cleanup interrupts the relay.
 */
export const sessionEvents = fromCallback<
  EventObject,
  { readonly events: EventV2.Interface; readonly session: string }
>(({ input, sendBack }) => {
  const activity: ReadonlyArray<TurnEvent> = [{ type: "turn.activity" }]
  const turnEvents = (event: EventV2.Payload): ReadonlyArray<TurnEvent> => {
    if (of(MessageV2.Event.PartDelta)(event)) return event.data.sessionID === input.session ? activity : []
    if (of(MessageV2.Event.PartUpdated)(event))
      return event.data.sessionID === input.session ? [...activity, ...toolEvents(event.data.part)] : []
    if (of(SessionStatus.Event.Status)(event))
      return event.data.sessionID === input.session ? [statusEvent(event.data.status)] : []
    return []
  }
  const relay = input.events
    .all()
    .pipe(Stream.runForEach((event) => Effect.sync(() => turnEvents(event).forEach((item) => sendBack(item)))))
  const fiber = Effect.runFork(relay)
  return () => {
    Effect.runFork(Fiber.interrupt(fiber))
  }
})

export * as TaskWorkers from "./workers"

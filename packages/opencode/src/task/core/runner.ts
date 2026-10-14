import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FileSystem,
  MutableHashMap,
  Option,
  Path,
  Ref,
  Result,
  Schedule,
  Semaphore,
} from "effect"
import type { BackgroundJob } from "@/background/job"
import { SessionID } from "@/session/schema"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import type { TaskLimits } from "@/task/limits"
import { TaskProof } from "@/task/proof"
import { TaskHooks } from "./hooks"
import { type Engine, type RunSnapshot, TaskEngineXState } from "@/task/engine-xstate"
import type { Fact, Plan, Result as Proved, State, TaskModel, Verdict } from "./model"
import { TaskEvents } from "./events"
import { TaskSessions } from "./sessions"
import { TaskStatus } from "./status"
import { TaskWorkspace } from "./workspace"

// The task harness runner. One run per (directory, spec folder): it records every fact as a durable event,
// folds it through the engine, projects the state to the status file, and drives the builders, the proofs,
// the verifiers, the merges, the parent review and the scenarios. It never changes state except by recording a
// fact; a resume is the same fold over the stored facts.

type Env = TaskSessions.Env
type Model = TaskSessions.Model
type Requirements = FileSystem.FileSystem | Path.Path

/** Everything a run needs, resolved by the `/task` command. */
export interface Start {
  readonly env: Env
  readonly engine: Engine
  /** The instance directory: the root checkout. */
  readonly directory: string
  /** The branch the root checkout had checked out at `/task`: the leaves branch from it and merge into it. */
  readonly base: string
  /** The spec folder, absolute. */
  readonly specDir: string
  readonly plan: Plan
  /** The root session of the latest `/task`: the parent of every child session. */
  readonly root: SessionID
  readonly model: Model
  readonly limits: TaskLimits.Limits
  /** The background job that runs this run. */
  readonly job: string
}

interface Run extends Start {
  readonly id: string
  /** The time of the latest `run.started` or `run.resumed`: the run wall clock starts here. */
  readonly startedAt: number
  /** The run machine's snapshot; the phase-1 runner reads it through `view` (AD-20). */
  readonly state: Ref.Ref<RunSnapshot>
  readonly outside: Ref.Ref<ReadonlyArray<string>>
  /** The spec as last loaded from the root checkout: the current texts and hashes. */
  readonly spec: Ref.Ref<BlendModel.Spec>
  /** Serialises record → fold → status write. */
  readonly lock: Semaphore.Semaphore
  /** Serialises everything that reads or moves the base branch in the root checkout. */
  readonly checkout: Semaphore.Semaphore
  /** Serialises worktree creation. */
  readonly git: Semaphore.Semaphore
  /** The child sessions with a turn in flight, and the directory of each one's instance. */
  readonly children: MutableHashMap.MutableHashMap<SessionID, string>
  readonly failures: MutableHashMap.MutableHashMap<string, number>
  readonly stopping: Ref.Ref<boolean>
}

type Workers = FiberMap.FiberMap<string>

// --- the registry of runs in this process --------------------------------------------------------------------------------

interface Active {
  readonly directory: string
  readonly trust: (id: string) => Effect.Effect<void>
}

// Process-wide: a run lives in this process only, so the registry is in memory. A restart empties it; the next
// `/task` resumes the stored run.
const active = MutableHashMap.empty<string, Active>()

/** True when the run is going on in this process. */
export const running = (runID: string) => MutableHashMap.has(active, runID)

/** Records the `outside` id in every run of the directory that is going on in this process. */
export const trustActive = (directory: string, id: string) =>
  Effect.forEach(
    [...MutableHashMap.values(active)].filter((run) => run.directory === directory),
    (run) => run.trust(id),
    { discard: true },
  )

// --- record, fold, project -------------------------------------------------------------------------------------------------

const now = Clock.currentTimeMillis

/** The run's state as `State`: the snapshot read through the engine's `view`. */
const stateOf = (run: Run) => Effect.map(Ref.get(run.state), TaskEngineXState.view)

const view = Effect.fnUntraced(function* (run: Run) {
  return { plan: run.plan, state: yield* stateOf(run), outside: yield* Ref.get(run.outside) }
})

const writeStatus = Effect.fnUntraced(function* (run: Run) {
  const input = yield* view(run)
  yield* TaskStatus.write(run.directory, TaskStatus.project(input))
})

/**
 * The only way the state changes: the fact is stored, folded, and the status file rewritten. Uninterruptible, so
 * the folded state never lags a stored fact.
 */
const record = (run: Run, fact: Fact) =>
  run.lock.withPermit(
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* TaskEvents.publish(run.env.events, run.id, fact)
        yield* Ref.update(run.state, (state) => run.engine.apply(run.plan, state, fact))
        if (fact.type === "outside.trusted") {
          yield* Ref.update(run.outside, (ids) => (ids.includes(fact.id) ? ids : [...ids, fact.id]))
        }
        yield* writeStatus(run)
      }),
    ),
  )

const taskOf = Effect.fnUntraced(function* (run: Run, id: string) {
  return Option.fromNullishOr((yield* stateOf(run)).tasks[id])
})

const obligationsOf = (spec: BlendModel.Spec, task: string) =>
  spec.obligations.filter((obligation) => obligation.task === task)

// --- child sessions ---------------------------------------------------------------------------------------------------------

// A turn is registered while it runs, so a cancel can reach it in its own instance. An interrupted turn stays
// registered: interrupting the caller does not stop the session's own loop, only a cancel does.
const inflight = <A, E, R>(run: Run, session: SessionID, directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      if (yield* Ref.get(run.stopping)) return yield* Effect.interrupt
      return MutableHashMap.set(run.children, session, directory)
    }),
    () => effect,
    (_, exit) =>
      Exit.hasInterrupts(exit) ? Effect.void : Effect.sync(() => MutableHashMap.remove(run.children, session)),
  )

// Cancels the turns in their instances, each bounded by the cancel deadline. The finaliser that calls this is
// uninterruptible, so each bound is made interruptible explicitly.
const cancelChildren = (run: Run, children: ReadonlyArray<readonly [SessionID, string]>) =>
  Effect.forEach(
    children,
    ([session, directory]) =>
      TaskSessions.cancel(run.env, directory, session).pipe(
        Effect.interruptible,
        Effect.timeoutOption(run.limits.cancelDeadline),
        Effect.catchCause(() => Effect.void),
        Effect.andThen(Effect.sync(() => MutableHashMap.remove(run.children, session))),
      ),
    { concurrency: "unbounded", discard: true },
  )

// Restores a judge's directory to its HEAD; the root checkout only under the `checkout` semaphore, as it holds
// the base branch.
const restore = (run: Run, directory: string) => {
  const reset = TaskWorkspace.restore(directory, run.limits)
  return directory === run.directory ? run.checkout.withPermit(reset) : reset
}

/**
 * One verdict per id: the last one the judge recorded. A judge that records an id twice (rejected, then trusted)
 * must not let the merge decision and the engine read different verdicts.
 */
export const latestVerdicts = (verdicts: ReadonlyArray<Verdict>) =>
  verdicts.filter((verdict, index) => verdicts.findLastIndex((other) => other.id === verdict.id) === index)

// A `task_ready` or verdicts left from a turn that ended otherwise (repetition, spend cap, stall, cancel) must not
// count for the next turn: each turn starts with none.
const clearHooks = (session: SessionID) => {
  TaskHooks.takeReady(session)
  TaskHooks.takeVerdicts(session)
}

/**
 * One judging round: a new session per try, its marker and `judge` lines, and the verdicts it recorded for the
 * judged ids. A round with no verdict is tried once more; none after that is `Option.none()`.
 */
const round = Effect.fnUntraced(function* (
  run: Run,
  input: {
    readonly directory: string
    readonly role: "verifier" | "reviewer"
    readonly kind: "task" | "scenario"
    readonly unit: string
    readonly judge: ReadonlyArray<{ readonly id: string; readonly text: string }>
    readonly about: ReadonlyArray<string>
  },
) {
  const ids = input.judge.map((item) => item.id)
  for (const attempt of [1, 2]) {
    const session = yield* TaskSessions.create(run.env, input.directory, {
      parentID: run.root,
      title: `${input.unit} ${input.role}${attempt > 1 ? ` (again)` : ""}`,
      agent: TaskHooks.VERIFIER,
    })
    const ask = (text: string, wanted: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        clearHooks(session.id)
        yield* inflight(
          run,
          session.id,
          input.directory,
          TaskSessions.prompt(run.env, input.directory, {
            session: session.id,
            agent: TaskHooks.VERIFIER,
            model: run.model,
            text,
          }),
        )
        return (TaskHooks.takeVerdicts(session.id) ?? []).filter((verdict) => wanted.includes(verdict.id))
      })
    const verdicts = latestVerdicts(yield* ask(TaskSessions.judgeMessage(input), ids))
    // A judge that skipped some ids is asked once more, in the same session, for exactly those.
    const missing =
      verdicts.length === 0 ? [] : input.judge.filter((item) => !verdicts.some((verdict) => verdict.id === item.id))
    const more =
      missing.length === 0
        ? []
        : yield* ask(
            TaskSessions.judgeMissingMessage(missing),
            missing.map((item) => item.id),
          )
    // Whatever the judge left in its directory goes, so it reaches neither a proof nor a builder commit.
    yield* restore(run, input.directory)
    if (verdicts.length > 0) return Option.some(latestVerdicts([...verdicts, ...more]))
  }
  return Option.none<ReadonlyArray<Verdict>>()
})

// --- proofs -------------------------------------------------------------------------------------------------------------------

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

const failed = (items: ReadonlyArray<Proved>) => items.some((item) => item.status === "failed")

const proved = (run: Run, task: string, outcome: ReturnType<typeof results>) =>
  Effect.flatMap(now, (at) =>
    record(run, {
      type: "task.proved",
      at,
      task,
      results: outcome.results,
      ...Option.match(outcome.reason, { onNone: () => ({}), onSome: (reason) => ({ reason }) }),
    }),
  )

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

/**
 * The proofs of a leaf in its worktree between `base` and `head`. The tests and the structural rule run first;
 * the gates run only when nothing failed, so a hung test reaches the builder without waiting for every gate.
 */
const proveLeaf = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task, model: TaskModel) {
  const { worktree, base, head } = model
  if (!worktree || !base || !head) return yield* proveOnMain(run, task)
  const spec = yield* Ref.get(run.spec)
  const input = { cwd: worktree, base, head, limits: run.limits, log: yield* proofLog(run.directory, task.id) }
  const quick = yield* TaskProof.proveTask({
    ...input,
    spec: {
      gates: spec.gates,
      obligations: spec.obligations.filter((item) => item.task !== task.id || item.proof.kind !== "gate"),
    },
    task: { id: task.id, touches: task.touches, gates: [] },
  })
  const first = results(spec, quick, [])
  if (failed(first.results)) return yield* proved(run, task.id, first)
  const full = yield* TaskProof.proveTask({
    ...input,
    spec: { gates: spec.gates, obligations: spec.obligations },
    task: { id: task.id, touches: task.touches, gates: task.gates },
  })
  return yield* proved(run, task.id, results(spec, full, task.gates))
})

/**
 * Proves obligations of a task on the base branch in the root checkout: the stale obligations of a task that was trusted,
 * or the obligations of a parent before its review. Reviews need no run; they are judged.
 */
const proveOnMain = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  // Emptied first, so a task that waits for the permit (or needs only reviews) never shows the previous pass.
  const log = yield* proofLog(run.directory, task.id)
  const spec = yield* Ref.get(run.spec)
  const state = yield* stateOf(run)
  const own = obligationsOf(spec, task.id)
  const stale = own.filter((obligation) => state.obligations[obligation.id]?.state === "stale")
  const targets = stale.length > 0 ? stale : own
  if (targets.every((obligation) => obligation.proof.kind === "review")) {
    const items = targets.map((obligation): Proved => ({ id: obligation.id, status: "needs-judge" }))
    return yield* proved(run, task.id, { results: items, reason: Option.none() })
  }
  return yield* run.checkout.withPermit(
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
      yield* proved(run, task.id, results(spec, proof, []))
    }),
  )
})

// --- the leaf lifecycle -------------------------------------------------------------------------------------------------------

// The obligations a later attempt reopens, with the reason of each: failed proofs, rejected verdicts, or, when the
// attempt ended otherwise (a repetition), every obligation not yet trusted with the task's reason.
const reopened = (spec: BlendModel.Spec, state: State, task: TaskModel): ReadonlyArray<TaskSessions.Reopen> => {
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

const NO_READY = "the builder ended without task_ready"

/**
 * A builder turn ended without `task_ready` twice after a nudge: its work is committed and proved failed, so the
 * next attempt starts with every test obligation reopened.
 */
const unready = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task, worktree: string) {
  const head = yield* TaskWorkspace.commitAll(worktree, run.limits, `${task.id}: work without task_ready`)
  yield* record(run, { type: "task.ready", at: yield* now, task: task.id, head })
  const spec = yield* Ref.get(run.spec)
  const own = obligationsOf(spec, task.id)
  const tests = own.filter((obligation) => obligation.proof.kind === "test")
  const items = (tests.length > 0 ? tests : own).map(
    (obligation): Proved => ({ id: obligation.id, status: "failed", reason: NO_READY }),
  )
  yield* proved(run, task.id, { results: items, reason: Option.some(NO_READY) })
})

/** The builder side of a leaf in `building`: attempt turns under the watchdog until it is ready or stops. */
const build = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const found = yield* taskOf(run, task.id)
  if (Option.isNone(found) || found.value.state !== "building") return yield* Effect.void
  const model = found.value
  if (!model.session || !model.worktree) {
    return yield* record(run, {
      type: "task.failed",
      at: yield* now,
      task: task.id,
      reason: "building without a builder session",
    })
  }
  const session = SessionID.make(model.session)
  const worktree = model.worktree
  TaskHooks.watch(session, run.limits.repetitionLimit)
  const history = yield* TaskSessions.builderHistory(run.env, session)
  const fresh = !history.marked || history.attempt < model.attempts
  const spec = yield* Ref.get(run.spec)
  const state = yield* stateOf(run)
  let text = fresh
    ? TaskSessions.builderMessage({
        first: !history.marked,
        attempt: model.attempts,
        reopen: reopened(spec, state, model),
        task,
        spec,
        trusted: TaskStatus.trusted(yield* view(run)),
      })
    : TaskSessions.continueMessage
  let nudges = 0
  while (true) {
    clearHooks(session)
    const turn = yield* inflight(
      run,
      session,
      worktree,
      TaskSessions.builderTurn(run.env, {
        directory: worktree,
        session,
        agent: TaskHooks.BUILDER,
        model: run.model,
        text,
        limits: run.limits,
      }),
    )
    if (turn.outcome.kind === "spend-cap") {
      return yield* record(run, {
        type: "task.needs_human",
        at: yield* now,
        task: task.id,
        reason: turn.outcome.reason,
      })
    }
    const repeated = Option.fromNullishOr(TaskHooks.takeRepeated(session))
    if (Option.isSome(repeated)) {
      return yield* record(run, { type: "task.repeated", at: yield* now, task: task.id, reason: repeated.value })
    }
    if (TaskHooks.takeReady(session)) {
      const head = yield* TaskWorkspace.commitAll(worktree, run.limits, `${task.id}: attempt ${model.attempts}`)
      yield* record(run, { type: "task.ready", at: yield* now, task: task.id, head })
      return yield* prove(run, task)
    }
    if (turn.outcome.kind === "stall") {
      yield* record(run, { type: "task.stalled", at: yield* now, task: task.id, reason: turn.outcome.reason })
      text = TaskSessions.continueMessage
      continue
    }
    const cap = yield* TaskSessions.spendCapError(run.env, session, turn.started)
    if (Option.isSome(cap)) {
      return yield* record(run, {
        type: "task.needs_human",
        at: yield* now,
        task: task.id,
        reason: `spend cap: ${TaskSessions.oneLine(cap.value)}`,
      })
    }
    if (nudges < 2) {
      nudges++
      text = TaskSessions.nudgeMessage
      continue
    }
    return yield* unready(run, task, worktree)
  }
})

/** A task in `proving`: a leaf's proofs in its worktree, or stale obligations and parent obligations on the base branch. */
const prove = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const found = yield* taskOf(run, task.id)
  if (Option.isNone(found) || found.value.state !== "proving") return yield* Effect.void
  const state = yield* stateOf(run)
  const stale = obligationsOf(yield* Ref.get(run.spec), task.id).some(
    (obligation) => state.obligations[obligation.id]?.state === "stale",
  )
  if (found.value.leaf && !stale) return yield* proveLeaf(run, task, found.value)
  return yield* proveOnMain(run, task)
})

// Merges the proved and verified `head`, never the branch tip: a commit added to the branch after `task.ready`
// (a verifier can run git) must not reach the base branch unproven.
const mergeLeaf = Effect.fnUntraced(function* (run: Run, model: TaskModel) {
  if (!model.head) return
  const head = model.head
  yield* run.checkout
    .withPermit(
      Effect.gen(function* () {
        if (yield* TaskWorkspace.merged(run.directory, run.limits, run.base, head)) return
        yield* TaskWorkspace.merge(run.directory, run.limits, run.base, head)
      }),
    )
    .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced(Duration.millis(500)) }))
})

/**
 * A task in `verifying`: a verifier round for a leaf (in its worktree) or a review round for a parent (in the root
 * checkout), judging only the obligations in `passed`. A leaf whose obligations all end trusted merges into the base branch
 * first, unless its head already is there (a stale round, or a resume after the merge).
 */
const verify = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const found = yield* taskOf(run, task.id)
  if (Option.isNone(found) || found.value.state !== "verifying") return yield* Effect.void
  const model = found.value
  const spec = yield* Ref.get(run.spec)
  const state = yield* stateOf(run)
  const own = obligationsOf(spec, task.id)
  const judge = own.filter((obligation) => state.obligations[obligation.id]?.state === "passed")
  const leaf = model.leaf
  const verdicts =
    judge.length === 0
      ? Option.some<ReadonlyArray<Verdict>>([])
      : yield* round(run, {
          directory: leaf && model.worktree ? model.worktree : run.directory,
          role: leaf ? "verifier" : "reviewer",
          kind: "task",
          unit: task.id,
          judge: judge.map((obligation) => ({ id: obligation.id, text: obligation.text })),
          about: leaf
            ? [`You verify task ${task.id}: ${task.title}.`, `Goal: ${TaskSessions.oneLine(task.goal)}`]
            : [
                `You review task ${task.id}: ${task.title}. Its children are trusted and merged on the ${run.base} branch.`,
                `Review their combined diff on the ${run.base} branch (git log, git diff) against the obligations above.`,
              ],
        })
  if (Option.isNone(verdicts)) {
    return yield* record(run, { type: "task.failed", at: yield* now, task: task.id, reason: "no verdict" })
  }
  const trusted = own.every(
    (obligation) =>
      state.obligations[obligation.id]?.state === "trusted" ||
      verdicts.value.some((verdict) => verdict.id === obligation.id && verdict.verdict === "trusted"),
  )
  if (leaf && trusted) {
    const merge = yield* Effect.result(mergeLeaf(run, model))
    if (Result.isFailure(merge)) {
      return yield* record(run, {
        type: "task.failed",
        at: yield* now,
        task: task.id,
        reason: `merge: ${merge.failure.message}`,
      })
    }
  }
  return yield* record(run, { type: "task.verified", at: yield* now, task: task.id, verdicts: verdicts.value })
})

/** A leaf whose dependencies are trusted: its worktree, its builder session, `task.started`, then the first build. */
const begin = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const tree = yield* run.git.withPermit(
    TaskWorkspace.ensureWorktree(run.directory, run.id, task.id, run.base, run.limits),
  )
  const session = yield* TaskSessions.create(run.env, tree.worktree, {
    parentID: run.root,
    title: `${task.id} builder`,
    agent: TaskHooks.BUILDER,
  })
  TaskHooks.watch(session.id, run.limits.repetitionLimit)
  yield* record(run, {
    type: "task.started",
    at: yield* now,
    task: task.id,
    worktree: tree.worktree,
    branch: tree.branch,
    base: tree.base,
    session: session.id,
  })
  yield* build(run, task)
})

// --- scenarios -------------------------------------------------------------------------------------------------------------

/** A scenario's tag result as a fact: passed stays passed; failed, and skipped (no test ran), are failed. */
export const scenarioOutcome = (
  proof: TaskProof.ScenarioProof,
): { readonly status: "passed" } | { readonly status: "failed"; readonly reason: string } => {
  const result = proof.result
  if (result.status === "passed") return { status: "passed" }
  if (result.status === "failed") return { status: "failed", reason: result.reason }
  return { status: "failed", reason: `skipped: every test titled [${proof.scenario}] was skipped` }
}

/** The scenarios whose needs became trusted together: one `bun test` run on the base branch for the batch. */
const proveScenarios = Effect.fnUntraced(function* (run: Run, batch: ReadonlyArray<BlendModel.Scenario>) {
  yield* run.checkout.withPermit(
    Effect.gen(function* () {
      const head = yield* TaskWorkspace.baseHead(run.directory, run.limits, run.base)
      const proofs = yield* TaskProof.proveScenarios({
        scenarios: batch.map((scenario) => ({ id: scenario.id })),
        cwd: run.directory,
        head,
        limits: run.limits,
        log: yield* proofLog(run.directory, "scenarios"),
      })
      for (const proof of proofs) {
        yield* record(run, { type: "scenario.proved", at: yield* now, id: proof.scenario, ...scenarioOutcome(proof) })
      }
    }),
  )
})

const judgeScenario = Effect.fnUntraced(function* (run: Run, scenario: BlendModel.Scenario) {
  const verdicts = yield* round(run, {
    directory: run.directory,
    role: "verifier",
    kind: "scenario",
    unit: scenario.id,
    judge: [{ id: scenario.id, text: scenario.title }],
    about: [`You judge scenario ${scenario.id}: ${scenario.title}.`, ...scenario.steps],
  })
  const verdict = Option.getOrElse(
    Option.flatMap(verdicts, (items) => Option.fromNullishOr(items[0])),
    (): Verdict => ({ id: scenario.id, verdict: "rejected", reason: "no verdict" }),
  )
  yield* record(run, { type: "scenario.verified", at: yield* now, verdict })
})

// --- stale obligations, wall clocks, the end ----------------------------------------------------------------------------

/** Loads the spec from the root checkout; an obligation whose unit hash changed after it passed or was trusted is stale. */
const checkStale = Effect.fnUntraced(function* (run: Run) {
  const loaded = yield* Blend.load(run.specDir)
  if (!loaded.spec) return
  yield* Ref.set(run.spec, loaded.spec)
  const state = yield* stateOf(run)
  for (const obligation of loaded.spec.obligations) {
    const current = state.obligations[obligation.id]
    if (!current || current.hash === obligation.hash) continue
    if (current.state !== "trusted" && current.state !== "passed") continue
    yield* record(run, { type: "obligation.stale", at: yield* now, id: obligation.id, hash: obligation.hash })
  }
})

const ACTIVE = ["building", "proving", "verifying"]

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

const checkWallClocks = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  const at = yield* now
  if (Option.isSome(run.limits.runWallClock) && at - run.startedAt > Duration.toMillis(run.limits.runWallClock.value)) {
    const minutes = Math.round(Duration.toMinutes(run.limits.runWallClock.value))
    yield* record(run, {
      type: "run.ended",
      at,
      state: "failed",
      reason: `wall clock: the run took over ${minutes} min`,
    })
    return
  }
  if (Option.isNone(run.limits.taskWallClock)) return
  const limit = Duration.toMillis(run.limits.taskWallClock.value)
  const state = yield* stateOf(run)
  for (const task of Object.values(state.tasks)) {
    if (!ACTIVE.includes(task.state)) continue
    const started = taskClockStart(state.history, task.id, run.startedAt)
    if (Option.isNone(started) || at - started.value <= limit) continue
    yield* FiberMap.remove(workers, task.id)
    if (task.session && task.worktree) {
      yield* TaskSessions.cancel(run.env, task.worktree, SessionID.make(task.session)).pipe(Effect.ignore)
    }
    const minutes = Math.round(limit / 60_000)
    yield* record(run, {
      type: "task.failed",
      at,
      task: task.id,
      reason: `wall clock: the task took over ${minutes} min`,
    })
  }
})

const JUDGED = ["trusted", "rejected", "failed"]

/**
 * Ends the run once every plan task is trusted and every scenario is judged or waits only on `outside`: `done` when
 * every judged scenario is trusted, `failed` (naming them) when any acceptance proof failed or was rejected — the run
 * is trusted only when every proof passed.
 */
const checkDone = Effect.fnUntraced(function* (run: Run) {
  const input = yield* view(run)
  const { state } = input
  const tasks = run.plan.tasks.every((task) => state.tasks[task.id]?.state === "trusted")
  const scenarios = run.plan.scenarios.every((scenario) => {
    const current = state.scenarios[scenario.id]?.state
    if (current && JUDGED.includes(current)) return true
    const open = TaskStatus.waitingOn(input, scenario.needs)
    return current === "waiting" && open.length > 0 && open.every((id) => id in run.plan.spec.outside)
  })
  if (!tasks || !scenarios) return
  const unproved = run.plan.scenarios.filter((scenario) => {
    const current = state.scenarios[scenario.id]?.state
    return current === "failed" || current === "rejected"
  })
  if (unproved.length === 0) {
    yield* record(run, { type: "run.ended", at: yield* now, state: "done" })
    return
  }
  const reason = `acceptance not proved: ${unproved.map((scenario) => `${scenario.id} ${state.scenarios[scenario.id]?.state}`).join(", ")}`
  yield* record(run, { type: "run.ended", at: yield* now, state: "failed", reason })
})

// --- scheduling ------------------------------------------------------------------------------------------------------------

const MAX_FAILURES = 3

// A worker that fails is retried on a later tick; the third failure in a row ends its unit with the error. The
// scenario batch ends only the scenarios it held (`batch`), never one whose needs are not trusted.
const guarded = (
  run: Run,
  key: string,
  effect: Effect.Effect<void, unknown, Requirements>,
  batch: ReadonlyArray<string> = [],
) =>
  effect.pipe(
    Effect.tap(() => Effect.sync(() => MutableHashMap.remove(run.failures, key))),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
        const count = Option.getOrElse(MutableHashMap.get(run.failures, key), () => 0) + 1
        MutableHashMap.set(run.failures, key, count)
        const message = TaskSessions.oneLine(Cause.pretty(cause)).slice(0, 600)
        yield* Effect.logWarning("task harness: a worker failed", { key, count, message })
        if (count < MAX_FAILURES) return yield* Effect.sleep(Duration.seconds(1))
        const reason = `harness error: ${message}`
        const state = yield* stateOf(run)
        if (state.tasks[key]) return yield* record(run, { type: "task.failed", at: yield* now, task: key, reason })
        if (state.scenarios[key]) {
          return yield* record(run, {
            type: "scenario.verified",
            at: yield* now,
            verdict: { id: key, verdict: "rejected", reason },
          })
        }
        const waiting = batch.filter((id) => state.scenarios[id]?.state === "waiting")
        return yield* Effect.forEach(
          waiting,
          (id) =>
            Effect.flatMap(now, (at) => record(run, { type: "scenario.proved", at, id, status: "failed", reason })),
          { discard: true },
        )
      }),
    ),
  )

const schedule = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  const input = yield* view(run)
  const { state } = input
  const ok = TaskStatus.trusted(input)
  const spawn = (key: string, effect: Effect.Effect<void, unknown, Requirements>, batch: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      if (yield* FiberMap.has(workers, key)) return
      yield* FiberMap.run(workers, key, { onlyIfMissing: true })(guarded(run, key, effect, batch))
    })
  for (const task of run.plan.tasks) {
    const model = state.tasks[task.id]
    if (!model) continue
    if (model.state === "waiting" && task.afterEffective.every(ok)) {
      if (model.leaf) yield* spawn(task.id, begin(run, task))
      else if (task.children.every(ok)) yield* spawn(task.id, proveOnMain(run, task))
    }
    if (model.state === "building" && model.leaf) yield* spawn(task.id, build(run, task))
    if (model.state === "proving") yield* spawn(task.id, prove(run, task))
    if (model.state === "verifying") yield* spawn(task.id, verify(run, task))
  }
  const ready = run.plan.scenarios.filter(
    (scenario) => state.scenarios[scenario.id]?.state === "waiting" && scenario.needs.every(ok),
  )
  if (ready.length > 0) {
    yield* spawn(
      "scenarios",
      proveScenarios(run, ready),
      ready.map((scenario) => scenario.id),
    )
  }
  for (const scenario of run.plan.scenarios) {
    if (state.scenarios[scenario.id]?.state === "verifying") yield* spawn(scenario.id, judgeScenario(run, scenario))
  }
})

const TICK = Duration.millis(250)
const STALE_EVERY = 4

const loop = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  let tick = 0
  while (!TaskEngineXState.ended(yield* Ref.get(run.state))) {
    yield* checkWallClocks(run, workers)
    if (tick % STALE_EVERY === 0) yield* checkStale(run)
    yield* schedule(run, workers)
    yield* checkDone(run)
    tick++
    yield* Effect.sleep(TICK)
  }
})

// Stops every worker and every child turn in flight, at the same time: new turns are refused from the first step
// on, the turns in flight are cancelled in their instances, and a turn that started meanwhile is cancelled last.
const stopWork = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  yield* Ref.set(run.stopping, true)
  const children = [...run.children]
  const clearing = yield* FiberMap.clear(workers).pipe(Effect.forkChild)
  yield* cancelChildren(run, children)
  yield* Fiber.await(clearing).pipe(Effect.interruptible, Effect.timeoutOption(run.limits.cancelDeadline))
  yield* cancelChildren(run, [...run.children])
})

// Interrupted: a cancel of the root session (the job is `cancelled`) ends the run `cancelled`; anything else (the
// server stopping) leaves it resumable.
const interrupted = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  yield* stopWork(run, workers)
  const job = yield* run.env.background.get(run.job).pipe(
    Effect.map(Option.fromNullishOr),
    Effect.catchCause(() => Effect.succeed(Option.none<BackgroundJob.Info>())),
  )
  if (Option.isNone(job) || job.value.status !== "cancelled") return
  yield* record(run, { type: "run.cancelled", at: yield* now, reason: "cancelled" })
})

/**
 * The base branch the stored run started on, when it has not ended and recorded one: a resume must use the same
 * branch, because the leaves merged so far are there.
 */
export const unfinishedBase = (engine: Engine, plan: Plan, stored: ReadonlyArray<Fact>): Option.Option<string> =>
  Option.flatMap(
    Option.filter(
      TaskEvents.latestRun(stored),
      (facts) => !TaskEngineXState.ended(TaskEvents.fold(engine, plan, facts)),
    ),
    (facts) =>
      Option.fromNullishOr(facts.flatMap((fact) => (fact.type === "run.started" && fact.base ? [fact.base] : []))[0]),
  )

/**
 * Runs the run of `start.plan` to its end: resumes the stored run when it has not ended, else starts a new one.
 * Its result is the end state.
 */
export const run = Effect.fn("TaskRunner.run")(function* (start: Start) {
  const id = TaskEvents.runID(start.directory, start.plan.specPath)
  const stored = yield* TaskEvents.read(start.env.db, id)
  const resumed = Option.filter(
    TaskEvents.latestRun(stored),
    (facts) => !TaskEngineXState.ended(TaskEvents.fold(start.engine, start.plan, facts)),
  )
  const facts = Option.getOrElse(resumed, (): ReadonlyArray<Fact> => [])
  const at = yield* now
  const self: Run = {
    ...start,
    id,
    // The `run.started` or `run.resumed` this call records: the run clock does not count downtime.
    startedAt: at,
    state: yield* Ref.make(TaskEvents.fold(start.engine, start.plan, facts)),
    outside: yield* Ref.make(TaskEvents.trustedOutside(facts)),
    spec: yield* Ref.make(start.plan.spec),
    lock: yield* Semaphore.make(1),
    checkout: yield* Semaphore.make(1),
    git: yield* Semaphore.make(1),
    children: MutableHashMap.empty(),
    failures: MutableHashMap.empty(),
    stopping: yield* Ref.make(false),
  }
  const trust = (outside: string) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(self.outside)).includes(outside)) return
      yield* record(self, { type: "outside.trusted", at: yield* now, id: outside })
    })
  const body = Effect.gen(function* () {
    yield* record(self, { type: Option.isSome(resumed) ? "run.resumed" : "run.started", at, base: start.base })
    const recorded = TaskEvents.trustedOutside(
      yield* TaskEvents.read(start.env.db, TaskEvents.directoryID(start.directory)),
    )
    yield* Effect.forEach(recorded, trust, { discard: true })
    const workers = yield* FiberMap.make<string>()
    yield* loop(self, workers).pipe(Effect.onInterrupt(() => interrupted(self, workers)))
    yield* stopWork(self, workers)
    return TaskEngineXState.view(yield* Ref.get(self.state)).run.state
  })
  MutableHashMap.set(active, id, { directory: start.directory, trust })
  return yield* Effect.scoped(body).pipe(Effect.ensuring(Effect.sync(() => MutableHashMap.remove(active, id))))
})

export * as TaskRunner from "./runner"

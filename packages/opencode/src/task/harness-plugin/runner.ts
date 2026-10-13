import {
  Cause,
  Clock,
  Deferred,
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
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import type { Fact, Plan, Result as Proved, State, TaskModel, Verdict } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskEngineTable } from "@/task/engine-table"
import type { TaskLimits } from "@/task/limits"
import { TaskProof } from "@/task/proof"
import { type Client, HarnessDriver } from "./driver"
import { HarnessLog } from "./log"
import { HarnessMessages } from "./messages"
import { HarnessRegistry } from "./registry"

// The O3 runner: one run per (directory, spec folder), in the server process, outside opencode's core. Every fact
// is appended to the JSONL log, folded through O1's transition table and projected to the status file; nothing
// changes state any other way, so a resume is the same fold over the log. It drives the builders, proofs,
// verifiers, merges, parent review and scenarios through the SDK client the plugin received.

type Requirements = FileSystem.FileSystem | Path.Path

/** Everything a run needs, resolved by `/task`. */
export interface Start {
  readonly client: Client
  /** The session directory of `/task`: the root checkout. */
  readonly directory: string
  /** The spec folder, absolute. */
  readonly specDir: string
  readonly plan: Plan
  /** The session that ran `/task`: the parent of every child session; aborting it cancels the run. */
  readonly root: string
  readonly limits: TaskLimits.Limits
}

interface Run extends Start {
  readonly key: string
  /** The time of this run's `run.started` or `run.resumed`: the run wall clock starts here. */
  readonly startedAt: number
  readonly state: Ref.Ref<State>
  readonly outside: Ref.Ref<ReadonlyArray<string>>
  /** The spec as last loaded from the root checkout: the current texts and hashes. */
  readonly spec: Ref.Ref<BlendModel.Spec>
  /** Serialises append → fold → status write. */
  readonly lock: Semaphore.Semaphore
  /** Serialises everything that reads or moves `main` in the root checkout. */
  readonly main: Semaphore.Semaphore
  /** Serialises worktree creation. */
  readonly git: Semaphore.Semaphore
  /** The child sessions with a turn in flight, and the directory of each. */
  readonly children: MutableHashMap.MutableHashMap<string, string>
  readonly failures: MutableHashMap.MutableHashMap<string, number>
  readonly stopping: Ref.Ref<boolean>
  /** Completed when the root session is aborted. */
  readonly cancelled: Deferred.Deferred<void>
}

type Workers = FiberMap.FiberMap<string>

const now = Clock.currentTimeMillis

// --- record, fold, project ---------------------------------------------------------------------------------------

const view = Effect.fnUntraced(function* (run: Run) {
  return { plan: run.plan, state: yield* Ref.get(run.state), outside: yield* Ref.get(run.outside) }
})

const writeStatus = Effect.fnUntraced(function* (run: Run) {
  yield* TaskStatus.write(run.directory, TaskStatus.project({ harness: "o3", ...(yield* view(run)) }))
})

/** The only way the state changes: the fact is appended, folded, and the status file rewritten. */
const record = (run: Run, fact: Fact) =>
  run.lock.withPermit(
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* HarnessLog.append(run.directory, { spec: run.plan.specPath, fact })
        yield* Ref.update(run.state, (state) => TaskEngineTable.apply(run.plan, state, fact))
        if (fact.type === "outside.trusted") {
          yield* Ref.update(run.outside, (ids) => (ids.includes(fact.id) ? ids : [...ids, fact.id]))
        }
        yield* writeStatus(run)
      }),
    ),
  )

const taskOf = Effect.fnUntraced(function* (run: Run, id: string) {
  return Option.fromNullishOr((yield* Ref.get(run.state)).tasks[id])
})

const obligationsOf = (spec: BlendModel.Spec, task: string) =>
  spec.obligations.filter((obligation) => obligation.task === task)

// --- child sessions ----------------------------------------------------------------------------------------------

// A turn is registered while it runs, so a cancel can reach it. An interrupted turn stays registered: interrupting
// the caller does not stop the session's own loop, only an abort does.
const inflight = <A, E, R>(run: Run, session: string, directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      if (yield* Ref.get(run.stopping)) return yield* Effect.interrupt
      return MutableHashMap.set(run.children, session, directory)
    }),
    () => effect,
    (_, exit) =>
      Exit.hasInterrupts(exit) ? Effect.void : Effect.sync(() => MutableHashMap.remove(run.children, session)),
  )

// Aborts the turns, each bounded by the cancel deadline.
const abortChildren = (run: Run, children: ReadonlyArray<readonly [string, string]>) =>
  Effect.forEach(
    children,
    ([session, directory]) =>
      HarnessDriver.abort(run.client, directory, session).pipe(
        Effect.interruptible,
        Effect.timeoutOption(run.limits.cancelDeadline),
        Effect.catchCause(() => Effect.void),
        Effect.andThen(Effect.sync(() => MutableHashMap.remove(run.children, session))),
      ),
    { concurrency: "unbounded", discard: true },
  )

// Restores a judge's directory to its HEAD; the root checkout only under the `main` semaphore, as it holds `main`.
const restore = (run: Run, directory: string) => {
  const reset = TaskWorkspace.restore(directory, run.limits)
  return directory === run.directory ? run.main.withPermit(reset) : reset
}

/** One verdict per id: the last one the judge recorded, so the merge and the engine read the same verdict. */
export const latestVerdicts = (verdicts: ReadonlyArray<Verdict>) =>
  verdicts.filter((verdict, index) => verdicts.findLastIndex((other) => other.id === verdict.id) === index)

/**
 * One judging round: a new verifier session per try, its marker and `judge` lines, and the verdicts it recorded
 * for the judged ids. A round with no verdict is tried once more; none after that is `Option.none()`.
 */
const round = Effect.fnUntraced(function* (run: Run, input: HarnessMessages.Judge & { readonly directory: string }) {
  const ids = input.judge.map((item) => item.id)
  for (const attempt of [1, 2]) {
    const session = yield* HarnessDriver.create(run.client, input.directory, {
      parentID: run.root,
      title: `${input.unit} ${input.role}${attempt > 1 ? " (again)" : ""}`,
      agent: HarnessRegistry.VERIFIER,
      permission: HarnessMessages.ruleset(HarnessMessages.verifierPermission),
    })
    const ask = (text: string, wanted: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        HarnessRegistry.startTurn(session)
        yield* inflight(
          run,
          session,
          input.directory,
          HarnessDriver.prompt(run.client, input.directory, { session, agent: HarnessRegistry.VERIFIER, text }),
        )
        return HarnessRegistry.takeVerdicts(session).filter((verdict) => wanted.includes(verdict.id))
      })
    const verdicts = latestVerdicts(yield* ask(HarnessMessages.judgeMessage(input), ids))
    // A judge that skipped some ids is asked once more, in the same session, for exactly those.
    const missing =
      verdicts.length === 0 ? [] : input.judge.filter((item) => !verdicts.some((verdict) => verdict.id === item.id))
    const more =
      missing.length === 0
        ? []
        : yield* ask(
            HarnessMessages.judgeMissingMessage(missing),
            missing.map((item) => item.id),
          )
    // Whatever the judge left in its directory goes, so it reaches neither a proof nor a builder commit.
    yield* restore(run, input.directory)
    if (verdicts.length > 0) return Option.some(latestVerdicts([...verdicts, ...more]))
  }
  return Option.none<ReadonlyArray<Verdict>>()
})

// --- proofs ------------------------------------------------------------------------------------------------------

const judged = (judges: ReadonlyArray<string>) => judges.includes("verifier") || judges.includes("reviewer")

/**
 * The proof results as facts: a failed proof is `failed` (a structural violation fails every test obligation and
 * names the path); a passed proof that a verifier or reviewer must judge, or a review, is `needs-judge`; a passed
 * proof that the runner or engine alone judges is `passed`. A failed gate of the task fails every test obligation
 * that did not fail on its own, so the task goes back to the builder.
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

/** The proofs of a leaf in its worktree between `base` and `head`: tests and the structural rule, then the gates. */
const proveLeaf = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task, model: TaskModel) {
  const { worktree, base, head } = model
  if (!worktree || !base || !head) return yield* proveOnMain(run, task)
  const spec = yield* Ref.get(run.spec)
  const input = { cwd: worktree, base, head, limits: run.limits }
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

/** Proves on `main` in the root checkout: a trusted task's stale obligations, or a parent's before its review. */
const proveOnMain = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const spec = yield* Ref.get(run.spec)
  const state = yield* Ref.get(run.state)
  const own = obligationsOf(spec, task.id)
  const stale = own.filter((obligation) => state.obligations[obligation.id]?.state === "stale")
  const targets = stale.length > 0 ? stale : own
  if (targets.every((obligation) => obligation.proof.kind === "review")) {
    const items = targets.map((obligation): Proved => ({ id: obligation.id, status: "needs-judge" }))
    return yield* proved(run, task.id, { results: items, reason: Option.none() })
  }
  return yield* run.main.withPermit(
    Effect.gen(function* () {
      const head = yield* TaskWorkspace.mainHead(run.directory, run.limits)
      const proof = yield* TaskProof.proveTask({
        spec: { gates: spec.gates, obligations: [...spec.obligations.filter((item) => item.task !== task.id), ...targets] },
        task: { id: task.id, touches: [], gates: [] },
        cwd: run.directory,
        base: head,
        head,
        limits: run.limits,
      })
      yield* proved(run, task.id, results(spec, proof, []))
    }),
  )
})

// --- the leaf lifecycle ------------------------------------------------------------------------------------------

// The obligations a later attempt reopens, with the reason of each: failed proofs, rejected verdicts, or, when the
// attempt ended otherwise (a repetition), every obligation not yet trusted with the task's reason.
const reopened = (spec: BlendModel.Spec, state: State, task: TaskModel): ReadonlyArray<HarnessMessages.Reopen> => {
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

/** A builder turn ended without `task_ready` twice after a nudge: its work is committed and proved failed. */
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
  const session = model.session
  const worktree = model.worktree
  HarnessRegistry.watch(session, run.limits.repetitionLimit)
  const history = yield* HarnessDriver.builderHistory(run.client, worktree, session)
  const fresh = !history.marked || history.attempt < model.attempts
  const spec = yield* Ref.get(run.spec)
  const state = yield* Ref.get(run.state)
  let text = fresh
    ? HarnessMessages.builderMessage({
        first: !history.marked,
        attempt: model.attempts,
        reopen: reopened(spec, state, model),
        task,
        spec,
        trusted: TaskStatus.trusted(yield* view(run)),
      })
    : HarnessMessages.continueMessage
  let nudges = 0
  while (true) {
    HarnessRegistry.startTurn(session)
    const turn = yield* inflight(
      run,
      session,
      worktree,
      HarnessDriver.builderTurn(run.client, {
        directory: worktree,
        session,
        agent: HarnessRegistry.BUILDER,
        text,
        limits: run.limits,
      }),
    )
    if (turn.outcome.kind === "spend-cap") {
      return yield* record(run, { type: "task.needs_human", at: yield* now, task: task.id, reason: turn.outcome.reason })
    }
    const repeated = HarnessRegistry.takeRepeated(session)
    if (Option.isSome(repeated)) {
      return yield* record(run, { type: "task.repeated", at: yield* now, task: task.id, reason: repeated.value })
    }
    if (Option.isSome(HarnessRegistry.takeReady(session))) {
      const head = yield* TaskWorkspace.commitAll(worktree, run.limits, `${task.id}: attempt ${model.attempts}`)
      yield* record(run, { type: "task.ready", at: yield* now, task: task.id, head })
      return yield* prove(run, task)
    }
    if (turn.outcome.kind === "stall") {
      yield* record(run, { type: "task.stalled", at: yield* now, task: task.id, reason: turn.outcome.reason })
      text = HarnessMessages.continueMessage
      continue
    }
    const cap = yield* HarnessDriver.spendCapError(run.client, worktree, session, turn.started)
    if (Option.isSome(cap)) {
      return yield* record(run, {
        type: "task.needs_human",
        at: yield* now,
        task: task.id,
        reason: `spend cap: ${HarnessMessages.oneLine(cap.value)}`,
      })
    }
    if (nudges < 2) {
      nudges++
      text = HarnessMessages.nudgeMessage
      continue
    }
    return yield* unready(run, task, worktree)
  }
})

/** A task in `proving`: a leaf's proofs in its worktree, or stale and parent obligations on `main`. */
const prove = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const found = yield* taskOf(run, task.id)
  if (Option.isNone(found) || found.value.state !== "proving") return yield* Effect.void
  const state = yield* Ref.get(run.state)
  const stale = obligationsOf(yield* Ref.get(run.spec), task.id).some(
    (obligation) => state.obligations[obligation.id]?.state === "stale",
  )
  if (found.value.leaf && !stale) return yield* proveLeaf(run, task, found.value)
  return yield* proveOnMain(run, task)
})

// Merges the proved and verified `head`, never the branch tip: a commit added after `task.ready` must not reach
// `main` unproven.
const mergeLeaf = Effect.fnUntraced(function* (run: Run, model: TaskModel) {
  if (!model.head) return
  const head = model.head
  yield* run.main
    .withPermit(
      Effect.gen(function* () {
        if (yield* TaskWorkspace.merged(run.directory, run.limits, head)) return
        yield* TaskWorkspace.merge(run.directory, run.limits, head)
      }),
    )
    .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced(Duration.millis(500)) }))
})

/**
 * A task in `verifying`: a verifier round for a leaf (in its worktree) or a review round for a parent (in the root
 * checkout), judging only the obligations in `passed`. A leaf whose obligations all end trusted merges first.
 */
const verify = Effect.fnUntraced(function* (run: Run, task: BlendModel.Task) {
  const found = yield* taskOf(run, task.id)
  if (Option.isNone(found) || found.value.state !== "verifying") return yield* Effect.void
  const model = found.value
  const spec = yield* Ref.get(run.spec)
  const state = yield* Ref.get(run.state)
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
            ? [`You verify task ${task.id}: ${task.title}.`, `Goal: ${HarnessMessages.oneLine(task.goal)}`]
            : [
                `You review task ${task.id}: ${task.title}. Its children are trusted and merged on the main branch.`,
                "Review their combined diff on the main branch (git log, git diff) against the obligations above.",
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
  const tree = yield* run.git.withPermit(TaskWorkspace.ensureWorktree(run.directory, task.id, run.limits))
  const session = yield* HarnessDriver.create(run.client, tree.worktree, {
    parentID: run.root,
    title: `${task.id} builder`,
    agent: HarnessRegistry.BUILDER,
    permission: HarnessMessages.ruleset(HarnessMessages.builderPermission),
  })
  HarnessRegistry.watch(session, run.limits.repetitionLimit)
  yield* record(run, {
    type: "task.started",
    at: yield* now,
    task: task.id,
    worktree: tree.worktree,
    branch: tree.branch,
    base: tree.base,
    session,
  })
  yield* build(run, task)
})

// --- scenarios ---------------------------------------------------------------------------------------------------

/** A scenario's tag result as a fact: passed stays passed; failed, and skipped (no test ran), are failed. */
export const scenarioOutcome = (
  proof: TaskProof.ScenarioProof,
): { readonly status: "passed" } | { readonly status: "failed"; readonly reason: string } => {
  const result = proof.result
  if (result.status === "passed") return { status: "passed" }
  if (result.status === "failed") return { status: "failed", reason: result.reason }
  return { status: "failed", reason: `skipped: every test titled [${proof.scenario}] was skipped` }
}

/** The scenarios whose needs became trusted together: one `bun test` run on `main` for the batch. */
const proveScenarios = Effect.fnUntraced(function* (run: Run, batch: ReadonlyArray<BlendModel.Scenario>) {
  yield* run.main.withPermit(
    Effect.gen(function* () {
      const head = yield* TaskWorkspace.mainHead(run.directory, run.limits)
      const proofs = yield* TaskProof.proveScenarios({
        scenarios: batch.map((scenario) => ({ id: scenario.id })),
        cwd: run.directory,
        head,
        limits: run.limits,
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

// --- stale obligations, wall clocks, the end ---------------------------------------------------------------------

/** Loads the spec from the root checkout; an obligation whose unit hash changed after it passed or was trusted is stale. */
const checkStale = Effect.fnUntraced(function* (run: Run) {
  const loaded = yield* Blend.load(run.specDir)
  if (!loaded.spec) return
  yield* Ref.set(run.spec, loaded.spec)
  const state = yield* Ref.get(run.state)
  for (const obligation of loaded.spec.obligations) {
    const current = state.obligations[obligation.id]
    if (!current || current.hash === obligation.hash) continue
    if (current.state !== "trusted" && current.state !== "passed") continue
    yield* record(run, { type: "obligation.stale", at: yield* now, id: obligation.id, hash: obligation.hash })
  }
})

const ACTIVE = ["building", "proving", "verifying"]

/**
 * When a task's wall clock started: its latest `building` entry after its latest `trusted` entry, never before
 * `runStart` (the latest start or resume), so downtime does not count. None for a task with no such entry.
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
    yield* record(run, { type: "run.ended", at, state: "failed", reason: `wall clock: the run took over ${minutes} min` })
    return
  }
  if (Option.isNone(run.limits.taskWallClock)) return
  const limit = Duration.toMillis(run.limits.taskWallClock.value)
  const state = yield* Ref.get(run.state)
  for (const task of Object.values(state.tasks)) {
    if (!ACTIVE.includes(task.state)) continue
    const started = taskClockStart(state.history, task.id, run.startedAt)
    if (Option.isNone(started) || at - started.value <= limit) continue
    yield* FiberMap.remove(workers, task.id)
    if (task.session && task.worktree) {
      yield* HarnessDriver.abort(run.client, task.worktree, task.session).pipe(Effect.ignore)
    }
    const minutes = Math.round(limit / 60_000)
    yield* record(run, { type: "task.failed", at, task: task.id, reason: `wall clock: the task took over ${minutes} min` })
  }
})

const JUDGED = ["trusted", "rejected", "failed"]

/**
 * Ends the run once every plan task is trusted and every scenario is judged or waits only on `outside`: `done` when
 * every judged scenario is trusted, `failed` (naming them) when any acceptance proof failed or was rejected.
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
  if (!tasks || !scenarios) return yield* Effect.void
  const unproved = run.plan.scenarios.filter((scenario) => {
    const current = state.scenarios[scenario.id]?.state
    return current === "failed" || current === "rejected"
  })
  if (unproved.length === 0) return yield* record(run, { type: "run.ended", at: yield* now, state: "done" })
  const reason = `acceptance not proved: ${unproved.map((scenario) => `${scenario.id} ${state.scenarios[scenario.id]?.state}`).join(", ")}`
  return yield* record(run, { type: "run.ended", at: yield* now, state: "failed", reason })
})

// --- scheduling --------------------------------------------------------------------------------------------------

const MAX_FAILURES = 3

// A worker that fails is retried on a later tick; the third failure in a row ends its unit with the error. The
// scenario batch ends only the scenarios it held (`batch`).
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
        const message = HarnessMessages.oneLine(Cause.pretty(cause)).slice(0, 600)
        yield* Effect.logWarning("task harness o3: a worker failed", { key, count, message })
        if (count < MAX_FAILURES) return yield* Effect.sleep(Duration.seconds(1))
        const reason = `harness error: ${message}`
        const state = yield* Ref.get(run.state)
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
          (id) => Effect.flatMap(now, (at) => record(run, { type: "scenario.proved", at, id, status: "failed", reason })),
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
  while (!TaskEngineTable.ended((yield* Ref.get(run.state)).run.state)) {
    yield* checkWallClocks(run, workers)
    if (tick % STALE_EVERY === 0) yield* checkStale(run)
    yield* schedule(run, workers)
    yield* checkDone(run)
    tick++
    yield* Effect.sleep(TICK)
  }
})

// Stops every worker and every child turn in flight at once: new turns are refused from the first step on, the
// turns in flight are aborted, and a turn that started meanwhile is aborted last.
const stopWork = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  yield* Ref.set(run.stopping, true)
  const children = [...run.children]
  const clearing = yield* FiberMap.clear(workers).pipe(Effect.forkChild)
  yield* abortChildren(run, children)
  yield* Fiber.await(clearing).pipe(Effect.interruptible, Effect.timeoutOption(run.limits.cancelDeadline))
  yield* abortChildren(run, [...run.children])
})

// The root session was aborted: the run ends `cancelled` (recorded at once, so the status says so within the
// cancel deadline) while the child turns are aborted and the workers stop.
const cancel = Effect.fnUntraced(function* (run: Run, workers: Workers) {
  yield* Ref.set(run.stopping, true)
  yield* Effect.all([record(run, { type: "run.cancelled", at: yield* now, reason: "cancelled" }), stopWork(run, workers)], {
    concurrency: "unbounded",
    discard: true,
  })
})

/**
 * Runs the run of `start.plan` to its end: resumes the stored run when it has not ended, else starts a new one.
 * Its result is the end state.
 */
export const run = Effect.fn("HarnessRunner.run")(function* (start: Start) {
  const key = HarnessRegistry.runKey(start.directory, start.plan.specPath)
  const entries = yield* HarnessLog.read(start.directory)
  const resumed = Option.filter(
    HarnessLog.latestRun(entries, start.plan.specPath),
    (facts) => !TaskEngineTable.ended(HarnessLog.fold(start.plan, facts).run.state),
  )
  const facts = Option.getOrElse(resumed, (): ReadonlyArray<Fact> => [])
  const at = yield* now
  const self: Run = {
    ...start,
    key,
    startedAt: at,
    state: yield* Ref.make(HarnessLog.fold(start.plan, facts)),
    outside: yield* Ref.make(HarnessLog.trustedOutside(facts)),
    spec: yield* Ref.make(start.plan.spec),
    lock: yield* Semaphore.make(1),
    main: yield* Semaphore.make(1),
    git: yield* Semaphore.make(1),
    children: MutableHashMap.empty(),
    failures: MutableHashMap.empty(),
    stopping: yield* Ref.make(false),
    cancelled: yield* Deferred.make<void>(),
  }
  const trust = (outside: string) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(self.outside)).includes(outside)) return
      yield* record(self, { type: "outside.trusted", at: yield* now, id: outside })
    })
  const body = Effect.gen(function* () {
    yield* record(self, { type: Option.isSome(resumed) ? "run.resumed" : "run.started", at })
    yield* Effect.forEach(HarnessLog.directoryTrust(entries), trust, { discard: true })
    const workers = yield* FiberMap.make<string>()
    const stopped = yield* loop(self, workers).pipe(
      Effect.as(false),
      Effect.raceFirst(Deferred.await(self.cancelled).pipe(Effect.as(true))),
    )
    if (stopped) yield* cancel(self, workers)
    else yield* stopWork(self, workers)
    return (yield* Ref.get(self.state)).run.state
  })
  // `/task trust` reaches the run from another fiber: it gets the run's services, and a failed record is logged.
  const services = yield* Effect.context<Requirements>()
  HarnessRegistry.register(key, {
    directory: start.directory,
    root: start.root,
    trust: (outside) =>
      trust(outside).pipe(
        Effect.provide(services),
        Effect.catch((error) => Effect.logWarning("task harness o3: the trust record failed", { error: error.message })),
      ),
    cancel: Deferred.done(self.cancelled, Exit.void).pipe(Effect.asVoid),
  })
  return yield* Effect.scoped(body).pipe(Effect.ensuring(Effect.sync(() => HarnessRegistry.unregister(key))))
})

export * as HarnessRunner from "./runner"

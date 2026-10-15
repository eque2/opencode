import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Clock, type Context, Effect, Layer, Option, Path, Random, Result, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskEngineXState } from "@/task/engine-xstate"
import { TaskLimits } from "@/task/limits"
import { TaskEvents } from "./events"
import type { TaskHarness } from "./harness"
import type { Fact, Plan } from "./model"
import type { Ops } from "./ops"
import { TaskRecorder } from "./recorder"
import type { TaskSessions } from "./sessions"
import { TaskStatus } from "./status"
import { RunSupervisor } from "./supervise/run"
import type { TaskWorkers } from "./workers"
import { TaskWorkspace } from "./workspace"

// `/task` of the task harness. `SessionPrompt.command` calls `run` before it reads any template, so no model
// request is made here: the command answers with a user message created with `noReply`, and the run goes on as a
// background job tied to the root session (aborting that session cancels it). The job runs the run on the harness
// (spine AD-8, AD-19): it holds the directory's lease, builds the Recorder, and asks the harness root to spawn the run
// supervisor.
//
//   /task <path>       runs the blend task tree at <path> (a `.spec` folder, or a `.task` folder inside one),
//                      or resumes the stored run of that spec when it has not ended
//   /task trust <id>   records the `outside` precondition <id> as trusted for the runs in this directory

/** What `SessionPrompt.command` passes on: the fields of its `CommandInput` the harness reads. */
export interface CommandInput {
  readonly sessionID: SessionID
  readonly arguments: string
  readonly model?: string
  readonly agent?: string
}

/** The harness cannot run: a service it needs is missing from the caller's context. */
export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()("TaskHarnessUnavailable", {
  message: Schema.String,
}) {}

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const required = <I, S>(key: Context.Key<I, S>, name: string) =>
  Effect.flatMap(Effect.serviceOption(key), (found) =>
    Option.match(found, {
      onNone: () => Effect.die(new HarnessUnavailable({ message: `the task harness needs ${name}` })),
      onSome: Effect.succeed,
    }),
  )

// The services are resolved from the caller's context at run time: `SessionPrompt` cannot depend on the harness
// layer-wise (the harness prompts sessions through it), and every opencode runtime that serves a session provides
// them.
const environment = (ops: Ops) =>
  Effect.gen(function* () {
    return {
      sessions: yield* required(Session.Service, "Session"),
      status: yield* required(SessionStatus.Service, "SessionStatus"),
      instances: yield* required(InstanceStore.Service, "InstanceStore"),
      events: yield* required(EventV2Bridge.Service, "EventV2Bridge"),
      background: yield* required(BackgroundJob.Service, "BackgroundJob"),
      db: (yield* required(Database.Service, "Database")).db,
      ops,
    } satisfies TaskSessions.Env
  })

const TASK_FOLDER = /^(T[1-9][0-9]*(?:\.[1-9][0-9]*)*)-[a-z0-9-]+\.task$/

// The `.spec` folder at or above `target`, inside `directory`.
const specFolder = (path: Path.Path, directory: string, target: string): Option.Option<string> => {
  const inside = (candidate: string) => {
    const rel = path.relative(directory, candidate)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  }
  const walk = (candidate: string): Option.Option<string> => {
    if (!inside(candidate)) return Option.none()
    if (path.basename(candidate).endsWith(".spec")) return Option.some(candidate)
    const parent = path.dirname(candidate)
    return parent === candidate ? Option.none() : walk(parent)
  }
  return walk(target)
}

/** The plan of a `/task <path>`: the tasks under the path and the scenarios they (with `outside`) can satisfy. */
export const plan = (input: {
  readonly spec: BlendModel.Spec
  readonly specPath: string
  readonly path: string
  readonly root: Option.Option<string>
}): Plan => {
  const { spec } = input
  const tasks = Option.match(input.root, {
    onNone: () => spec.tasks,
    onSome: (root) => spec.tasks.filter((task) => task.id === root || task.id.startsWith(`${root}.`)),
  })
  const ids = tasks.map((task) => task.id)
  const outsideRun = (id: string) => !ids.includes(id) && !(id in spec.outside)
  return {
    spec,
    specPath: input.specPath,
    path: input.path,
    ...Option.match(input.root, { onNone: () => ({}), onSome: (root) => ({ root }) }),
    tasks,
    scenarios: spec.scenarios.filter((scenario) => scenario.needs.every((id) => ids.includes(id) || id in spec.outside)),
    external: tasks
      .flatMap((task) => task.afterEffective.filter(outsideRun))
      .filter((id, index, all) => all.indexOf(id) === index)
      .toSorted(TaskEngineXState.byId),
    budget: (id) =>
      spec.tasks.find((task) => task.id === id)?.policy.budgets.taskAttempts ?? spec.policy.budgets.taskAttempts,
  }
}

/** The one line a `/task` gets while another run is live in the directory (AD-19; EXPERIENCE "Busy reply"). */
export const busyLine = (live: TaskHarness.Live) =>
  `Not started: the run of ${live.spec} is live in this directory (/task ${live.path}). One run at a time: wait for it to end, or stop it in its own session with ctrl+x w, then esc twice.`

/** The `/task` path as the run stores it: relative to the directory, so `x/`, `./x` and `x` name one run. */
export const normalizedPath = (path: Path.Path, directory: string, target: string) => path.relative(directory, target) || "."

/** What a `/task` starts from: the open slice it resumes, or a new slice (and why, when a stored slice could not fold). */
export type Slice =
  | { readonly kind: "resume"; readonly facts: ReadonlyArray<Fact> }
  | { readonly kind: "new"; readonly died: Option.Option<string> }

// The path a slice ran: its first fact's, or the whole spec for a slice stored before `run.started` had a path.
const pathOf = (facts: ReadonlyArray<Fact>, specPath: string) => {
  const first = facts[0]
  return first !== undefined && (first.type === "run.started" || first.type === "run.resumed") && first.path !== undefined
    ? first.path
    : specPath
}

/**
 * The slice a `/task <path>` starts from (SV3, RM8a-c): the latest stored slice when it has not ended (no stored stop,
 * and its fold is not `done`) and ran the same path; else a new slice. A latest slice whose fold dies (an `error`
 * snapshot, RM28) counts as ended, with the defect named (SV26).
 */
export const sliceOf = (plan: Plan, stored: ReadonlyArray<Fact>, path: string): Effect.Effect<Slice> =>
  Option.match(TaskEvents.latestRun(stored), {
    onNone: () => Effect.succeed<Slice>({ kind: "new", died: Option.none() }),
    onSome: (facts) =>
      Effect.try(() => TaskEvents.fold(TaskEngineXState.XStateEngine, plan, facts)).pipe(
        Effect.map(
          (snapshot): Slice =>
            !TaskEngineXState.ended(snapshot) && pathOf(facts, plan.specPath) === path
              ? { kind: "resume", facts }
              : { kind: "new", died: Option.none() },
        ),
        Effect.catch((error) => {
          const defect = error.cause instanceof Error ? error.cause.message : String(error.cause)
          return Effect.as(Effect.logError("task harness: the stored run could not be folded", { error: defect }), {
            kind: "new",
            died: Option.some(defect),
          } satisfies Slice)
        }),
      ),
  })

/** Everything the job of a run needs, resolved by `/task`. */
export interface Start {
  readonly harness: TaskHarness.Interface
  readonly env: TaskSessions.Env
  readonly id: string
  readonly directory: string
  readonly base: string
  readonly specDir: string
  readonly plan: Plan
  /** The `/task` path, normalised: the slice's `path`. */
  readonly path: string
  readonly slice: Slice
  readonly root: SessionID
  readonly model: TaskSessions.Model
  readonly limits: TaskLimits.Limits
  readonly locks: TaskHarness.Locks
}

/**
 * The job of a run (AD-8): the run scope's first finalizer frees the lease, so it runs last; then the Recorder (the run
 * actor and the status writer); then the cancel finalizer (on a job cancel it records `run.cancelled` and gives the
 * supervisor `cancelDeadline`; on a scope close it only stops the run's actors, SV27); then the run supervisor, which
 * the job waits for. Its result is the end state.
 */
export const job = Effect.fn("TaskCommand.job")(function* (start: Start) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() => start.harness.release(start.directory, start.id))
      const recorder = yield* TaskRecorder.make({
        plan: start.plan,
        runID: start.id,
        directory: start.directory,
        stored: start.slice.kind === "resume" ? start.slice.facts : [],
        events: start.env.events,
      })
      const run: TaskWorkers.Run = {
        env: start.env,
        id: start.id,
        directory: start.directory,
        base: start.base,
        specDir: start.specDir,
        plan: start.plan,
        root: start.root,
        model: start.model,
        limits: start.limits,
        locks: start.locks,
        recorder,
        claim: start.harness.claimSession,
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const cancelled = yield* start.env.background.get(start.id).pipe(
            Effect.map((info) => info?.status === "cancelled"),
            Effect.orElseSucceed(() => false),
          )
          if (cancelled) return yield* RunSupervisor.cancel(start.harness, run)
          return yield* start.harness.removeRun(start.id)
        }),
      )
      const trusts = TaskEvents.read(start.env.db, TaskEvents.directoryID(start.directory)).pipe(
        Effect.map(TaskEvents.trustedOutside),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      )
      yield* RunSupervisor.supervise(start.harness, {
        run,
        events: start.env.events,
        resumed: start.slice.kind === "resume",
        path: start.path,
        trusts,
        release: start.harness.release(start.directory, start.id),
        writer: recorder.writer,
      })
      return TaskEngineXState.view(yield* recorder.actor.getSnapshot).run.state
    }),
  )
})

const TRUST = /^trust\s+(\S+)$/

/**
 * Runs `/task`: a refusal, a trust record, a busy reply, or a run started (or resumed) in the background on the
 * harness. Never prompts a model. The type is the contract with `SessionPrompt.command`: no error and no requirement.
 */
export const run: (input: CommandInput, ops: Ops, harness: TaskHarness.Interface) => Effect.Effect<SessionV1.WithParts> =
  Effect.fn("TaskCommand.run")(function* (input: CommandInput, ops: Ops, harness: TaskHarness.Interface) {
    const model = yield* ops.currentModel(input.sessionID)
    const reply = (text: string) =>
      ops.prompt({
        sessionID: input.sessionID,
        agent: input.agent ?? "",
        model,
        parts: [{ type: "text", text }],
        noReply: true,
      })
    const ctx = yield* InstanceState.context
    const directory = ctx.directory
    const args = input.arguments.trim()

    // A trust goes to the directory's aggregate, then to the run of the directory, if one is live (SV20).
    const trusted = TRUST.exec(args)
    if (trusted) {
      const id = trusted[1]
      const env = yield* environment(ops)
      yield* TaskEvents.publish(env.events, TaskEvents.directoryID(directory), {
        type: "outside.trusted",
        at: yield* Clock.currentTimeMillis,
        id,
      })
      yield* harness.trust(directory, id)
      return yield* reply(`Task harness: recorded the outside precondition ${id} as trusted.`)
    }
    if (args === "") return yield* reply("Usage: /task <path to a .spec or .task folder> | /task trust <id>")

    const limits = yield* TaskLimits.load
    // Before the first status write, refusals included. Outside a git repository there is nothing to exclude from.
    yield* TaskWorkspace.ensureExcluded(directory, limits).pipe(Effect.ignore)
    const path = yield* Path.Path
    const target = path.resolve(directory, args)
    const found = specFolder(path, directory, target)
    // While a run is live, a refusal answers in the session only: the live run's status file stays (AD-19).
    const refuse = (spec: string, reason: string) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* harness.live(directory)))
          yield* TaskStatus.write(directory, TaskStatus.refused({ spec, path: args, reason }))
        return yield* reply(`Task harness: refused ${args}: ${reason}`)
      })
    // The checks run in the AD-19 order: usage, loader, task folder, the live run, git, the unfinished base, then the
    // claim and the job.
    if (Option.isNone(found)) return yield* refuse(args, `R1 ${args}: not inside a \`<slug>.spec\` folder`)
    const specDir = found.value
    const specPath = path.relative(directory, specDir)
    const loaded = yield* Blend.load(specDir)
    const first = loaded.failures[0]
    if (first) return yield* refuse(specPath, `${first.rule} ${first.path}: ${first.message}`)
    if (!loaded.spec) return yield* refuse(specPath, `R1 .: the spec did not load`)
    const spec = loaded.spec

    const folder = target === specDir ? Option.none<string>() : Option.some(path.basename(target))
    const root = Option.flatMap(folder, (name) => Option.fromNullishOr(TASK_FOLDER.exec(name)?.[1]))
    if (Option.isSome(folder) && Option.isNone(root)) {
      return yield* refuse(specPath, `R2 ${path.relative(specDir, target)}: not a \`<task id>-<slug>.task\` folder`)
    }
    if (Option.isSome(root) && !spec.tasks.some((task) => task.id === root.value)) {
      return yield* refuse(specPath, `R2 ${path.relative(specDir, target)}: no task ${root.value} in the spec`)
    }

    // One live run per directory (owner ruling 3): a valid spec gets the busy reply and starts nothing.
    const live = yield* harness.live(directory)
    if (Option.isSome(live)) return yield* reply(busyLine(live.value))

    // The leaves branch from the checked-out branch and merge back into it (`TaskWorkspace.readiness`).
    const ready = yield* TaskWorkspace.readiness(directory, limits).pipe(
      Effect.catch((error) => Effect.succeed(Result.fail(`git could not read the checkout: ${error.message}`))),
    )
    if (Result.isFailure(ready)) return yield* refuse(specPath, ready.failure)
    const base = ready.success

    // The services are resolved only once nothing refuses, so a refusal needs no session runtime.
    const env = yield* environment(ops)
    const runPath = normalizedPath(path, directory, target)
    const runPlan = plan({ spec, specPath, path: runPath, root })
    const id = TaskEvents.runID(directory, specPath)
    const slice = yield* sliceOf(runPlan, yield* TaskEvents.read(env.db, id), runPath)
    // A resumed slice must keep its base branch: the leaves merged so far are there.
    const startedOn =
      slice.kind === "resume"
        ? Option.fromNullishOr(slice.facts.flatMap((fact) => (fact.type === "run.started" && fact.base ? [fact.base] : []))[0])
        : Option.none<string>()
    if (Option.isSome(startedOn) && startedOn.value !== base) {
      return yield* refuse(
        specPath,
        `the unfinished run of ${specPath} started on the branch ${startedOn.value}; switch back to it to resume the run`,
      )
    }
    // The D13 check of a subtree run (T3.4) goes here, before the claim.

    const claimed = yield* harness.claim({ directory, runID: id, spec: specPath, path: runPath })
    if (claimed.kind === "busy") return yield* reply(busyLine(claimed))
    // The job's own token tells a job this call started from one of that id that was already running.
    const token = String(yield* Random.nextIntBetween(0, 0x7fffffff))
    const info = yield* env.background
      .start({
        id,
        type: "task-harness",
        title: `/task ${args}`,
        metadata: { parentSessionId: input.sessionID, claim: token },
        run: job({
          harness,
          env,
          id,
          directory,
          base,
          specDir,
          plan: runPlan,
          path: runPath,
          slice,
          root: input.sessionID,
          model,
          limits,
          locks: claimed.locks,
        }).pipe(
          Effect.map((state) => `the task run of ${specPath} ended ${state}`),
          Effect.provide(platform),
        ),
      })
      .pipe(Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : harness.release(directory, id))))
    if (info.metadata?.claim !== token) {
      yield* harness.release(directory, id)
      return yield* reply(`Task harness: the run of ${specPath} is already going on.`)
    }
    const note = Option.match(slice.kind === "new" ? slice.died : Option.none<string>(), {
      onNone: () => "",
      onSome: (error) => ` The stored run could not be resumed (${error.replace(/\s*\n\s*/g, " | ")}), so a new run started.`,
    })
    return yield* reply(
      `Task harness: running ${args} in the background. Its status is in .opencode/task/status.json.${note}`,
    )
  }, Effect.provide(platform))

export * as TaskCommand from "./command"

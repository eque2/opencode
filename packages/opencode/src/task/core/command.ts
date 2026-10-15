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
import type { Ops, PromptInput } from "./ops"
import { TaskRecorder } from "./recorder"
import type { TaskSessions } from "./sessions"
import { TaskStatus } from "./status"
import { RunSupervisor } from "./supervise/run"
import { TaskWorkers } from "./workers"
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

/**
 * The refusal lines of a load (D10, AD-14): one `<rule> <path>: <message>` line for each failure, in the load's order;
 * the one fallback line when the load gave neither a spec nor a failure; none for a spec that loaded.
 */
export const loadFailures = (loaded: BlendModel.LoadResult): ReadonlyArray<string> => {
  if (loaded.failures.length > 0)
    return loaded.failures.map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)
  return loaded.spec ? [] : ["R1 .: the spec did not load"]
}

/** The scenarios a plan leaves out: each needs a task that is neither in the run nor an `outside` precondition. */
export const leftOut = (plan: Plan): ReadonlyArray<string> =>
  plan.spec.scenarios.filter((scenario) => !plan.scenarios.includes(scenario)).map((scenario) => scenario.id)

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

/** What the D13 trust walk found for a folder task outside a subtree run (AD-15, SD-13). */
export type FolderTrust =
  | { readonly kind: "trusted" }
  | { readonly kind: "untrusted" }
  /** A slice newer than any deciding slice whose path no longer loads, or whose fold dies. */
  | { readonly kind: "blocked"; readonly path: string }

// The plan a stored slice ran, from its path; none when the path no longer names the spec or one of its task folders.
const slicePlan = (spec: BlendModel.Spec, specPath: string, path: string): Option.Option<Plan> => {
  if (path === specPath) return Option.some(plan({ spec, specPath, path, root: Option.none() }))
  if (!path.startsWith(`${specPath}/`)) return Option.none()
  const rel = path.slice(specPath.length + 1)
  const root = Option.fromNullishOr(TASK_FOLDER.exec(rel.split("/").at(-1) ?? "")?.[1])
  if (Option.isNone(root) || TaskWorkers.folderOf(spec, root.value) !== rel) return Option.none()
  return Option.some(plan({ spec, specPath, path, root }))
}

/**
 * The trust of a folder task outside a subtree run (AD-15, SD-13): the stored slices from the newest back, each folded
 * through its own plan's machine; the first whose plan holds the task, as a task or an external region, decides. A
 * slice whose path no longer loads blocks the walk when it comes before that slice. Trust typed with `/task trust`
 * never counts: it lives on the directory aggregate.
 */
export const folderTrust = (
  spec: BlendModel.Spec,
  specPath: string,
  stored: ReadonlyArray<Fact>,
  id: string,
): Effect.Effect<FolderTrust> => {
  const walk = (slices: ReadonlyArray<ReadonlyArray<Fact>>): Effect.Effect<FolderTrust> => {
    const facts = slices.at(-1)
    if (facts === undefined) return Effect.succeed({ kind: "untrusted" })
    const path = pathOf(facts, specPath)
    const own = slicePlan(spec, specPath, path)
    if (Option.isNone(own)) return Effect.succeed({ kind: "blocked", path })
    if (!own.value.tasks.some((task) => task.id === id) && !own.value.external.includes(id)) return walk(slices.slice(0, -1))
    return Effect.try(() => TaskEvents.fold(TaskEngineXState.XStateEngine, own.value, facts)).pipe(
      Effect.map((snapshot): FolderTrust => ({
        kind: TaskEngineXState.unitState(snapshot, id) === "trusted" ? "trusted" : "untrusted",
      })),
      Effect.orElseSucceed((): FolderTrust => ({ kind: "blocked", path })),
    )
  }
  return walk(TaskEvents.slices(stored))
}

/**
 * The base branch a resumed slice started on: a resume must use the same branch, because the leaves merged so far are
 * there. None for a new slice, or a slice stored before `run.started` recorded its base.
 */
export const unfinishedBase = (slice: Slice): Option.Option<string> =>
  slice.kind === "resume"
    ? Option.fromNullishOr(slice.facts.flatMap((fact) => (fact.type === "run.started" && fact.base ? [fact.base] : []))[0])
    : Option.none()

/**
 * The run header (D17, AD-13): `Implementing spec **<title>**`, or for a subtree run `Implementing **<id> <title>**
 * from spec **<title>**`, then the scenarios it leaves out; the same as structured metadata, which the TUI draws from.
 * An empty H1 reads as the spec id; the metadata keeps the title as written.
 */
export const header = (plan: Plan) => {
  const id = TaskStatus.specIdOf(plan.specPath)
  const title = plan.spec.title === "" ? id : plan.spec.title
  const root = plan.tasks.find((task) => task.id === plan.root)
  const left = leftOut(plan)
  const head = root ? `Implementing **${root.id} ${root.title}** from spec **${title}**` : `Implementing spec **${title}**`
  // The `Header` as JSON, the type a text part's metadata takes.
  const task: ReadonlyArray<[string, Schema.MutableJson]> = root ? [["task", { id: root.id, title: root.title }]] : []
  return {
    text: left.length === 0 ? head : `${head}\nLeft out: ${left.join(", ")} — they need tasks outside this run.`,
    metadata: {
      taskHarness: {
        header: Object.fromEntries([["spec", { id, title: plan.spec.title }], ...task, ["leftOut", [...left]]]),
      },
    },
  }
}

/** The note after the header when a stored slice's fold died, so the user knows the run did not resume (SV26). */
export const diedLine = (slice: Slice) =>
  Option.map(
    slice.kind === "new" ? slice.died : Option.none<string>(),
    (error) => `The stored run could not be resumed (${error.replace(/\s*\n\s*/g, " | ")}), so a new run started.`,
  )

/** The parts of a run's first message: the header, then the note of a stored run that could not resume. */
export const headerParts = (plan: Plan, slice: Slice): PromptInput["parts"] => [
  { type: "text", ...header(plan) },
  ...Option.toArray(Option.map(diedLine(slice), (text) => ({ type: "text" as const, text }))),
]

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
  /** The external regions the D13 walk found trusted (AD-15). */
  readonly externals: ReadonlyArray<string>
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
        externals: start.externals,
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
    // A refusal (EXPERIENCE "Refusal", D10): a header, the lines of `run.reason`, then a hint. Rule failures get a
    // counted header and the hint; a plain line says what to do on its own. While a run is live, a refusal answers in
    // the session only: the live run's status file stays (AD-19).
    const refuse = (spec: string, lines: ReadonlyArray<string>, hint: Option.Option<string>) =>
      Effect.gen(function* () {
        const reason = lines.join("\n")
        if (Option.isNone(yield* harness.live(directory)))
          yield* TaskStatus.write(directory, TaskStatus.refused({ spec, path: args, reason }))
        const header = Option.isSome(hint)
          ? `Refused ${args}: ${lines.length} ${lines.length === 1 ? "failure" : "failures"}. No work started.`
          : `Refused ${args}. No work started.`
        return yield* reply([header, ...lines, ...Option.toArray(hint)].join("\n"))
      })
    const failed = (spec: string, lines: ReadonlyArray<string>) =>
      refuse(spec, lines, Option.some(`Fix each line, then type /task ${args} again.`))
    const plain = (spec: string, line: string) => refuse(spec, [line], Option.none())
    // The checks run in the AD-19 order: usage, loader, task folder, the live run, git, the unfinished base, the D13
    // check of a subtree run, then the claim and the job.
    if (Option.isNone(found)) return yield* failed(args, [`R1 ${args}: not inside a \`<slug>.spec\` folder`])
    const specDir = found.value
    const specPath = path.relative(directory, specDir)
    const loaded = yield* Blend.load(specDir)
    const spec = loaded.spec
    const lines = loadFailures(loaded)
    if (lines.length > 0 || !spec) return yield* failed(specPath, lines)
    if (spec.tasks.length === 0) return yield* plain(specPath, "the spec holds no task")

    const folder = target === specDir ? Option.none<string>() : Option.some(path.basename(target))
    const root = Option.flatMap(folder, (name) => Option.fromNullishOr(TASK_FOLDER.exec(name)?.[1]))
    if (Option.isSome(folder) && Option.isNone(root)) {
      return yield* failed(specPath, [`R2 ${path.relative(specDir, target)}: not a \`<task id>-<slug>.task\` folder`])
    }
    if (Option.isSome(root) && !spec.tasks.some((task) => task.id === root.value)) {
      return yield* failed(specPath, [`R2 ${path.relative(specDir, target)}: no task ${root.value} in the spec`])
    }

    // One live run per directory (owner ruling 3): a valid spec gets the busy reply and starts nothing.
    const live = yield* harness.live(directory)
    if (Option.isSome(live)) return yield* reply(busyLine(live.value))

    // The leaves branch from the checked-out branch and merge back into it (`TaskWorkspace.readiness`).
    const ready = yield* TaskWorkspace.readiness(directory, limits).pipe(
      Effect.catch((error) => Effect.succeed(Result.fail(`git could not read the checkout: ${error.message}`))),
    )
    if (Result.isFailure(ready)) return yield* plain(specPath, ready.failure)
    const base = ready.success

    // The services are resolved only once nothing refuses, so a refusal needs no session runtime.
    const env = yield* environment(ops)
    const runPath = normalizedPath(path, directory, target)
    const runPlan = plan({ spec, specPath, path: runPath, root })
    const id = TaskEvents.runID(directory, specPath)
    const stored = yield* TaskEvents.read(env.db, id)
    const slice = yield* sliceOf(runPlan, stored, runPath)
    // A resumed slice must keep its base branch: the leaves merged so far are there.
    const startedOn = unfinishedBase(slice)
    if (Option.isSome(startedOn) && startedOn.value !== base) {
      return yield* plain(
        specPath,
        `the unfinished run of ${specPath} started on the branch ${startedOn.value}; switch back to it to resume the run`,
      )
    }
    // A subtree run needs each folder task outside it that a run task is after to be trusted (D13, AD-15).
    const trusts = yield* Effect.forEach(runPlan.external, (other) =>
      Effect.map(folderTrust(spec, specPath, stored, other), (trust) => ({ other, trust })),
    )
    const blocked = trusts.flatMap((item) => (item.trust.kind === "blocked" ? [item.trust.path] : []))[0]
    if (blocked !== undefined) {
      return yield* plain(
        specPath,
        `the stored run of /task ${blocked} no longer loads; run the whole spec once to record a newer run`,
      )
    }
    const untrusted = trusts.filter((item) => item.trust.kind === "untrusted").map((item) => item.other)
    if (untrusted.length > 0) {
      const lines = untrusted.map((other) => {
        const task = runPlan.tasks.find((item) => item.afterEffective.includes(other))?.id ?? Option.getOrElse(root, () => "")
        return `R12 ${TaskWorkers.folderOf(spec, task)}: ${task} is after ${other}, which is outside this run and not trusted`
      })
      return yield* refuse(specPath, lines, Option.some(`Run the whole spec, or a folder that holds ${untrusted.join(" and ")}.`))
    }

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
          externals: runPlan.external,
          root: input.sessionID,
          model,
          limits,
          locks: claimed.locks,
        }).pipe(
          // The closing summary reports the end in the root session (D18); the job's output carries nothing.
          Effect.as(""),
          Effect.provide(platform),
        ),
      })
      .pipe(Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : harness.release(directory, id))))
    if (info.metadata?.claim !== token) {
      yield* harness.release(directory, id)
      return yield* reply(`Task harness: the run of ${specPath} is already going on.`)
    }
    return yield* ops.prompt({
      sessionID: input.sessionID,
      agent: input.agent ?? "",
      model,
      parts: headerParts(runPlan, slice),
      noReply: true,
    })
  }, Effect.provide(platform))

export * as TaskCommand from "./command"

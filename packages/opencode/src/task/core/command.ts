import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Clock, type Context, Effect, Layer, Option, Path, Result, Schema } from "effect"
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
import type { Plan } from "./model"
import type { Ops } from "./ops"
import { TaskRunner } from "./runner"
import type { TaskSessions } from "./sessions"
import { TaskStatus } from "./status"
import { TaskWorkspace } from "./workspace"

// `/task` of the task harness. `SessionPrompt.command` calls `run` before it reads any template, so no model
// request is made here: the command answers with a user message created with `noReply`, and the run goes on as a
// background job tied to the root session (aborting that session cancels it).
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
  return {
    spec,
    specPath: input.specPath,
    path: input.path,
    tasks,
    scenarios: spec.scenarios.filter((scenario) => scenario.needs.every((id) => ids.includes(id) || id in spec.outside)),
    budget: (id) =>
      spec.tasks.find((task) => task.id === id)?.policy.budgets.taskAttempts ?? spec.policy.budgets.taskAttempts,
  }
}

const TRUST = /^trust\s+(\S+)$/

/**
 * Runs `/task`: a refusal, a trust record, or a run started (or resumed) in the background. Never prompts a model.
 * The type is the contract with `SessionPrompt.command`: no error and no requirement.
 */
export const run: (input: CommandInput, ops: Ops) => Effect.Effect<SessionV1.WithParts> = Effect.fn("TaskCommand.run")(function* (
  input: CommandInput,
  ops: Ops,
) {
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

  const trusted = TRUST.exec(args)
  if (trusted) {
    const id = trusted[1]
    const env = yield* environment(ops)
    yield* TaskEvents.publish(env.events, TaskEvents.directoryID(directory), {
      type: "outside.trusted",
      at: yield* Clock.currentTimeMillis,
      id,
    })
    yield* TaskRunner.trustActive(directory, id)
    return yield* reply(`Task harness: recorded the outside precondition ${id} as trusted.`)
  }
  if (args === "") return yield* reply("Usage: /task <path to a .spec or .task folder> | /task trust <id>")

  const limits = yield* TaskLimits.load
  // Before the first status write, refusals included. Outside a git repository there is nothing to exclude from.
  yield* TaskWorkspace.ensureExcluded(directory, limits).pipe(Effect.ignore)
  const path = yield* Path.Path
  const target = path.resolve(directory, args)
  const found = specFolder(path, directory, target)
  const refuse = (spec: string, reason: string) =>
    Effect.gen(function* () {
      yield* TaskStatus.write(directory, TaskStatus.refused({ spec, path: args, reason }))
      return yield* reply(`Task harness: refused ${args}: ${reason}`)
    })
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

  const id = TaskEvents.runID(directory, specPath)
  if (TaskRunner.running(id)) return yield* reply(`Task harness: the run of ${specPath} is already going on.`)

  // The leaves branch from the checked-out branch and merge back into it (`TaskWorkspace.readiness`).
  const ready = yield* TaskWorkspace.readiness(directory, limits).pipe(
    Effect.catch((error) => Effect.succeed(Result.fail(`git could not read the checkout: ${error.message}`))),
  )
  if (Result.isFailure(ready)) return yield* refuse(specPath, ready.failure)
  const base = ready.success

  // The services are resolved only once nothing refuses, so a refusal needs no session runtime.
  const env = yield* environment(ops)
  const runPlan = plan({ spec, specPath, path: args, root })
  const startedOn = TaskRunner.unfinishedBase(
    TaskEngineXState.XStateEngine,
    runPlan,
    yield* TaskEvents.read(env.db, id),
  )
  if (Option.isSome(startedOn) && startedOn.value !== base) {
    return yield* refuse(
      specPath,
      `the unfinished run of ${specPath} started on the branch ${startedOn.value}; switch back to it to resume the run`,
    )
  }
  const start: TaskRunner.Start = {
    env,
    engine: TaskEngineXState.XStateEngine,
    directory,
    base,
    specDir,
    plan: runPlan,
    root: input.sessionID,
    model,
    limits,
    job: id,
  }
  yield* env.background.start({
    id,
    type: "task-harness",
    title: `/task ${args}`,
    metadata: { parentSessionId: input.sessionID },
    run: TaskRunner.run(start).pipe(
      Effect.map((state) => `the task run of ${specPath} ended ${state}`),
      Effect.provide(platform),
    ),
  })
  return yield* reply(
    `Task harness: running ${args} in the background. Its status is in .opencode/task/status.json.`,
  )
}, Effect.provide(platform))

export * as TaskCommand from "./command"

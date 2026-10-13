import { Clock, Effect, Option, Path, Schema } from "effect"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import type { Plan } from "@/task/core/model"
import { TaskStatus } from "@/task/core/status"
import { TaskLimits } from "@/task/limits"
import type { Client } from "./driver"
import { HarnessLog } from "./log"
import { HarnessRegistry } from "./registry"
import { HarnessRunner } from "./runner"

// `/task` of O3, run from the plugin's `command.execute.before` hook. The hook can only change the command's parts;
// opencode then prompts the model with them. So:
//
//   /task <path>       validates the spec, then refuses it or starts (or resumes) the run in the background, and
//                      ends with a `Stop`: the hook fails, the command fails before its prompt, no model request
//   /task trust <id>   records the `outside` precondition <id> for the runs in this directory and returns the text
//                      of the command's turn, which then completes normally (one short model turn)

/** `/task` did its work and must not reach the model; the message says what it did. */
export class Stop extends Schema.TaggedError<Stop>()("TaskHarnessStop", { message: Schema.String }) {}

const TASK_FOLDER = /^(T[1-9][0-9]*(?:\.[1-9][0-9]*)*)-[a-z0-9-]+\.task$/
const TRUST = /^trust\s+(\S+)$/

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

/** The text of the command's turn after `/task trust <id>`; every other `/task` ends in a `Stop`. */
export const handle = Effect.fn("HarnessCommand.handle")(function* (input: {
  readonly client: Client
  readonly directory: string
  readonly session: string
  readonly arguments: string
}) {
  const { directory } = input
  const args = input.arguments.trim()
  const trusted = TRUST.exec(args)
  if (trusted) {
    const id = trusted[1]
    const fact = { type: "outside.trusted" as const, at: yield* Clock.currentTimeMillis, id }
    yield* HarnessLog.append(directory, { spec: HarnessLog.DIRECTORY, fact })
    yield* Effect.forEach(HarnessRegistry.runsIn(directory), (run) => run.trust(id), { discard: true })
    return `Task harness o3: recorded the outside precondition ${id} as trusted.`
  }
  if (args === "") return yield* new Stop({ message: "Usage: /task <path to a .spec or .task folder> | /task trust <id>" })

  const path = yield* Path.Path
  const target = path.resolve(directory, args)
  const refuse = (spec: string, reason: string) =>
    Effect.gen(function* () {
      yield* TaskStatus.write(directory, TaskStatus.refused({ harness: "o3", spec, path: args, reason }))
      return yield* new Stop({ message: `Task harness o3: refused ${args}: ${reason}` })
    })
  const found = specFolder(path, directory, target)
  if (Option.isNone(found)) return yield* refuse(args, `R1 ${args}: not inside a \`<slug>.spec\` folder`)
  const specDir = found.value
  const specPath = path.relative(directory, specDir)
  const loaded = yield* Blend.load(specDir)
  const first = loaded.failures[0]
  if (first) return yield* refuse(specPath, `${first.rule} ${first.path}: ${first.message}`)
  if (!loaded.spec) return yield* refuse(specPath, "R1 .: the spec did not load")
  const spec = loaded.spec

  const folder = target === specDir ? Option.none<string>() : Option.some(path.basename(target))
  const root = Option.flatMap(folder, (name) => Option.fromNullishOr(TASK_FOLDER.exec(name)?.[1]))
  if (Option.isSome(folder) && Option.isNone(root)) {
    return yield* refuse(specPath, `R2 ${path.relative(specDir, target)}: not a \`<task id>-<slug>.task\` folder`)
  }
  if (Option.isSome(root) && !spec.tasks.some((task) => task.id === root.value)) {
    return yield* refuse(specPath, `R2 ${path.relative(specDir, target)}: no task ${root.value} in the spec`)
  }

  const start: HarnessRunner.Start = {
    client: input.client,
    directory,
    specDir,
    plan: plan({ spec, specPath, path: args, root }),
    root: input.session,
    limits: yield* TaskLimits.load,
  }
  // Check and claim in one step, with nothing between the claim and the fork that can fail.
  const key = HarnessRegistry.runKey(directory, specPath)
  if (!HarnessRegistry.reserve(key)) {
    return yield* new Stop({ message: `Task harness o3: the run of ${specPath} is already going on.` })
  }
  // The run outlives this command: it ends by itself, by an abort of the root session, or with the process.
  yield* HarnessRunner.run(start).pipe(
    Effect.tap((state) => Effect.logInfo("task harness o3: the run ended", { spec: specPath, state })),
    Effect.catchCause((cause) => Effect.logError("task harness o3: the run failed", { spec: specPath, cause })),
    Effect.ensuring(Effect.sync(() => HarnessRegistry.release(key))),
    Effect.forkDetach,
  )
  return yield* new Stop({
    message: `Task harness o3: running ${args} in the background. Its status is in .opencode/task/status.json.`,
  })
})

export * as HarnessCommand from "./command"

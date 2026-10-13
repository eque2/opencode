import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { type Hooks, type Plugin, type PluginInput, type PluginModule, tool } from "@opencode-ai/plugin"
import {
  Clock,
  Config,
  Duration,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  MutableHashSet,
  Option,
  type Path,
  Predicate,
  Schema,
} from "effect"
import { HarnessCommand } from "./command"
import { HarnessDriver } from "./driver"
import { HarnessMessages } from "./messages"
import { HarnessRegistry } from "./registry"

// Task harness option O3: the whole harness as an opencode plugin, with no change to opencode's core. The server
// config loads it with `plugin: ["file://…/src/task/harness-plugin/index.ts"]`. opencode calls the plugin once per
// instance (directory); every call returns the same hooks over the module's shared state (`./registry`):
//
//   config                   adds the `/task` command and the hidden agents task-builder, task-verifier, task-note
//   tool                     task_ready (builder) and verdict (verifier), recorded by session id
//   command.execute.before   `/task`: refuses, starts or resumes a run, or records `/task trust <id>` (`./command`)
//   tool.execute.before      stops a builder at its 3rd identical call in a row
//   event                    notes stream activity; an abort of a run's root session cancels the run
//
// The plugin stays inert when `OPENCODE_TASK_HARNESS` selects an in-core option (o1, o2).

// The plugin's runtime: the platform services the shared apparatus needs, built once per process.
const runtime = ManagedRuntime.make(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))

/** A hook's effect, run as the Promise the plugin API expects. */
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) => runtime.runPromise(effect)

/** A harness tool refuses the call: the wrong role, or a builder stopped for repetition. */
class Refused extends Schema.TaggedError<Refused>()("TaskHarnessRefused", { message: Schema.String }) {}

const selected = readEnvSnapshot(Config.String("OPENCODE_TASK_HARNESS").pipe(Config.withDefault("")))

// Root sessions with a turn of their own in flight: an idle that ends such a turn is not an abort of the run.
const busy = MutableHashSet.empty<string>()

const agent = (description: string, prompt: string, permission: Record<string, "allow" | "deny">) => ({
  description,
  mode: "primary" as const,
  hidden: true,
  prompt,
  permission,
})

// How long a repetition stop waits for the abort to land before it fails the call anyway.
const STOP_BOUND = Duration.seconds(5)

const hooks = (input: PluginInput): Hooks => ({
  config: (cfg) =>
    run(
      Effect.sync(() => {
        cfg.command = {
          ...cfg.command,
          task: {
            template: "Task harness: $ARGUMENTS",
            description: "Run a blend task tree (task harness o3)",
            agent: HarnessRegistry.NOTE,
          },
        }
        cfg.agent = {
          ...cfg.agent,
          [HarnessRegistry.BUILDER]: agent(
            "Builds one task of a blend task tree for the task harness.",
            HarnessMessages.builderPrompt,
            HarnessMessages.builderPermission,
          ),
          [HarnessRegistry.VERIFIER]: agent(
            "Judges the obligations of a task for the task harness.",
            HarnessMessages.verifierPrompt,
            HarnessMessages.verifierPermission,
          ),
          [HarnessRegistry.NOTE]: agent(
            "Acknowledges a note of the task harness.",
            HarnessMessages.notePrompt,
            HarnessMessages.notePermission,
          ),
        }
      }),
    ),
  tool: {
    task_ready: tool({
      description:
        "Tell the task harness that the task is done. It is a request: the harness then runs the proofs. Call it once, then end your turn.",
      args: { summary: tool.schema.string().optional().describe("One line on what the attempt did.") },
      execute: (args, ctx) =>
        run(
          ctx.agent === HarnessRegistry.BUILDER
            ? Effect.sync(() => {
                HarnessRegistry.recordReady(ctx.sessionID, args)
                return "Recorded. End your turn now: the harness runs the proofs."
              })
            : Effect.fail(new Refused({ message: "task_ready is for the task builder only" })),
        ),
    }),
    verdict: tool({
      description:
        "Record your verdicts for the task harness: one entry for every id you were asked to judge. Call it once, then stop.",
      args: {
        verdicts: tool.schema.array(
          tool.schema.object({
            id: tool.schema.string(),
            verdict: tool.schema.enum(["trusted", "rejected"]),
            reason: tool.schema.string().optional(),
          }),
        ),
      },
      execute: (args, ctx) =>
        run(
          ctx.agent === HarnessRegistry.VERIFIER
            ? Effect.sync(() => {
                HarnessRegistry.recordVerdicts(ctx.sessionID, args.verdicts)
                return `Recorded ${args.verdicts.length} verdict(s). Stop now.`
              })
            : Effect.fail(new Refused({ message: "verdict is for the task verifier only" })),
        ),
    }),
  },
  "command.execute.before": (command, output) =>
    run(
      command.command !== "task"
        ? Effect.void
        : HarnessCommand.handle({
            client: input.client,
            directory: input.directory,
            session: command.sessionID,
            arguments: command.arguments,
          }).pipe(
            // Only `/task trust <id>` returns: its turn says what was recorded.
            Effect.map((text) => {
              for (const part of output.parts) if (part.type === "text") part.text = text
            }),
          ),
    ),
  "tool.execute.before": (call, output) =>
    run(
      Effect.gen(function* () {
        const repeated = HarnessRegistry.noteCall(call.sessionID, call.tool, output.args)
        if (Option.isNone(repeated)) return yield* Effect.void
        // The turn ends here: before this call runs and before the next model request.
        yield* HarnessDriver.abort(input.client, input.directory, call.sessionID).pipe(
          Effect.timeoutOption(STOP_BOUND),
          Effect.ignore,
        )
        return yield* new Refused({ message: `task harness: ${repeated.value}; the turn was ended` })
      }),
    ),
  event: ({ event }) =>
    run(
      Effect.gen(function* () {
        const properties: unknown = event.properties
        if (!Predicate.hasProperty(properties, "sessionID") || !Predicate.isString(properties.sessionID)) return
        const session = properties.sessionID
        const type: string = event.type
        if (type === "message.part.updated" || type === "message.part.delta" || type === "session.status") {
          HarnessRegistry.touch(session, yield* Clock.currentTimeMillis)
        }
        const status =
          type === "session.status" && Predicate.hasProperty(properties, "status") && Predicate.hasProperty(properties.status, "type")
            ? Option.some(properties.status.type)
            : Option.none()
        if (Option.contains(status, "busy")) MutableHashSet.add(busy, session)
        const aborted =
          type === "session.error" &&
          Predicate.hasProperty(properties, "error") &&
          Predicate.hasProperty(properties.error, "name") &&
          properties.error.name === "MessageAbortedError"
        // An abort of a root with no turn of its own sets it idle at once; an abort of its own turn says so.
        const idle = Option.contains(status, "idle") && !MutableHashSet.has(busy, session)
        if (Option.contains(status, "idle")) MutableHashSet.remove(busy, session)
        if (!idle && !aborted) return
        yield* Effect.forEach(HarnessRegistry.runsOf(session), (active) => active.cancel, { discard: true })
      }),
    ),
})

const server: Plugin = (input) =>
  run(Effect.map(selected, (harness): Hooks => (harness === "o1" || harness === "o2" ? {} : hooks(input))))

const plugin: PluginModule = { id: "opencode-task-harness", server }

export default plugin

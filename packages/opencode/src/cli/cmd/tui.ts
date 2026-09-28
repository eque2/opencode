import { Config, Effect, Option, Result, Schema } from "effect"
import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeRuntime } from "@/effect/run-service"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { TuiInput } from "@opencode-ai/tui"
import type { EventSource } from "@opencode-ai/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { ServerAuth } from "@/server/auth"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"

declare global {
  const OPENCODE_WORKER_PATH: string
}

// The worker posts each RPC result as the success value of its method's Effect.
type WorkerRpc = {
  [Method in keyof typeof rpc]: (
    ...input: Parameters<(typeof rpc)[Method]>
  ) => Effect.Success<ReturnType<(typeof rpc)[Method]>>
}

type WorkerEvents = { "global.event": GlobalEvent }

type RpcClient = ReturnType<typeof Rpc.client<WorkerRpc, WorkerEvents>>

type Transport = Pick<TuiInput, "url" | "fetch" | "events" | "headers">

/** The session in --session could not be loaded from the server. The cause is the value validateSession rejected with. */
class SessionValidationError extends Schema.TaggedError<SessionValidationError>()("TuiSessionValidationError", {
  cause: Schema.Defect(),
}) {}

// The TUI thread runs without AppRuntime: the worker owns the server, the database, and the instance.
// The thread needs only the filesystem service.
const { runPromise } = makeRuntime(FSUtil.Service, AppNodeBuilder.build(FSUtil.node))

function createWorkerFetch(client: RpcClient): typeof fetch {
  // The SDK fetch setting is typeof fetch, which includes Bun's preconnect helper.
  return Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      runPromise(() =>
        Effect.gen(function* () {
          const request = new Request(input, init)
          const body = request.body ? { body: yield* Effect.promise(() => request.text()) } : {}
          const result = yield* client.call("fetch", {
            url: request.url,
            method: request.method,
            headers: Object.fromEntries(request.headers.entries()),
            ...body,
          })
          return new Response(result.body, {
            status: result.status,
            headers: result.headers,
          })
        }),
      ),
    { preconnect: fetch.preconnect },
  )
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: (handler) =>
      runPromise(() =>
        Effect.sync(() =>
          client.on("global.event", (e) => {
            handler(e)
          }),
        ),
      ),
  }
}

const target = Effect.fnUntraced(function* () {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const fs = yield* FSUtil.Service
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (yield* fs.existsSafe(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
})

// Empty values count as absent, as the former truthiness checks did.
const input = Effect.fnUntraced(function* (value?: string) {
  const piped = process.stdin.isTTY ? Option.none<string>() : Option.some(yield* Effect.promise(() => Bun.stdin.text()))
  if (!value) return piped
  if (Option.isNone(piped) || piped.value === "") return Option.some(value)
  return Option.some(piped.value + "\n" + value)
})

// PWD is read by the caller, so this stays a synchronous path helper.
export function resolveThreadDirectory(project?: string, envPWD?: string, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

const readPWD = Config.String("PWD").pipe(Config.option, Effect.orDie, Effect.map(Option.getOrUndefined))

const reportError = (message: string) =>
  Effect.sync(() => {
    UI.error(message)
    process.exitCode = 1
  })

// test/cli/tui/thread.test.ts pins these lazy imports.
const loadTui = Effect.gen(function* () {
  const { run } = yield* Effect.promise(() => import("../tui/layer"))
  const { createLegacyTuiPluginHost } = yield* Effect.promise(() => import("@/plugin/tui/runtime"))
  return { run, createLegacyTuiPluginHost }
})

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: (args) =>
    runPromise(() =>
      Effect.gen(function* () {
        if (args.replay === true) {
          yield* reportError("--replay is not supported; replay is enabled by default")
          return
        }
        const noReplay = args.replay === false || args.noReplay === true

        if (args.mini) {
          const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
            process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
          )
          if (network) {
            yield* reportError(`${network} cannot be used with --mini`)
            return
          }

          const { runMini } = yield* Effect.promise(() => import("./run"))
          const directory = resolveThreadDirectory(args.project, yield* readPWD)
          yield* Effect.promise(() =>
            runMini({
              directory,
              continue: args.continue,
              session: args.session,
              fork: args.fork,
              model: args.model,
              agent: args.agent,
              prompt: args.prompt,
              ...(noReplay ? { replay: false } : {}),
              replayLimit: args.replayLimit,
              demo: args.demo,
            }),
          )
          return
        }

        const unsupported = [
          ["--no-replay", noReplay],
          ["--replay-limit", args.replayLimit !== undefined],
          ["--demo", args.demo !== undefined],
        ].find((entry) => entry[1])?.[0]
        if (unsupported) {
          yield* reportError(`${unsupported} requires --mini`)
          return
        }

        const completed = yield* Effect.acquireUseRelease(
          Effect.sync(() => win32InstallCtrlCGuard()),
          () =>
            Effect.gen(function* () {
              const { TuiConfig } = yield* Effect.promise(() => import("@/config/tui"))
              if (args.fork && !args.continue && !args.session) {
                yield* reportError("--fork requires --continue or --session")
                return false
              }

              // Resolve relative --project paths from PWD, then use the real cwd after
              // chdir so the thread and worker share the same directory key.
              const next = resolveThreadDirectory(args.project, yield* readPWD)
              const file = yield* target()
              const changed = yield* Effect.try(() => process.chdir(next)).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
              if (!changed) {
                yield* Effect.sync(() => UI.error("Failed to change directory to " + next))
                return false
              }
              const cwd = Filesystem.resolve(process.cwd())

              const worker = yield* Effect.sync(
                () =>
                  new Worker(file, {
                    env: Object.fromEntries(
                      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
                    ),
                  }),
              )
              const client = Rpc.client<WorkerRpc, WorkerEvents>(worker)
              // A signal handler is an external edge; the reload call cannot fail.
              const reload = () => {
                Effect.runFork(client.call("reload"))
              }
              process.on("SIGUSR2", reload)

              // Rpc calls resolve only; a worker that does not answer the shutdown in 5 seconds is terminated.
              const stop = Effect.gen(function* () {
                yield* Effect.sync(() => process.off("SIGUSR2", reload))
                yield* client.call("shutdown").pipe(
                  Effect.timeout("5 seconds"),
                  Effect.ignore,
                )
                yield* Effect.sync(() => worker.terminate())
              })

              const prompt = yield* input(args.prompt)
              const config = yield* Effect.promise(() => TuiConfig.get())

              const network = resolveNetworkOptionsNoConfig(args)
              const external = hasArg("--port") || hasArg("--hostname") || network.mdns

              const transport: Transport = external
                ? {
                    // The headers are read before the worker starts the server, as before.
                    headers: yield* ServerAuth.headers(),
                    url: (yield* client.call("server", network)).url,
                  }
                : {
                    url: "http://opencode.internal",
                    fetch: createWorkerFetch(client),
                    events: createEventSource(client),
                  }

              const validated = yield* Effect.tryPromise({
                try: () =>
                  validateSession({
                    url: transport.url,
                    sessionID: args.session,
                    directory: cwd,
                    fetch: transport.fetch,
                    headers: transport.headers,
                  }),
                catch: (cause) => new SessionValidationError({ cause }),
              }).pipe(Effect.result)
              if (Result.isFailure(validated)) {
                yield* reportError(errorMessage(validated.failure.cause))
                return false
              }

              yield* Effect.sleep("1 second").pipe(
                Effect.andThen(client.call("checkUpgrade", { directory: cwd })),
                Effect.forkChild,
              )

              const { run, createLegacyTuiPluginHost } = yield* loadTui
              yield* run({
                ...transport,
                onSnapshot: () =>
                  runPromise(() =>
                    Effect.gen(function* () {
                      const tui = writeHeapSnapshot("tui.heapsnapshot")
                      const server = yield* client.call("snapshot")
                      return [tui, server]
                    }),
                  ),
                config,
                pluginHost: createLegacyTuiPluginHost(),
                directory: cwd,
                args: {
                  continue: args.continue,
                  sessionID: args.session,
                  agent: args.agent,
                  model: args.model,
                  prompt: Option.getOrUndefined(prompt),
                  fork: args.fork,
                  auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
                },
              }).pipe(Effect.ensuring(stop))
              return true
            }),
          // A failing Ctrl+C guard release is ignored, as the former empty catch did.
          (unguard) => Effect.try(() => unguard?.()).pipe(Effect.ignore),
        )
        if (completed) yield* Effect.sync((): void => process.exit())
      }),
    ),
})

import { Effect, Option, Result, Schema } from "effect"
import { cmd } from "./cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeRuntime } from "@/effect/run-service"
import { validateSession } from "../tui/validate-session"
import { ServerAuth } from "@/server/auth"

/** The session in --session could not be loaded from the server. The cause is the value validateSession rejected with. */
class SessionValidationError extends Schema.TaggedError<SessionValidationError>()("AttachSessionValidationError", {
  cause: Schema.Defect(),
}) {}

// attach talks to a remote server, so it runs without AppRuntime and opens no local database,
// as the TUI thread does.
const { runPromise } = makeRuntime(FSUtil.Service, AppNodeBuilder.build(FSUtil.node))

const reportError = (message: string) =>
  Effect.sync(() => {
    UI.error(message)
    process.exitCode = 1
  })

// test/cli/tui/attach.test.ts pins these lazy imports in their awaited form.
async function loadTui() {
  const { run } = await import("../tui/layer")
  const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
  return { run, createLegacyTuiPluginHost }
}

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
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
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
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
      }),
  handler: (args) =>
    runPromise(() =>
      Effect.gen(function* () {
        if (args.replay === true) {
          yield* reportError("--replay is not supported; replay is enabled by default")
          return
        }
        const noReplay = args.replay === false || args.noReplay === true

        // If the directory doesn't exist locally (remote attach), pass it through.
        const dir = Option.fromNullishOr(args.dir).pipe(Option.filter((value) => value !== ""))
        const directory = Option.isSome(dir)
          ? Option.some(
              yield* Effect.try(() => {
                process.chdir(dir.value)
                return process.cwd()
              }).pipe(Effect.orElseSucceed(() => dir.value)),
            )
          : Option.none<string>()

        if (args.mini) {
          const { runMini } = yield* Effect.promise(() => import("./run"))
          yield* Effect.promise(() =>
            runMini({
              attach: args.url,
              directory: Option.getOrUndefined(directory),
              password: args.password,
              username: args.username,
              continue: args.continue,
              session: args.session,
              fork: args.fork,
              ...(noReplay ? { replay: false } : {}),
              replayLimit: args.replayLimit,
            }),
          )
          return
        }

        const unsupported = [
          ["--no-replay", noReplay],
          ["--replay-limit", args.replayLimit !== undefined],
        ].find((entry) => entry[1])?.[0]
        if (unsupported) {
          yield* reportError(`${unsupported} requires --mini`)
          return
        }

        const { TuiConfig } = yield* Effect.promise(() => import("@/config/tui"))
        if (args.fork && !args.continue && !args.session) {
          yield* reportError("--fork requires --continue or --session")
          return
        }

        const headers = yield* ServerAuth.headers({ password: args.password, username: args.username })
        const config = yield* Effect.promise(() => TuiConfig.get())

        const validated = yield* Effect.tryPromise({
          try: () =>
            validateSession({
              url: args.url,
              sessionID: args.session,
              directory: Option.getOrUndefined(directory),
              headers,
            }),
          catch: (cause) => new SessionValidationError({ cause }),
        }).pipe(Effect.result)
        if (Result.isFailure(validated)) {
          yield* reportError(errorMessage(validated.failure.cause))
          return
        }

        const { run, createLegacyTuiPluginHost } = yield* Effect.promise(() => loadTui())
        yield* run({
          url: args.url,
          config,
          pluginHost: createLegacyTuiPluginHost(),
          args: {
            continue: args.continue,
            sessionID: args.session,
            fork: args.fork,
          },
          directory: Option.getOrUndefined(directory),
          headers,
        })
      }),
    ),
})

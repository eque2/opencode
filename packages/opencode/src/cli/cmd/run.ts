import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
// CLI entry point for `opencode run` and `opencode --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`opencode --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`opencode --mini --attach`): connects to a running
//      opencode server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { Clock, Config, Console, Effect, Fiber, type FileSystem, MutableHashSet, Option, Schema, Stream } from "effect"
import { UI } from "../ui"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { InteractiveInputError, interactiveStdin } from "./run/runtime.stdin"

type ModelInput = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

// Joins the message and the piped stdin text. An empty piped text counts as absent.
function resolveRunInput(value: string, piped: Option.Option<string>): Option.Option<string> {
  if (!value) {
    return piped
  }

  return Option.some(
    Option.match(
      Option.filter(piped, (text) => text.length > 0),
      {
        onNone: () => value,
        onSome: (text) => value + "\n" + text,
      },
    ),
  )
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

// The share request rejected. A rejection that says sharing is disabled is shown to the user.
class RunShareError extends Schema.TaggedError<RunShareError>()("RunShareError", {
  cause: Schema.Defect(),
}) {}

// The JSON event lines of `--format json`, as JSON.stringify wrote them.
const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

// The inline summary of a tool part, or None when the renderer cannot load or draw it.
function toolInfo(part: ToolPart) {
  return Effect.tryPromise(() => import("./run/tool")).pipe(
    Effect.flatMap((mod) => Effect.try(() => mod.toolInlineInfo(part))),
    Effect.option,
  )
}

function tool(part: ToolPart) {
  return toolInfo(part).pipe(
    Effect.map(
      Option.match({
        onNone: () =>
          inline({
            icon: "⚙",
            title: part.tool,
          }),
        onSome: (next) => (next.mode === "block" ? block(next, next.body) : inline(next)),
      }),
    ),
  )
}

function toolError(part: ToolPart) {
  return toolInfo(part).pipe(
    Effect.map(
      Option.match({
        onNone: () =>
          inline({
            icon: "✗",
            title: `${part.tool} failed`,
          }),
        onSome: (next) =>
          inline({
            icon: "✗",
            title: `${next.title} failed`,
            ...(next.description && { description: next.description }),
          }),
      }),
    ),
  )
}

// The terminal check reports a missing controlling terminal as a user-facing
// failure. Every other defect keeps propagating to the top-level handler.
function interactiveFailure(defect: unknown) {
  return defect instanceof InteractiveInputError ? fail(defect.message) : Effect.die(defect)
}

// Reads a whole regular file through one handle, so the size and type checks
// apply to the bytes that are read.
function readAll(file: FileSystem.File, buffer: Buffer, offset: number): Effect.Effect<number> {
  if (offset >= buffer.length) {
    return Effect.succeed(offset)
  }

  return file.read(buffer.subarray(offset)).pipe(
    Effect.orDie,
    Effect.flatMap((read) => (read === 0 ? Effect.succeed(offset) : readAll(file, buffer, offset + read))),
  )
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
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
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
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
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    const fsys = yield* FSUtil.Service
    const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
    const interactive = args.mini
    const auto = args.auto || args.yolo || args["dangerously-skip-permissions"]
    const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)

    const quoted = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    if (interactive && args.command) {
      return yield* fail("--mini cannot be used with --command")
    }

    if (interactive && args._?.[0] !== "mini") {
      return yield* fail("--mini must be used without the run subcommand")
    }

    if (args.demo && !interactive) {
      return yield* fail("--demo requires --mini")
    }

    if (interactive && args.format === "json") {
      return yield* fail("--mini cannot be used with --format json")
    }

    if (args["replay-limit"] !== undefined && !interactive) {
      return yield* fail("--replay-limit requires --mini")
    }

    if (args["replay-limit"] !== undefined && (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)) {
      return yield* fail("--replay-limit must be a positive integer")
    }

    if (interactive && !process.stdout.isTTY) {
      return yield* fail("--mini requires a TTY stdout")
    }

    if (interactive) {
      yield* Effect.fromResult(interactiveStdin()).pipe(
        Effect.map((stdin) => stdin.cleanup?.()),
        Effect.catchTag("InteractiveInputError", (error) => fail(error.message)),
      )
    }

    const replay = args.replay

    // An unreadable PWD counts as not set, as a missing one does.
    const pwd = yield* Config.option(Config.String("PWD")).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    const root = Filesystem.resolve(Option.getOrElse(pwd, () => process.cwd()))
    const target = args.dir
    const directory = yield* Effect.suspend(() => {
      if (!target) return Effect.succeed(args.attach ? Option.none<string>() : Option.some(root))
      if (args.attach) return Effect.succeed(Option.some(target))

      return Effect.try({
        try: () => {
          process.chdir(path.isAbsolute(target) ? target : path.join(root, target))
          return Option.some(process.cwd())
        },
        catch: () => new CliError({ message: "Failed to change directory to " + target, exitCode: 1 }),
      })
    })
    const localDirectory = Option.getOrElse(directory, () => root)
    const attachHeaders = args.attach
      ? Option.fromNullishOr(yield* ServerAuth.headers({ password: args.password, username: args.username }))
      : Option.none<{ Authorization: string }>()
    const attachSDK = (baseUrl: string, dir: Option.Option<string>) =>
      createOpencodeClient({
        baseUrl,
        ...(Option.isSome(dir) ? { directory: dir.value } : {}),
        ...(Option.isSome(attachHeaders) ? { headers: attachHeaders.value } : {}),
      })

    const attachFile = Effect.fn("Cli.run.attachFile")(function* (filePath: string) {
      const resolvedPath = path.resolve(args.attach ? root : localDirectory, filePath)
      if (!(yield* fsys.existsSafe(resolvedPath))) {
        return yield* fail(`File not found: ${filePath}`)
      }

      const info = yield* fsys.stat(resolvedPath).pipe(Effect.option)
      const isDirectory = Option.exists(info, (item) => item.type === "Directory")
      if (args.attach && isDirectory) {
        return yield* fail(`Cannot attach local directory without a shared filesystem: ${filePath}`)
      }

      const content = args.attach
        ? Option.some(
            yield* Effect.scoped(
              Effect.gen(function* () {
                const file = yield* fsys.open(resolvedPath, { flag: "r" }).pipe(Effect.orDie)
                const opened = yield* file.stat.pipe(Effect.orDie)
                const size = Number(opened.size)
                if (opened.type !== "File" || size > ATTACH_FILE_MAX_BYTES) {
                  return yield* fail(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                }
                if (size === 0) return Buffer.alloc(0)
                const buffer = Buffer.alloc(size)
                return buffer.subarray(0, yield* readAll(file, buffer, 0))
              }),
            ),
          )
        : Option.none<Buffer>()
      const detected = FSUtil.mimeType(resolvedPath)
      const mime = !args.attach
        ? isDirectory
          ? "application/x-directory"
          : "text/plain"
        : Option.exists(content, (bytes) => Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
          ? "text/plain"
          : detected

      const part: FilePart = {
        type: "file",
        url: Option.match(content, {
          onNone: () => pathToFileURL(resolvedPath).href,
          onSome: (bytes) => `data:${mime};base64,${bytes.toString("base64")}`,
        }),
        filename: path.basename(resolvedPath),
        mime,
      }
      return part
    })

    const files = args.file ? yield* Effect.forEach(Array.isArray(args.file) ? args.file : [args.file], attachFile) : []

    const piped = process.stdin.isTTY
      ? Option.none<string>()
      : Option.some(yield* Effect.promise(() => Bun.stdin.text()))
    const message = Option.getOrElse(resolveRunInput(quoted, piped), () => "")
    const initialInput = resolveRunInput(rawMessage, piped)

    if (message.trim().length === 0 && !args.command && !interactive) {
      return yield* fail("You must provide a message or a command")
    }

    if (args.fork && !args.continue && !args.session) {
      return yield* fail("--fork requires --continue or --session")
    }

    const rules: PermissionV1.Ruleset = interactive
      ? []
      : [
          {
            permission: "question",
            action: "deny",
            pattern: "*",
          },
          {
            permission: "plan_enter",
            action: "deny",
            pattern: "*",
          },
          {
            permission: "plan_exit",
            action: "deny",
            pattern: "*",
          },
        ]

    function title() {
      if (args.title === undefined) return Option.none<string>()
      if (args.title !== "") return Option.some(args.title)
      return Option.some(message.slice(0, 50) + (message.length > 50 ? "..." : ""))
    }

    // The fork of a session, or None when the server returned no fork id.
    function forkedInfo(
      forked: { id: string; title: string; directory: string } | undefined,
      base: { title: string; directory: string },
    ) {
      return Option.fromNullishOr(forked).pipe(
        Option.filter((item) => !!item.id),
        Option.map(
          (item): SessionInfo => ({
            id: item.id,
            title: item.title ?? base.title,
            directory: item.directory ?? base.directory,
          }),
        ),
      )
    }

    const session = Effect.fn("Cli.run.session")(function* (sdk: OpencodeClient) {
      const sessionID = args.session
      if (sessionID) {
        const current = yield* Effect.tryPromise(() => sdk.session.get({ sessionID })).pipe(
          Effect.map((result) => Option.fromNullishOr(result.data)),
          Effect.orElseSucceed(() => Option.none()),
        )
        if (Option.isNone(current)) {
          return yield* fail("Session not found")
        }

        if (args.fork) {
          const forked = yield* Effect.promise(() => sdk.session.fork({ sessionID }))
          return forkedInfo(forked.data, current.value)
        }

        return Option.some<SessionInfo>({
          id: current.value.id,
          title: current.value.title,
          directory: current.value.directory,
        })
      }

      const base = args.continue
        ? Option.fromNullishOr((yield* Effect.promise(() => sdk.session.list())).data?.find((item) => !item.parentID))
        : Option.none()

      if (Option.isSome(base) && args.fork) {
        const forked = yield* Effect.promise(() => sdk.session.fork({ sessionID: base.value.id }))
        return forkedInfo(forked.data, base.value)
      }

      if (Option.isSome(base)) {
        return Option.some<SessionInfo>({
          id: base.value.id,
          title: base.value.title,
          directory: base.value.directory,
        })
      }

      const name = title()
      const result = yield* Effect.promise(() =>
        sdk.session.create({
          ...(Option.isSome(name) ? { title: name.value } : {}),
          permission: [...rules],
        }),
      )
      return Option.fromNullishOr(result.data).pipe(
        Option.filter((item) => !!item.id),
        Option.map(
          (item): SessionInfo => ({
            id: item.id,
            title: item.title ?? Option.getOrUndefined(name),
            directory: item.directory,
          }),
        ),
      )
    })

    const share = Effect.fn("Cli.run.share")(function* (sdk: OpencodeClient, sessionID: string) {
      const cfg = yield* Effect.promise(() => sdk.config.get())
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !flags.autoShare && !args.share) return
      const url = yield* Effect.tryPromise({
        try: () => sdk.session.share({ sessionID }),
        catch: (cause) => new RunShareError({ cause }),
      }).pipe(
        Effect.map((res) => (res.error ? Option.none<string>() : Option.fromNullishOr(res.data?.share?.url))),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (error.cause instanceof Error && error.cause.message.includes("disabled")) {
              UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.cause.message)
            }
            return Option.none<string>()
          }),
        ),
      )
      if (Option.isSome(url) && url.value) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + url.value)
      }
    })

    const createFreshSession = Effect.fn("Cli.run.createFreshSession")(function* (
      sdk: OpencodeClient,
      input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
    ) {
      const { RunSessionError } = yield* Effect.promise(() => import("./run/runtime"))
      const result = yield* Effect.promise(() =>
        sdk.session.create({
          ...(args.title ? { title: args.title } : {}),
          agent: input.agent,
          ...(input.model
            ? {
                model: {
                  providerID: input.model.providerID,
                  id: input.model.modelID,
                  variant: input.variant,
                },
              }
            : {}),
          permission: [...rules],
        }),
      )
      const id = result.data?.id
      if (!id) {
        return yield* new RunSessionError({ message: "Failed to create session" })
      }

      yield* Effect.forkDetach(share(sdk, id).pipe(Effect.ignoreCause), { startImmediately: true })
      return {
        id,
        title: result.data?.title,
      }
    })

    const current = Effect.fn("Cli.run.current")(function* (sdk: OpencodeClient) {
      if (!args.attach) {
        return localDirectory
      }

      const next = yield* Effect.tryPromise(() => sdk.path.get()).pipe(
        Effect.map((result) => Option.fromNullishOr(result.data?.directory).pipe(Option.filter((dir) => !!dir))),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
      if (Option.isSome(next)) {
        return next.value
      }

      return yield* fail("Failed to resolve remote directory")
    })

    const warnAgent = (text: string) => UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL, text)

    const localAgent = Effect.fn("Cli.run.localAgent")(function* () {
      if (!args.agent) return Option.none<string>()
      const name = args.agent

      const entry = yield* agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance))
      if (!entry) {
        warnAgent(`agent "${name}" not found. Falling back to default agent`)
        return Option.none<string>()
      }
      if (entry.mode === "subagent") {
        warnAgent(`agent "${name}" is a subagent, not a primary agent. Falling back to default agent`)
        return Option.none<string>()
      }
      return Option.some(name)
    })

    const attachAgent = Effect.fn("Cli.run.attachAgent")(function* (sdk: OpencodeClient) {
      if (!args.agent) return Option.none<string>()
      const name = args.agent

      const modes = yield* Effect.tryPromise(() => sdk.app.agents({}, { throwOnError: true })).pipe(
        Effect.map((result) => Option.some(result.data ?? [])),
        Effect.orElseSucceed(() => Option.none()),
      )

      if (Option.isNone(modes)) {
        warnAgent(`failed to list agents from ${args.attach}. Falling back to default agent`)
        return Option.none<string>()
      }

      const agent = modes.value.find((item) => item.name === name)
      if (!agent) {
        warnAgent(`agent "${name}" not found. Falling back to default agent`)
        return Option.none<string>()
      }

      if (agent.mode === "subagent") {
        warnAgent(`agent "${name}" is a subagent, not a primary agent. Falling back to default agent`)
        return Option.none<string>()
      }

      return Option.some(name)
    })

    const pickAgent = (sdk: OpencodeClient) => {
      if (!args.agent) return Effect.succeed(Option.none<string>())
      return args.attach ? attachAgent(sdk) : localAgent()
    }

    const execute = Effect.fn("Cli.run.execute")(function* (sdk: OpencodeClient) {
      const sess = yield* session(sdk)
      if (Option.isNone(sess)) {
        return yield* fail("Session not found")
      }
      const sessionID = sess.value.id

      const emit = (type: string, data: Record<string, unknown>) => {
        if (args.format !== "json") return Effect.succeed(false)
        return Effect.gen(function* () {
          const timestamp = yield* Clock.currentTimeMillis
          const line = yield* encodeEvent({ type, timestamp, sessionID, ...data }).pipe(Effect.orDie)
          yield* Effect.sync(() => process.stdout.write(line + EOL))
          return true
        })
      }

      // Consume one subscribed event stream for the active session and mirror it
      // to stdout/UI. `client` is passed explicitly because attach mode may
      // rebind the SDK to the session's directory after the subscription is
      // created, and replies issued from inside the loop must use that client.
      const loop = (client: OpencodeClient, events: Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>) =>
        Effect.gen(function* () {
          const toggles = MutableHashSet.empty<string>()
          const sessions = MutableHashSet.make(sessionID)
          let error = ""

          // Each event returns true to keep reading and false to stop at idle.
          yield* Stream.fromAsyncIterable(events.stream, (error) => error).pipe(
            Stream.runForEachWhile((event) =>
              Effect.gen(function* () {
                if (event.type === "session.created" && event.properties.info.parentID) {
                  if (MutableHashSet.has(sessions, event.properties.info.parentID)) {
                    MutableHashSet.add(sessions, event.properties.info.id)
                  }
                }

                if (
                  event.type === "message.updated" &&
                  event.properties.sessionID === sessionID &&
                  event.properties.info.role === "assistant" &&
                  args.format !== "json" &&
                  !MutableHashSet.has(toggles, "start")
                ) {
                  UI.empty()
                  UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
                  UI.empty()
                  MutableHashSet.add(toggles, "start")
                }

                if (event.type === "message.part.updated") {
                  const part = event.properties.part
                  if (part.sessionID !== sessionID) return true

                  if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                    if (yield* emit("tool_use", { part })) return true
                    if (part.state.status === "completed") {
                      yield* tool(part)
                      return true
                    }
                    yield* toolError(part)
                    UI.error(part.state.error)
                  }

                  if (
                    part.type === "tool" &&
                    part.tool === "task" &&
                    part.state.status === "running" &&
                    args.format !== "json"
                  ) {
                    if (MutableHashSet.has(toggles, part.id)) return true
                    yield* tool(part)
                    MutableHashSet.add(toggles, part.id)
                  }

                  if (part.type === "step-start") {
                    if (yield* emit("step_start", { part })) return true
                  }

                  if (part.type === "step-finish") {
                    if (yield* emit("step_finish", { part })) return true
                  }

                  if (part.type === "text" && part.time?.end) {
                    if (yield* emit("text", { part })) return true
                    const text = part.text.trim()
                    if (!text) return true
                    if (!process.stdout.isTTY) {
                      process.stdout.write(text + EOL)
                      return true
                    }
                    UI.empty()
                    UI.println(text)
                    UI.empty()
                  }

                  if (part.type === "reasoning" && part.time?.end && thinking) {
                    if (yield* emit("reasoning", { part })) return true
                    const text = part.text.trim()
                    if (!text) return true
                    const line = `Thinking: ${text}`
                    if (process.stdout.isTTY) {
                      UI.empty()
                      UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                      UI.empty()
                      return true
                    }
                    process.stdout.write(line + EOL)
                  }
                }

                if (event.type === "session.error") {
                  const props = event.properties
                  if (props.sessionID !== sessionID || !props.error) return true
                  const data = props.error.data
                  const err =
                    data && typeof data === "object" && "message" in data ? String(data.message) : props.error.name
                  error = error ? error + EOL + err : err
                  if (yield* emit("error", { error: props.error })) return true
                  UI.error(err)
                }

                if (
                  event.type === "session.status" &&
                  event.properties.sessionID === sessionID &&
                  event.properties.status.type === "idle"
                ) {
                  return false
                }

                if (event.type === "permission.asked") {
                  const permission = event.properties
                  if (!MutableHashSet.has(sessions, permission.sessionID)) return true

                  if (!auto) {
                    UI.println(
                      UI.Style.TEXT_WARNING_BOLD + "!",
                      UI.Style.TEXT_NORMAL +
                        `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                    )
                  }
                  yield* Effect.promise(() =>
                    client.permission.reply({
                      requestID: permission.id,
                      reply: auto ? "once" : "reject",
                    }),
                  )
                }

                return true
              }),
            ),
          )
          return error
        })

      const cwd = args.attach
        ? Option.isSome(directory)
          ? directory.value
          : (sess.value.directory ?? (yield* current(sdk)))
        : localDirectory
      const client = args.attach ? attachSDK(args.attach, Option.some(cwd)) : sdk

      // Validate agent if specified
      const agent = Option.getOrUndefined(yield* pickAgent(client))

      yield* share(client, sessionID)

      if (!interactive) {
        const events = yield* Effect.promise(() => client.event.subscribe())
        const report = (error: unknown) =>
          Console.error(error).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1
              }),
            ),
            Effect.as(""),
          )
        const completed = yield* Effect.forkChild(
          loop(client, events).pipe(Effect.catch(report), Effect.catchDefect(report)),
          { startImmediately: true },
        )
        const finish = Effect.gen(function* () {
          if (args.attach) return
          const error = yield* Fiber.join(completed)
          if (error) process.exitCode = 1
        })

        // A failed request reports its error. A sent one waits for the session to go idle.
        const settle = (error: unknown) =>
          error
            ? Effect.gen(function* () {
                if (!(yield* emit("error", { error }))) UI.error(formatRunError(error))
                process.exitCode = 1
              })
            : finish

        const command = args.command
        const model = pick(args.model)
        const result = yield* Effect.promise(() =>
          command
            ? client.session.command({
                sessionID,
                agent,
                model: args.model,
                command,
                arguments: message,
                variant: args.variant,
              })
            : client.session.prompt({
                sessionID,
                agent,
                model,
                variant: args.variant,
                parts: [...files, { type: "text", text: message }],
              }),
        )
        return yield* settle(result.error)
      }

      const model = pick(args.model)
      const { runInteractiveMode } = yield* Effect.promise(() => import("./run/runtime"))
      return yield* runInteractiveMode({
        sdk: client,
        directory: cwd,
        sessionID,
        sessionTitle: sess.value.title,
        resume: Boolean(args.session || args.continue) && !args.fork,
        replay,
        replayLimit: args["replay-limit"],
        agent,
        model,
        variant: args.variant,
        files,
        initialInput: Option.getOrUndefined(initialInput),
        createSession: createFreshSession,
        thinking,
        backgroundSubagents: flags.experimentalBackgroundSubagents,
        demo: args.demo,
      }).pipe(Effect.orDie, Effect.catchDefect(interactiveFailure))
    })

    // The SDK calls the in-process server through this fetch. The SDK fetch
    // setting is typeof fetch, which includes Bun's preconnect helper.
    const localFetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const { Server } = yield* Effect.promise(() => import("@/server/server"))
            const request = new Request(input, init)
            const headers = new Headers(request.headers)
            const auth = yield* ServerAuth.header()
            if (auth) headers.set("Authorization", auth)
            const response = Server.Default().app.fetch(new Request(request, { headers }))
            return response instanceof Response ? response : yield* Effect.promise(() => response)
          }),
        ),
      { preconnect: fetch.preconnect },
    )

    if (interactive && !args.attach && !args.session && !args.continue) {
      const model = pick(args.model)
      const { runInteractiveLocalMode } = yield* Effect.promise(() => import("./run/runtime"))
      return yield* runInteractiveLocalMode({
        directory: localDirectory,
        fetch: localFetch,
        resolveAgent: localAgent(),
        // Local mode starts without --session and --continue, so the session is always new.
        session: (sdk: OpencodeClient) => session(sdk).pipe(Effect.orDie),
        share,
        createSession: createFreshSession,
        agent: args.agent,
        model,
        variant: args.variant,
        replay,
        replayLimit: args["replay-limit"],
        files,
        initialInput: Option.getOrUndefined(initialInput),
        thinking,
        backgroundSubagents: flags.experimentalBackgroundSubagents,
        demo: args.demo,
      }).pipe(Effect.orDie, Effect.catchDefect(interactiveFailure))
    }

    if (args.attach) {
      return yield* execute(attachSDK(args.attach, directory))
    }

    const sdk = createOpencodeClient({
      baseUrl: "http://opencode.internal",
      fetch: localFetch,
      ...(Option.isSome(directory) ? { directory: directory.value } : {}),
    })
    return yield* execute(sdk)
  }),
})

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

// tui.ts and attach.ts await this entry for `--mini`. It runs the same yargs
// handler as `opencode run --mini`, so the instance load and disposal stay in
// effectCmd.
export function runMini(input: MiniCommandInput): Promise<void> {
  const run = RunCommand.handler({
    $0: "opencode",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    share: undefined,
    model: input.model,
    agent: input.agent,
    format: "default",
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    file: undefined,
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    port: undefined,
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    variant: undefined,
    // eslint-disable-next-line effect/no-undefined-use-option -- (a) yargs types each declared option as a required key, and an unset option is the JS undefined value
    thinking: undefined,
    mini: true,
    interactive: false,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    replayLimit: input.replayLimit,
    auto: false,
    yolo: false,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    demo: input.demo ?? false,
  })
  // effectCmd handlers are async; the yargs type also allows a synchronous result.
  return run instanceof Promise ? run : Effect.runPromise(Effect.void)
}

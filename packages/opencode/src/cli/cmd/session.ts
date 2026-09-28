import type { Argv } from "yargs"
import { Console, Effect, Option, Schema } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChildProcess } from "effect/unstable/process"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

const pagerCmd = Effect.fnUntraced(function* () {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
  const lessOnPath = yield* which("less")
  if (Option.isSome(lessOnPath)) {
    if (Filesystem.stat(lessOnPath.value)?.size) return [lessOnPath.value, ...lessOptions]
  }

  const gitBashPath = yield* FlagConfig.OPENCODE_GIT_BASH_PATH
  if (Option.isSome(gitBashPath)) {
    const less = path.join(gitBashPath.value, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = yield* which("git")
  if (Option.isSome(git)) {
    const less = path.join(git.value, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}, Effect.orDie)

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) => yargs.command(SessionListCommand).command(SessionDeleteCommand).demandCommand(),
  handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchTag("NotFoundError", () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: args.maxCount }))

    if (sessions.length === 0) return

    const output = args.format === "json" ? yield* formatSessionJSON(sessions) : formatSessionTable(sessions)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      const pager = yield* pagerCmd()
      // The pager reads the terminal, so it stays in this process group. AppRuntime does not provide
      // AppProcess, so the call provides its own. A pager that cannot start stays a defect.
      yield* AppProcess.Service.use((appProcess) =>
        appProcess.run(
          ChildProcess.make(pager[0], pager.slice(1), { stdout: "inherit", stderr: "inherit", detached: false }),
          { stdin: output },
        ),
      ).pipe(Effect.orDie, Effect.provide(LayerNode.compile(AppProcess.node)))
    } else {
      yield* Console.log(output)
    }
  }),
})

function formatSessionTable(sessions: Session.Info[]): string {
  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  const rows = sessions.map((session) => {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    return `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
  })

  return [header, "─".repeat(header.length), ...rows].join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]) {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return encodeJson(jsonData).pipe(Effect.orDie)
}

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { Heap } from "./cli/heap"
import { Cause, Effect, Option } from "effect"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("opencode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware((opts) => {
    // The log, plugin and child-process layers read these flags from process.env.
    if (opts.printLogs) {
      // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; the runtime reads OPENCODE_PRINT_LOGS from process.env, and Effect Config cannot write env
      process.env.OPENCODE_PRINT_LOGS = "1"
    }
    if (opts.logLevel) {
      // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; the runtime reads OPENCODE_LOG_LEVEL from process.env, and Effect Config cannot write env
      process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    }
    if (opts.pure) {
      // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; the runtime reads OPENCODE_PURE from process.env, and Effect Config cannot write env
      process.env.OPENCODE_PURE = "1"
    }

    // The heap monitor is a detached fiber; the entry point ends it with process.exit().
    Effect.runFork(Heap.start())

    // Plugins, shells and child agents detect an opencode host from these variables.
    // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; child processes read AGENT from the inherited process.env, and Effect Config cannot write env
    process.env.AGENT = "1"
    // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; child processes read OPENCODE from the inherited process.env, and Effect Config cannot write env
    process.env.OPENCODE = "1"
    // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; child processes read OPENCODE_PID from the inherited process.env, and Effect Config cannot write env
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    const usageError =
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    if (!err && usageError) cli.showHelp(show)
    if (!err) process.exit(1)
    // eslint-disable-next-line effect/no-throw-use-effect -- (a) external boundary: a yargs fail() handler must throw to hand the error back to the parse() caller
    throw err
  })
  .strict()

// The parse callback reports a help-path error instead of throwing it; parseHelp fails with it after parsing.
function parseHelp() {
  let failure = Option.none<Error>()
  return Effect.promise(() =>
    cli.parseAsync(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) {
        failure = Option.some(err)
        return
      }
      if (!out) return
      show(out)
    }),
  ).pipe(Effect.flatMap(() => Option.match(failure, { onNone: () => Effect.void, onSome: Effect.die })))
}

function report(e: unknown) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
}

const help = args.includes("-h") || args.includes("--help")

Effect.runFork(
  (help ? parseHelp() : Effect.promise(() => cli.parseAsync())).pipe(
    Effect.catchCause((cause) => Effect.sync(() => report(Cause.squash(cause)))),
    // Some subprocesses don't react properly to SIGTERM and similar signals.
    // Most notably, some docker-container-based MCP servers don't handle such signals unless
    // run using `docker run --init`.
    // Explicitly exit to avoid any hanging subprocesses.
    Effect.ensuring(
      Effect.sync((): void => {
        process.exit()
      }),
    ),
  ),
)

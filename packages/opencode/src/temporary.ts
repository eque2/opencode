import yargs from "yargs"
import { Effect } from "effect"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { hideBin } from "yargs/helpers"
const cli = yargs(hideBin(process.argv))
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
    // The log layer reads these flags from process.env.
    if (opts.printLogs) {
      // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; the runtime reads OPENCODE_PRINT_LOGS from process.env, and Effect Config cannot write env
      process.env.OPENCODE_PRINT_LOGS = "1"
    }
    if (opts.logLevel) {
      // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: env write, not a read; the runtime reads OPENCODE_LOG_LEVEL from process.env, and Effect Config cannot write env
      process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    }
  })
  .command(TuiThreadCommand)

// The dev entry point runs the CLI once; yargs returns a Promise for the async command handlers.
Effect.runFork(Effect.promise(() => cli.parseAsync()))

import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Cause, Effect, Exit } from "effect"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { effectCmd } from "../effect-cmd"

const methods = ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"] as const

export const UpgradeCommand = effectCmd({
  command: "upgrade [target]",
  describe: "upgrade opencode to the latest or a specific version",
  builder: (yargs) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: methods,
      })
  },
  // Upgrading replaces the binary; it does not read project state.
  instance: false,
  handler: Effect.fn("Cli.upgrade")(function* (args) {
    const installation = yield* Installation.Service
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const detectedMethod = yield* installation.method()
    const method = methods.find((item) => item === args.method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`opencode is installed to ${process.execPath} and may be managed by a package manager`)
      const install = yield* Effect.promise(() =>
        prompts.select({
          message: "Install anyways?",
          options: [
            { label: "Yes", value: true },
            { label: "No", value: false },
          ],
          initialValue: false,
        }),
      )
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : yield* installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(`opencode upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const exit = yield* installation.upgrade(method, target).pipe(Effect.exit)
    if (Exit.isFailure(exit)) {
      spinner.stop("Upgrade failed", 1)
      const err = Cause.squash(exit.cause)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  }),
})

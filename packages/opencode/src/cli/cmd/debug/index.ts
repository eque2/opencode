import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import os from "os"
import { Array as Arr, Config, Console, Duration, Effect, Option } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { ConfigCommand } from "./config"
import { FileCommand } from "./file"
import { LSPCommand } from "./lsp"
import { RipgrepCommand } from "./ripgrep"
import { ScrapCommand } from "./scrap"
import { SkillCommand } from "./skill"
import { SnapshotCommand } from "./snapshot"
import { AgentCommand } from "./agent"
import { StartupCommand } from "./startup"
import { V2Command } from "./v2"

export const DebugCommand = cmd({
  command: "debug",
  describe: "debugging and troubleshooting tools",
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(LSPCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(StartupCommand)
      .command(AgentCommand)
      .command(V2Command)
      .command(InfoCommand)
      .command(PathsCommand)
      .command(WaitCommand)
      .demandCommand(),
  handler() {},
})

const WaitCommand = effectCmd({
  command: "wait",
  describe: "wait indefinitely (for debugging)",
  handler: Effect.fn("Cli.debug.wait")(function* () {
    yield* Effect.sleep(Duration.days(1))
  }),
})

// An empty variable counts as unset, as the old truthiness checks did.
const envVar = (name: string) =>
  Config.option(Config.String(name)).pipe(Effect.map(Option.filter((value) => value.length > 0)), Effect.orDie)

const InfoCommand = effectCmd({
  command: "info",
  describe: "show debug information",
  handler: Effect.fn("Cli.debug.info")(function* () {
    const configModule = yield* Effect.promise(() => import("@/config/config"))
    const { ConfigPlugin } = yield* Effect.promise(() => import("@/config/plugin"))
    const config = yield* configModule.Config.Service.use((cfg) => cfg.get())
    const flags = yield* RuntimeFlags.Service
    const program = yield* envVar("TERM_PROGRAM")
    const programVersion = yield* envVar("TERM_PROGRAM_VERSION")
    const termProgram = Option.map(program, (name) =>
      Option.match(programVersion, { onNone: () => name, onSome: (version) => `${name} ${version}` }),
    )
    const terminal = Arr.getSomes([termProgram, yield* envVar("TERM")]).join(" / ")

    yield* Console.log(`opencode version: ${InstallationVersion}`)
    yield* Console.log(`os: ${os.type()} ${os.release()} ${os.arch()}`)
    yield* Console.log(`terminal: ${terminal || "unknown"}`)
    yield* Console.log("plugins:")
    if (flags.pure) {
      yield* Console.log("external plugins disabled (--pure)")
      return
    }
    if (!config.plugin_origins?.length) {
      yield* Console.log("none")
      return
    }
    for (const plugin of config.plugin_origins) {
      yield* Console.log(`- ${ConfigPlugin.pluginSpecifier(plugin.spec)}`)
    }
  }),
})

const PathsCommand = effectCmd({
  command: "paths",
  describe: "show global paths (data, config, cache, state)",
  // Prints static global paths; no project InstanceContext is needed.
  instance: false,
  handler: Effect.fn("Cli.debug.paths")(function* () {
    for (const [key, value] of Object.entries(Global.Path)) {
      yield* Console.log(key.padEnd(10), value)
    }
  }),
})

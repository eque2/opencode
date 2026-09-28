import { release } from "node:os"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Config, Effect, Option } from "effect"

export function describeOS() {
  const name =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform === "linux"
          ? "Linux"
          : process.platform
  return `${name} ${release()} (${process.arch})`
}

// An empty variable counts as not set, as the former truthiness checks did.
const setVariable = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value: string) => value.length > 0)))

const TerminalEnv = Config.all({
  program: setVariable("TERM_PROGRAM"),
  term: setVariable("TERM"),
  version: setVariable("TERM_PROGRAM_VERSION"),
  tmux: setVariable("TMUX"),
  screen: setVariable("STY"),
})

/** Describes the terminal from the current environment, for example "iTerm.app 3.5.0 in tmux". */
export const describeTerminal = readEnvSnapshot(TerminalEnv).pipe(
  Effect.map((env) => {
    const program = env.program.pipe(
      Option.orElse(() => env.term),
      Option.getOrElse(() => "unknown"),
    )
    const version = Option.match(env.version, { onNone: () => "", onSome: (value) => ` ${value}` })
    const multiplexer = Option.isSome(env.tmux) ? " in tmux" : Option.isSome(env.screen) ? " in screen" : ""
    return `${program}${version}${multiplexer}`
  }),
)

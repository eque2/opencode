import whichPkg from "which"
import path from "path"
import { Config, ConfigProvider, Effect, Option } from "effect"
import { Global } from "../global"

// Windows keeps the original casing of the Path and PathExt names.
const searchPath = Config.option(Config.String("PATH").pipe(Config.orElse(() => Config.String("Path"))))
const pathExtensions = Config.option(Config.String("PATHEXT").pipe(Config.orElse(() => Config.String("PathExt"))))

// An empty variable counts as set, so an empty PATH searches only the opencode bin folder.
const keepEmpty = { preserveEmptyStrings: true }

// The given record wins; the process environment supplies what the record does not set.
// Callers and tests change PATH at run time, so each call parses a fresh environment
// provider instead of the ambient one, which copies the environment once.
const lookup = Effect.fnUntraced(function* (config: Config.Config<Option.Option<string>>, env?: NodeJS.ProcessEnv) {
  if (env) {
    const given = yield* config.parse(ConfigProvider.fromEnvRecord(env, keepEmpty))
    if (Option.isSome(given)) return given
  }
  return yield* config.parse(ConfigProvider.fromEnv(keepEmpty))
}, Effect.orDie)

/**
 * Finds the executable for a command on PATH, with the opencode bin folder searched
 * last. The result is None when no executable matches.
 */
export const which = Effect.fn("which")(function* (cmd: string, env?: NodeJS.ProcessEnv) {
  const base = Option.getOrElse(yield* lookup(searchPath, env), () => "")
  const full = base ? base + path.delimiter + Global.Path.bin : Global.Path.bin
  const pathExt = Option.getOrUndefined(yield* lookup(pathExtensions, env))
  return Option.fromNullishOr(whichPkg.sync(cmd, { nothrow: true, path: full, pathExt }))
})

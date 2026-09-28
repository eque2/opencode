import { execFile } from "node:child_process"
import { dirname, extname, join } from "node:path"
import util from "node:util"
import { NodeFileSystem } from "@effect/platform-node"
import { Array as Arr, Config, Data, Effect, FileSystem, Option } from "effect"

const execFilePromise = util.promisify(execFile)

class AppLookupError extends Data.TaggedError("AppLookupError")<{ readonly cause: unknown }> {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new AppLookupError({ cause }) })

const exists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
  })

// Returns the first candidate path that exists, checking in order and stopping at the first hit.
const firstExisting = (paths: ReadonlyArray<string>) => Effect.findFirst(paths, (path) => exists(path))

export function checkAppExists(appName: string) {
  if (process.platform === "win32") return true
  if (process.platform === "linux") return true
  return Effect.runPromise(checkMacosApp(appName).pipe(Effect.provide(NodeFileSystem.layer)))
}

// Answers synchronously off Windows. On Windows the Promise resolves to null when no path is found,
// which is the IPC reply type in preload/types.ts.
export function resolveAppPath(appName: string) {
  if (process.platform !== "win32") return appName
  return Effect.runPromise(
    resolveWindowsAppPath(appName).pipe(Effect.map(Option.getOrNull), Effect.provide(NodeFileSystem.layer)),
  )
}

function checkMacosApp(appName: string) {
  return Effect.gen(function* () {
    const home = yield* Config.option(Config.String("HOME")).pipe(Effect.orDie)
    const locations = [
      `/Applications/${appName}.app`,
      `/System/Applications/${appName}.app`,
      ...Option.toArray(Option.map(home, (home) => `${home}/Applications/${appName}.app`)),
    ]

    if (Option.isSome(yield* firstExisting(locations))) return true

    return yield* attempt(() => execFilePromise("which", [appName])).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  })
}

function resolveWindowsAppPath(appName: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const output = yield* attempt(() => execFilePromise("where", [appName])).pipe(
      Effect.map((result) => result.stdout),
      Effect.option,
    )
    if (Option.isNone(output)) return Option.none<string>()

    const paths = output.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const hasExt = (path: string, ext: string) => extname(path).toLowerCase() === `.${ext}`

    const exe = paths.find((path) => hasExt(path, "exe"))
    if (exe) return Option.some(exe)

    // A read failure fails the whole lookup, as the rejected readFile did before.
    const resolveCmd = (path: string) =>
      Effect.gen(function* () {
        const content = yield* fs
          .readFileString(path, "utf8")
          .pipe(Effect.mapError((cause) => new AppLookupError({ cause })))
        for (const token of content.split('"').map((value: string) => value.trim())) {
          const lower = token.toLowerCase()
          if (!lower.includes(".exe")) continue

          const index = lower.indexOf("%~dp0")
          if (index >= 0) {
            const base = dirname(path)
            const suffix = token.slice(index + 5)
            const resolved = suffix
              .replace(/\//g, "\\")
              .split("\\")
              .filter((part: string) => part && part !== ".")
              .reduce((current: string, part: string) => {
                if (part === "..") return dirname(current)
                return join(current, part)
              }, base)

            if (yield* exists(resolved)) return Option.some(resolved)
          }

          if (yield* exists(token)) return Option.some(token)
        }

        return Option.none<string>()
      })

    for (const path of paths) {
      if (hasExt(path, "cmd") || hasExt(path, "bat")) {
        const resolved = yield* resolveCmd(path)
        if (Option.isSome(resolved)) return resolved
      }

      if (!extname(path)) {
        const cmd = `${path}.cmd`
        if (yield* exists(cmd)) {
          const resolved = yield* resolveCmd(cmd)
          if (Option.isSome(resolved)) return resolved
        }

        const bat = `${path}.bat`
        if (yield* exists(bat)) {
          const resolved = yield* resolveCmd(bat)
          if (Option.isSome(resolved)) return resolved
        }
      }
    }

    const key = appName
      .split("")
      .filter((value: string) => /[a-z0-9]/i.test(value))
      .map((value: string) => value.toLowerCase())
      .join("")

    if (key) {
      for (const path of paths) {
        const dirs = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))]
        for (const dir of dirs) {
          // An unreadable directory is skipped.
          const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []))
          for (const entry of entries) {
            const candidate = join(dir, entry)
            if (!hasExt(candidate, "exe")) continue
            const stem = entry.replace(/\.exe$/i, "")
            const name = stem
              .split("")
              .filter((value: string) => /[a-z0-9]/i.test(value))
              .map((value: string) => value.toLowerCase())
              .join("")
            if (name.includes(key) || key.includes(name)) return Option.some(candidate)
          }
        }
      }
    }

    return Arr.head(paths)
  })
}

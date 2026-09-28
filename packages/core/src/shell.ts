export * as Shell from "./shell"

import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { NodeFileSystem } from "@effect/platform-node"
import { Array, ByteSize, Config, ConfigProvider, Effect, FileSystem, Option, Schema } from "effect"
import { FlagConfig } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { which } from "./util/which"

const SIGKILL_TIMEOUT_MS = 200
const META: Record<string, { deny?: boolean; login?: boolean; posix?: boolean; ps?: boolean }> = {
  bash: { login: true, posix: true },
  dash: { login: true, posix: true },
  fish: { deny: true, login: true },
  ksh: { login: true, posix: true },
  nu: { deny: true },
  powershell: { ps: true },
  pwsh: { ps: true },
  sh: { login: true, posix: true },
  zsh: { login: true, posix: true },
}

export type Item = {
  path: string
  name: string
  acceptable: boolean
}

// The ambient ConfigProvider copies the environment once, and tests change SHELL at run
// time, so these read a fresh environment provider on each run.
const shellVariable = Config.option(Config.String("SHELL"))
const comspecVariable = Config.String("COMSPEC").pipe(Config.withDefault("cmd.exe"))
const fromEnvironment = <A>(config: Config.Config<A>) =>
  Effect.suspend(() => config.parse(ConfigProvider.fromEnv())).pipe(Effect.orDie)

// The command as a JSON string literal, which the POSIX shells below eval as double-quoted text.
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String))

export const killTree = Effect.fn("Shell.killTree")(function* (proc: ChildProcess, opts?: { exited?: () => boolean }) {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    yield* Effect.callback<void>((resume) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("exit", () => resume(Effect.void))
      killer.once("error", () => resume(Effect.void))
    })
    return
  }

  // Kill the process group; when that fails, kill the process itself.
  const killGroup = Effect.try(() => process.kill(-pid, "SIGTERM")).pipe(
    Effect.andThen(Effect.sleep(SIGKILL_TIMEOUT_MS)),
    Effect.andThen(
      Effect.try(() => {
        if (!opts?.exited?.()) process.kill(-pid, "SIGKILL")
      }),
    ),
  )
  const killProcess = Effect.sync(() => proc.kill("SIGTERM")).pipe(
    Effect.andThen(Effect.sleep(SIGKILL_TIMEOUT_MS)),
    Effect.andThen(
      Effect.sync(() => {
        if (!opts?.exited?.()) proc.kill("SIGKILL")
      }),
    ),
  )
  yield* killGroup.pipe(Effect.catch(() => killProcess))
})

// File information, or None when the path cannot be read.
const stat = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.stat(file)),
    Effect.option,
  )

const full = Effect.fnUntraced(function* (file: string) {
  if (process.platform !== "win32") return file
  const shell = FSUtil.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return Option.getOrElse(yield* gitbashPath(), () => shell)
    return shell
  }
  if (name(shell) === "bash") {
    const bash = yield* gitbashPath()
    if (Option.isSome(bash)) return bash.value
  }
  return Option.getOrElse(yield* which(shell), () => shell)
})

function meta(file: string) {
  return META[name(file)]
}

function ok(file: string) {
  return meta(file)?.deny !== true
}

function rooted(file: string) {
  return path.isAbsolute(FSUtil.windowsPath(file))
}

const resolve = Effect.fnUntraced(function* (file: string) {
  const shell = yield* full(file)
  if (!rooted(shell)) return yield* which(shell)
  const info = yield* stat(shell)
  return Option.isSome(info) && info.value.type === "File" ? Option.some(shell) : Option.none()
})

const win = Effect.fnUntraced(function* () {
  const shells = Array.getSomes([
    yield* which("pwsh"),
    yield* which("powershell"),
    yield* gitbashPath(),
    Option.some(yield* fromEnvironment(comspecVariable)),
  ])
  // Array.dedupe keeps the first occurrence, like the insertion order of a Set.
  return Array.dedupe(yield* Effect.forEach(shells, full))
})

const unix = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString("/etc/shells").pipe(Effect.orElseSucceed(() => ""))
  if (text) return Array.dedupe(text.split("\n").filter((line) => line.trim() && !line.startsWith("#")))
  return ["/bin/bash", "/bin/zsh", "/bin/sh"]
})

const select = Effect.fnUntraced(function* (file: Option.Option<string>, opts?: { acceptable?: boolean }) {
  if (Option.isSome(file) && (!opts?.acceptable || ok(file.value))) {
    const shell = yield* resolve(file.value)
    if (Option.isSome(shell)) return shell.value
  }
  if (process.platform === "win32") return (yield* win())[0]
  return yield* fallback()
})

// Git Bash next to git on Windows, or the OPENCODE_GIT_BASH_PATH override.
const gitbashPath = Effect.fnUntraced(function* () {
  if (process.platform !== "win32") return Option.none<string>()
  const configured = yield* FlagConfig.OPENCODE_GIT_BASH_PATH.pipe(Effect.orDie)
  if (Option.isSome(configured) && configured.value) return configured
  const git = yield* which("git")
  if (Option.isNone(git)) return Option.none<string>()
  const file = path.join(git.value, "..", "..", "bin", "bash.exe")
  const info = yield* stat(file)
  return Option.isSome(info) && !ByteSize.isZero(info.value.size) ? Option.some(file) : Option.none<string>()
})

export const gitbash = (): Effect.Effect<Option.Option<string>> =>
  gitbashPath().pipe(Effect.provide(NodeFileSystem.layer))

const fallback = Effect.fnUntraced(function* () {
  if (process.platform === "darwin") return "/bin/zsh"
  return Option.getOrElse(yield* which("bash"), () => "/bin/sh")
})

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(FSUtil.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return meta(file)?.login === true
}

export function posix(file: string) {
  return meta(file)?.posix === true
}

export function ps(file: string) {
  return meta(file)?.ps === true
}

const info = Effect.fnUntraced(function* (file: string) {
  const item = yield* full(file)
  const n = name(item)
  const resolved = yield* resolve(n)
  return {
    path: item,
    name: Option.isSome(resolved) ? n : item,
    acceptable: ok(item),
  } satisfies Item
})

export function args(file: string, command: string, cwd: string) {
  const n = name(file)
  if (n === "nu" || n === "fish") return ["-c", command]
  if (n === "zsh") {
    return [
      "-l",
      "-c",
      `
        [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
        [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${quote(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "bash") {
    return [
      "-l",
      "-c",
      `
        shopt -s expand_aliases
        [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
        cd -- "$1"
        eval ${quote(command)}
      `,
      "opencode",
      cwd,
    ]
  }
  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

// The default shell comes from SHELL and is resolved once; reset() forgets it.
function defaultShell(opts?: { acceptable?: boolean }) {
  let resolved = Option.none<string>()
  const get = Effect.suspend(() =>
    Option.isSome(resolved)
      ? Effect.succeed(resolved.value)
      : fromEnvironment(shellVariable).pipe(
          Effect.flatMap((shell) => select(shell, opts)),
          Effect.tap((shell) =>
            Effect.sync(() => {
              resolved = Option.some(shell)
            }),
          ),
        ),
  )
  const reset = () => {
    resolved = Option.none()
  }
  return { get, reset }
}

const defaultPreferred = defaultShell()
const defaultAcceptable = defaultShell({ acceptable: true })

export function preferred(configShell?: string): Effect.Effect<string> {
  const shell = configShell ? select(Option.some(configShell)) : defaultPreferred.get
  return shell.pipe(Effect.provide(NodeFileSystem.layer))
}
preferred.reset = defaultPreferred.reset

export function acceptable(configShell?: string): Effect.Effect<string> {
  const shell = configShell ? select(Option.some(configShell), { acceptable: true }) : defaultAcceptable.get
  return shell.pipe(Effect.provide(NodeFileSystem.layer))
}
acceptable.reset = defaultAcceptable.reset

export const list = (): Effect.Effect<Item[]> =>
  Effect.gen(function* () {
    const shells = process.platform === "win32" ? yield* win() : yield* unix()
    const resolved = yield* Effect.filter(shells, (shell) => Effect.map(resolve(shell), Option.isSome))
    return yield* Effect.forEach(resolved, info)
  }).pipe(Effect.provide(NodeFileSystem.layer))

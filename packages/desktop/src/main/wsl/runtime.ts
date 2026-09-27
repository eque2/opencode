import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as pty from "@lydell/node-pty"
import { Config, Data, Effect, Option } from "effect"
import type { WslDistroProbe, WslInstalledDistro, WslOnlineDistro, WslRuntimeCheck } from "../../preload/types"
import { wslTerminalArgs } from "./policy"
import { nativeT } from "../native-translations"

export type WslCommandLine = {
  stream: "stdout" | "stderr"
  text: string
}

export type WslCommandResult = {
  code: number | null
  signal: Option.Option<NodeJS.Signals>
  stdout: string
  stderr: string
}

export type RunWslOptions = {
  signal?: AbortSignal
  /**
   * Ceiling on how long we wait for the child process to exit. When the
   * LXSS service or a specific distro wedges (e.g. Ubuntu-24.04 with a
   * pending first-run prompt), `wsl.exe` never returns and any command
   * that doesn't specify a timeout hangs the entire startup flow. Default
   * is 20s — enough for slow cold-starts, short enough to fail fast on
   * a wedge. Callers can override for longer-running jobs.
   */
  timeoutMs?: number
}

const DEFAULT_WSL_TIMEOUT_MS = 20_000
const DEFAULT_WSL_INSTALL_TIMEOUT_MS = 15 * 60_000

class WslCommandTimeoutError extends Data.TaggedError("WslCommandTimeoutError")<{ readonly message: string }> {}

class WslCommandError extends Data.TaggedError("WslCommandError")<{ readonly message: string }> {}

class WslProcessKillError extends Data.TaggedError("WslProcessKillError")<{ readonly cause: unknown }> {}

export function wslArgs(args: string[], distro?: string | null, user?: string | null) {
  return [...(distro ? ["-d", distro] : []), ...(user ? ["--user", user] : []), "--", ...args]
}

export function runWsl(args: string[], opts: RunWslOptions = {}) {
  return runCommand("wsl", args, opts)
}

function runPowerShell(command: string, opts: RunWslOptions = {}) {
  return runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    opts,
  )
}

function runCommand(command: string, args: string[], opts: RunWslOptions = {}) {
  // Guard every wsl.exe invocation with a timeout. When the distro or
  // the LXSS service is wedged (Ubuntu first-run state, Windows update
  // pending, etc.) wsl.exe produces no output and never exits; without
  // this the whole sidecar spawn flow stalls the app forever.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS
  return Effect.callback<WslCommandResult, Error>((resume) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    })

    let stdout = ""
    let stderr = ""
    const stdoutDecoder = createOutputDecoder()
    const stderrDecoder = createOutputDecoder()

    const append = (stream: WslCommandLine["stream"], chunk: string) => {
      if (!chunk) return
      if (stream === "stdout") {
        stdout += chunk
        return
      }
      stderr += chunk
    }

    child.stdout.on("data", (chunk: Buffer) => {
      append("stdout", stdoutDecoder.decode(chunk))
    })
    child.stdout.on("end", () => {
      append("stdout", stdoutDecoder.flush())
    })

    child.stderr.on("data", (chunk: Buffer) => {
      append("stderr", stderrDecoder.decode(chunk))
    })
    child.stderr.on("end", () => {
      append("stderr", stderrDecoder.flush())
    })

    child.once("error", (error) => resume(Effect.fail(error)))
    child.once("close", (code, signal) =>
      resume(Effect.succeed({ code, signal: Option.fromNullishOr(signal), stdout, stderr })),
    )

    // Runs only when the timeout interrupts the wait.
    return killQuietly(() => child.kill())
  }).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => commandTimedOut(command, args, timeoutMs) }))
}

function runInteractiveCommand(command: string, args: string[], opts: RunWslOptions = {}, defaultTimeoutMs: number) {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
  const exited = Effect.callback<WslCommandResult>((resume) => {
    const child = pty.spawn(command, args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
      useConpty: true,
    })

    let stdout = ""
    child.onData((data: string) => {
      stdout += data
    })
    child.onExit((event: { exitCode: number }) => {
      resume(Effect.succeed({ code: event.exitCode, signal: Option.none(), stdout, stderr: "" }))
    })

    // Runs only when the abort signal or the timeout interrupts the wait.
    return killQuietly(() => child.kill())
  })

  return Effect.raceFirst(exited, abortRequested(opts.signal)).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => commandTimedOut(command, args, timeoutMs) }),
  )
}

function abortRequested(signal?: AbortSignal) {
  if (!signal) return Effect.never
  return Effect.callback<never, DOMException>((resume) => {
    const onAbort = () => resume(Effect.fail(new DOMException("Aborted", "AbortError")))
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })
}

function commandTimedOut(command: string, args: string[], timeoutMs: number) {
  return Effect.fail(
    new WslCommandTimeoutError({
      message: nativeT("desktop.wsl.error.commandTimeout", { command, args: args.join(" "), timeout: timeoutMs }),
    }),
  )
}

function killQuietly(kill: () => void) {
  return Effect.try({ try: kill, catch: (cause) => new WslProcessKillError({ cause }) }).pipe(Effect.ignore)
}

function createOutputDecoder() {
  let decoder: TextDecoder | undefined
  return {
    decode(chunk: Buffer) {
      decoder ??= new TextDecoder(detectOutputEncoding(chunk))
      return decoder.decode(chunk, { stream: true })
    },
    flush() {
      return decoder?.decode() ?? ""
    },
  }
}

function detectOutputEncoding(chunk: Uint8Array) {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return "utf-16le"
  const pairs = Math.floor(chunk.length / 2)
  if (pairs < 2) return "utf-8"
  const oddZeroes = Array.from({ length: pairs }).filter((_, index) => chunk[index * 2 + 1] === 0).length
  const evenZeroes = Array.from({ length: pairs }).filter((_, index) => chunk[index * 2] === 0).length
  return oddZeroes >= Math.ceil(pairs / 3) && evenZeroes * 2 <= oddZeroes ? "utf-16le" : "utf-8"
}

export function runWslInDistro(args: string[], distro?: string | null, opts?: RunWslOptions) {
  return runWsl(wslArgs(args, distro), opts)
}

export function runWslSh(script: string, distro?: string | null, opts?: RunWslOptions) {
  return runWslInDistro(["sh", "-lc", script], distro, opts)
}

export function probeWslRuntime(opts?: RunWslOptions): Promise<WslRuntimeCheck> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const version = yield* runWsl(["--version"], opts).pipe(
        Effect.catch((error) => Effect.succeed(failedCommand(error.message))),
      )

      if (version.code !== 0) {
        return {
          available: false,
          // eslint-disable-next-line effect/no-null-use-option -- (a) WslRuntimeCheck from @opencode-ai/app/wsl/types is the IPC wire type the renderer reads; it types a missing version as null
          version: null,
          error: summarize(version.stderr || version.stdout) || nativeT("desktop.wsl.error.unavailable"),
        }
      }

      return {
        available: true,
        version: Option.getOrNull(firstLine(version.stdout)),
        // eslint-disable-next-line effect/no-null-use-option -- (a) WslRuntimeCheck from @opencode-ai/app/wsl/types is the IPC wire type the renderer reads; it types "no error" as null
        error: null,
      }
    }),
  )
}

export function listInstalledWslDistros(opts?: RunWslOptions) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* runWsl(["--list", "--verbose"], opts)
      if (result.code !== 0) {
        return yield* Effect.fail(
          new WslCommandError({
            message: summarize(result.stderr || result.stdout) || nativeT("desktop.wsl.error.listInstalled"),
          }),
        )
      }
      return parseInstalledDistros(result.stdout)
    }),
  )
}

export function listOnlineWslDistros(opts?: RunWslOptions) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* runWsl(["--list", "--online"], opts)
      if (result.code !== 0) {
        return yield* Effect.fail(
          new WslCommandError({
            message: summarize(result.stderr || result.stdout) || nativeT("desktop.wsl.error.listOnline"),
          }),
        )
      }
      return parseOnlineDistros(result.stdout)
    }),
  )
}

export function installWslRuntimeElevated(opts?: RunWslOptions) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$process = Start-Process -FilePath 'wsl.exe' -Verb RunAs -ArgumentList @('--install','--no-distribution') -Wait -PassThru",
    "if ($null -ne $process.ExitCode) { exit $process.ExitCode }",
  ].join("; ")
  return Effect.runPromise(runPowerShell(script, withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS)))
}

export function installWslDistro(name: string, opts?: RunWslOptions) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* runInteractiveCommand(
        yield* resolveSystem32Command("wsl.exe"),
        ["--install", "-d", name, "--web-download", "--no-launch"],
        withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
        DEFAULT_WSL_INSTALL_TIMEOUT_MS,
      )
    }),
  )
}

export function installWslOpencode(version: string, distro: string, opts?: RunWslOptions) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* runInteractiveCommand(
        yield* resolveSystem32Command("wsl.exe"),
        wslArgs(
          ["bash", "-lc", `curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)}`],
          distro,
        ),
        withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
        DEFAULT_WSL_INSTALL_TIMEOUT_MS,
      )
    }),
  )
}

export function probeWslDistro(name: string, opts?: RunWslOptions): Promise<WslDistroProbe> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const executable = yield* runWslInDistro(["/bin/true"], name, opts).pipe(
        Effect.catch((error) => Effect.succeed(failedCommand(error.message))),
      )
      if (executable.code !== 0) {
        return {
          name,
          canExecute: false,
          hasBash: false,
          hasCurl: false,
          error: summarize(executable.stderr || executable.stdout) || nativeT("desktop.wsl.error.executeDistro"),
        }
      }

      const [bash, curl] = yield* Effect.all(
        [
          runWslSh("command -v bash >/dev/null && printf yes || printf no", name, opts),
          runWslSh("command -v curl >/dev/null && printf yes || printf no", name, opts),
        ],
        { concurrency: "unbounded" },
      )

      return {
        name,
        canExecute: true,
        hasBash: bash.code === 0 && summarize(bash.stdout) === "yes",
        hasCurl: curl.code === 0 && summarize(curl.stdout) === "yes",
        // eslint-disable-next-line effect/no-null-use-option -- (a) WslDistroProbe from @opencode-ai/app/wsl/types is the IPC wire type the renderer reads; it types "no error" as null
        error: null,
      }
    }),
  )
}

/** Finds the opencode binary installed in the distro's home directory. */
export function findWslOpencode(distro: string, opts?: RunWslOptions) {
  return runWslSh(
    'if [ -x "$HOME/.opencode/bin/opencode" ]; then printf "%s\\n" "$HOME/.opencode/bin/opencode"; fi',
    distro,
    opts,
  ).pipe(Effect.map((result) => firstLine(result.stdout)))
}

export function resolveWslOpencode(distro: string, opts?: RunWslOptions) {
  return Effect.runPromise(findWslOpencode(distro, opts).pipe(Effect.map(Option.getOrNull)))
}

export function readWslCommandVersion(command: string, distro: string, opts?: RunWslOptions) {
  return Effect.runPromise(
    runWslSh(`${shellEscape(command)} --version 2>/dev/null || true`, distro, opts).pipe(
      Effect.map((result) => Option.getOrNull(firstLine(result.stdout))),
    ),
  )
}

export function openWslTerminal(distro?: string | null) {
  return Effect.runPromise(
    Effect.callback<void, Error>((resume) => {
      const child = spawn("cmd.exe", wslTerminalArgs(distro), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
      child.once("error", (error) => resume(Effect.fail(error)))
      child.once("spawn", () => {
        child.unref()
        resume(Effect.void)
      })
    }),
  )
}

function failedCommand(message: string): WslCommandResult {
  return { code: 1, signal: Option.none(), stdout: "", stderr: message }
}

function parseInstalledDistros(output: string) {
  return output.split(/\r?\n/g).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    const match = line.match(/^\s*(\*)?\s*(.*?)\s{2,}\S+\s+(\d+)\s*$/)
    if (!match) return []
    const [, marker, name, version] = match
    if (!name || /^name$/i.test(name)) return []
    return [
      {
        name: name.trim(),
        version: Option.getOrNull(Option.liftPredicate(Number.parseInt(version, 10), (value) => !Number.isNaN(value))),
        isDefault: marker === "*",
      } satisfies WslInstalledDistro,
    ]
  })
}

function parseOnlineDistros(output: string) {
  return output.split(/\r?\n/g).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    const match = trimmed.match(/^([A-Za-z0-9._-]+)\s{2,}(.+)$/)
    if (!match) return []
    const [, name, label] = match
    if (/^name$/i.test(name)) return []
    return [{ name, label: label.trim() } satisfies WslOnlineDistro]
  })
}

function firstLine(value: string) {
  return Option.fromNullishOr(
    value
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find(Boolean),
  )
}

export function summarize(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

export function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function resolveSystem32Command(command: string) {
  return Config.option(Config.String("SystemRoot").pipe(Config.orElse(() => Config.String("windir")))).pipe(
    Effect.map((root) =>
      Option.match(root, {
        onNone: () => command,
        onSome: (systemRoot) => {
          const resolved = join(systemRoot, "System32", command)
          return existsSync(resolved) ? resolved : command
        },
      }),
    ),
  )
}

function withTimeout(opts: RunWslOptions | undefined, timeoutMs: number): RunWslOptions {
  return {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? timeoutMs,
  }
}

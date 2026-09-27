import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app } from "electron"
import { Array as Arr, Config, ConfigProvider, Data, Effect, Option, Predicate } from "effect"

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
// A copy of the environment at import time. main/index.ts later writes XDG_STATE_HOME into
// process.env, and the service lookup must use the value the app was launched with.
// Empty strings stay values, as they did when this read process.env directly.
const launchEnv = ConfigProvider.fromEnvRecord({ ...process.env }, { preserveEmptyStrings: true })
const desktopStateNames = ["ai.opencode.desktop.dev", "ai.opencode.desktop.beta", "ai.opencode.desktop"]

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

class BackgroundCliError extends Data.TaggedError("BackgroundCliError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BackgroundCliError({ message: errorMessage(cause), cause }),
  })

// main/index.ts awaits this Promise; it rejects with a BackgroundCliError when a CLI step fails.
export function startBackgroundCli(logger: Logger, shellStateHome?: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const stateHome = yield* Config.option(Config.String("XDG_STATE_HOME")).parse(launchEnv).pipe(Effect.orDie)
      const bundled = app.isPackaged
        ? join(process.resourcesPath, executableName())
        : join(root, "../../resources", executableName())
      logger.log("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
      // The version probe runs without XDG_STATE_HOME, as it always has.
      const version = yield* run(bundled, ["--version"], logger, Option.none())
      const binary = app.isPackaged ? yield* installCli(bundled, version, logger) : bundled

      // Option.none() stands for an unset XDG_STATE_HOME, which run removes from the child env.
      const candidates = Arr.dedupe([
        stateHome,
        Option.fromNullishOr(shellStateHome),
        ...desktopStateNames.map((name) => Option.some(join(app.getPath("appData"), name))),
      ]).filter((candidate) => Option.match(candidate, { onNone: () => true, onSome: existsSync }))
      const discovered = yield* Effect.forEach(
        candidates,
        (candidate) =>
          run(binary, ["service", "status"], logger, candidate).pipe(
            Effect.map((status) => ({ stateHome: candidate, url: serviceUrl(status) })),
          ),
        { concurrency: "unbounded" },
      )
      const found = Arr.findFirst(discovered, (candidate) => Option.isSome(candidate.url))
      logger.log("v2 CLI background instance checked", {
        detected: Option.isSome(found),
        ...endpoint(Option.flatMap(found, (candidate) => candidate.url)),
      })

      const daemonStateHome = Option.orElse(
        Option.flatMap(found, (candidate) => candidate.stateHome),
        () => stateHome,
      )
      const url = yield* run(binary, ["service", "start"], logger, daemonStateHome)
      const password = yield* run(binary, ["service", "get", "password"], logger, daemonStateHome, { redact: true })
      logger.log("v2 CLI background service ready", {
        existing: Option.isSome(found),
        username: "opencode",
        ...endpoint(Option.some(url)),
      })
      return {
        url,
        username: "opencode",
        password,
      }
    }),
  )
}

function installCli(source: string, version: string, logger: Logger) {
  return Effect.gen(function* () {
    const directory = join(app.getPath("userData"), "cli", version.replace(/[^a-zA-Z0-9._-]/g, "-"))
    const destination = join(directory, executableName())
    if (existsSync(destination)) {
      logger.log("v2 CLI staged executable reused", { path: destination, version })
      return destination
    }

    const temp = destination + `.${process.pid}.tmp`
    yield* attempt(() => mkdir(directory, { recursive: true }))
    yield* attempt(() => copyFile(source, temp))
    if (process.platform !== "win32") yield* attempt(() => chmod(temp, 0o755))
    // A failed rename removes the temporary copy, then fails with the rename error.
    yield* attempt(() => rename(temp, destination)).pipe(Effect.tapError(() => attempt(() => rm(temp, { force: true }))))
    logger.log("v2 CLI executable staged", { source, path: destination, version })
    return destination
  })
}

function run(
  binary: string,
  args: string[],
  logger: Logger,
  stateHome: Option.Option<string>,
  options: { redact?: boolean } = {},
) {
  return Effect.gen(function* () {
    logger.log("v2 CLI command started", { binary, args })
    const env = { ...process.env }
    Option.match(stateHome, {
      onNone: () => {
        delete env.XDG_STATE_HOME
      },
      onSome: (value) => {
        env.XDG_STATE_HOME = value
      },
    })
    const result = yield* attempt(() => execFileAsync(binary, args, { env, windowsHide: true })).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          const stdout = commandOutput(error.cause, "stdout")
          logger.error("v2 CLI command failed", {
            args,
            error: error.message,
            stdout: options.redact && Option.exists(stdout, (value) => value.length > 0) ? "[redacted]" : trimmed(stdout),
            stderr: trimmed(commandOutput(error.cause, "stderr")),
          })
        }),
      ),
    )
    const stdout = result.stdout.trim()
    const stderr = result.stderr.trim()
    logger.log("v2 CLI command completed", { args, stdout: options.redact ? "[redacted]" : stdout, stderr })
    return stdout
  })
}

// execFile attaches the captured stdout and stderr strings to the error it rejects with.
function commandOutput(error: unknown, key: "stdout" | "stderr") {
  return Predicate.hasProperty(error, key) && Predicate.isString(error[key]) ? Option.some(error[key]) : Option.none()
}

function trimmed(output: Option.Option<string>) {
  return Option.match(output, { onNone: () => "", onSome: (value) => value.trim() })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function serviceUrl(status: string) {
  if (URL.canParse(status)) return Option.some(status)
  if (!status.startsWith("running ")) return Option.none<string>()
  const url = status.slice("running ".length).trim()
  return URL.canParse(url) ? Option.some(url) : Option.none<string>()
}

function endpoint(url: Option.Option<string>) {
  return Option.match(
    Option.filter(url, (value) => URL.canParse(value)),
    {
      onNone: () => ({}),
      onSome: (value) => {
        const parsed = new URL(value)
        return { url: value, hostname: parsed.hostname, port: parsed.port }
      },
    },
  )
}

function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}

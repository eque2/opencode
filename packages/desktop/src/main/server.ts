import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import { Config, ConfigProvider, Data, Deferred, Effect, Option, Predicate } from "effect"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "opencode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  return Option.getOrNull(Option.liftPredicate(getStore().get(DEFAULT_SERVER_URL_KEY), Predicate.isString))
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

/**
 * Merges the login shell environment and the desktop flags into process.env.
 * Returns the shell environment, or null when the probe did not load one.
 */
export function loadAppEnv(userDataPath: string) {
  return Effect.gen(function* () {
    const shellEnv =
      process.platform === "win32"
        ? Option.none<Record<string, string>>()
        : loadShellEnv(yield* getUserShell(), getLogger())
    const stateHome = yield* Config.option(Config.String("XDG_STATE_HOME"))
    Object.assign(process.env, {
      ...Option.getOrUndefined(shellEnv),
      OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
      OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
      OPENCODE_CLIENT: "desktop",
      XDG_STATE_HOME: Option.getOrElse(stateHome, () => userDataPath),
    })
    return Option.getOrNull(shellEnv)
  }).pipe(
    // The default ConfigProvider snapshots process.env on first use. main/index.ts
    // writes XDG_* test paths before this runs, so read a fresh snapshot here.
    // preserveEmptyStrings keeps an empty XDG_STATE_HOME, as the old ?? did.
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
  )
}

export function preferAppEnv(userDataPath: string) {
  return Effect.runSync(loadAppEnv(userDataPath))
}

export function spawnLocalServer(hostname: string, port: number, password: string, options: SpawnLocalServerOptions) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
      const child = utilityProcess.fork(sidecar, [], {
        cwd: process.cwd(),
        env: createSidecarEnv(),
        serviceName: SIDECAR_SERVICE_NAME,
        stdio: "pipe",
      })
      let exited = false
      const exit = yield* Deferred.make<number>()

      const onProcessGone = (_event: unknown, details: Details) => {
        if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
        options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
      }

      app.on("child-process-gone", onProcessGone)
      child.once("exit", (code) => {
        exited = true
        app.off("child-process-gone", onProcessGone)
        options.onExit?.(code)
        Deferred.doneUnsafe(exit, Effect.succeed(code))
      })
      child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

      child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
      child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

      yield* Effect.callback<void, SidecarStartError>((resume) => {
        const cleanup = () => {
          child.off("message", onMessage)
          child.off("exit", onExit)
        }
        const settle = (result: Effect.Effect<void, SidecarStartError>) => {
          cleanup()
          resume(result)
        }
        const onMessage = (message: SidecarMessage) => {
          if (message.type === "ready") {
            settle(Effect.void)
            return
          }
          if (message.type === "error") {
            settle(Effect.fail(new SidecarStartError({ message: message.error.message, stack: message.error.stack })))
          }
        }
        const onExit = (code: number) => {
          settle(Effect.fail(new SidecarStartError({ message: `Sidecar exited before ready with code ${code}` })))
        }

        child.on("message", onMessage)
        child.on("exit", onExit)
        child.postMessage({
          type: "start",
          hostname,
          port,
          password,
          userDataPath: options.userDataPath,
        })
        // Runs only when the stall timeout interrupts the wait.
        return Effect.sync(cleanup)
      }).pipe(
        Effect.timeoutOrElse({
          duration: SIDECAR_START_STALL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new SidecarStartError({
                message: `Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`,
              }),
            ),
        }),
        Effect.tapError(() =>
          Effect.sync(() => {
            if (!exited) child.kill()
          }),
        ),
      )

      const url = `http://${hostname}:${port}`
      const ready = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("100 millis")
          if (yield* healthy(url, password)) return
        }
      })
      const gone = Deferred.await(exit).pipe(
        Effect.flatMap((code) =>
          Effect.fail(new SidecarExitError({ message: `Sidecar exited before health check passed with code ${code}` })),
        ),
      )
      const wait = Effect.runPromise(Effect.raceFirst(ready, gone))

      let stopping: Promise<void> | undefined

      return {
        listener: {
          stop: () => {
            if (stopping) return stopping
            if (exited) return Effect.runPromise(Effect.void)
            child.postMessage({ type: "stop" })
            stopping = Effect.runPromise(
              Effect.raceFirst(
                Deferred.await(exit).pipe(Effect.asVoid),
                Effect.sleep(SIDECAR_STOP_TIMEOUT).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (!exited) child.kill()
                    }),
                  ),
                ),
              ),
            )
            return stopping
          },
        },
        health: { wait },
      }
    }),
  )
}

export function checkHealth(url: string, password?: string | null): Promise<boolean> {
  return Effect.runPromise(healthy(url, password))
}

class SidecarStartError extends Data.TaggedError("SidecarStartError")<{
  readonly message: string
  readonly stack?: string
}> {}

class SidecarExitError extends Data.TaggedError("SidecarExitError")<{ readonly message: string }> {}

class HealthCheckError extends Data.TaggedError("HealthCheckError")<{ readonly cause: unknown }> {}

function healthy(url: string, password?: string | null) {
  return Effect.gen(function* () {
    const healthUrls = yield* Effect.try({
      try: () => [new URL("/api/health", url), new URL("/global/health", url)],
      catch: (cause) => new HealthCheckError({ cause }),
    }).pipe(Effect.option)
    if (Option.isNone(healthUrls)) return false

    const headers = new Headers()
    if (password) {
      const auth = Buffer.from(`opencode:${password}`).toString("base64")
      headers.set("authorization", `Basic ${auth}`)
    }

    for (const healthUrl of healthUrls.value) {
      const ok = yield* Effect.tryPromise({
        try: () =>
          fetch(healthUrl, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(3000),
          }),
        catch: (cause) => new HealthCheckError({ cause }),
      }).pipe(
        Effect.map((res) => res.ok),
        Effect.orElseSucceed(() => false),
      )
      if (ok) return true
    }
    return false
  })
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]): Array<[string, string]> =>
      value === undefined ? [] : [[key, value]],
    ),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  return env
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

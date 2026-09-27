import type { UpdaterState } from "@opencode-ai/app/updater"
import { Data, Deferred, Effect, MutableHashSet, Option } from "effect"

export type { UpdaterState } from "@opencode-ai/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): Effect.Effect<void, Error>
}

type UpdaterPersistence = {
  get(): Option.Option<UpdaterReadyRecord>
  set(value: UpdaterReadyRecord): void
  clear(): void
}

// The message carries the original error text because ipcMain.handle sends
// only the message of a rejected install to the renderer.
class UpdaterError extends Data.TaggedError("UpdaterError")<{ readonly message: string; readonly cause?: unknown }> {}

const updaterError = (cause: unknown) =>
  new UpdaterError({ message: cause instanceof Error ? cause.message : String(cause), cause })

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  stop: () => Promise<void>
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending = Option.none<Deferred.Deferred<UpdaterState>>()
  const listeners = MutableHashSet.empty<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    Array.from(listeners).forEach((listener) => listener(state))
    return state
  }

  const persist = <A>(run: () => A) => Effect.try({ try: run, catch: updaterError })

  const download = Effect.gen(function* () {
    transition({ status: "checking" })
    const result = yield* Effect.tryPromise({ try: () => input.backend.checkForUpdates(), catch: updaterError })
    const version = result?.updateInfo?.version
    if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
      yield* persist(() => input.persistence.clear())
      return transition({ status: "up-to-date" })
    }

    transition({ status: "downloading", version })
    yield* Effect.tryPromise({ try: () => input.backend.downloadUpdate(), catch: updaterError })
    yield* persist(() => input.persistence.set({ version }))
    return transition({ status: "ready", version })
  }).pipe(Effect.catch((error) => Effect.sync(() => transition({ status: "error", message: error.message }))))

  // Concurrent callers join the check in flight. The Deferred is registered
  // before the first yield, so a second caller always sees it.
  const check = Effect.suspend(() => {
    if (!input.enabled || state.status === "ready") return Effect.succeed(state)
    return Option.match(pending, {
      onSome: (inFlight) => Deferred.await(inFlight),
      onNone: () => {
        const inFlight = Deferred.makeUnsafe<UpdaterState>()
        pending = Option.some(inFlight)
        return Effect.exit(download).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pending = Option.none()
            }),
          ),
          Effect.tap((exit) => Deferred.done(inFlight, exit)),
          Effect.flatMap((exit) => exit),
        )
      },
    })
  })

  const start = Effect.gen(function* () {
    const ready = yield* persist(() => input.persistence.get())
    if (Option.exists(ready, (record) => record.version === input.currentVersion))
      yield* persist(() => input.persistence.clear())
    return yield* check
  })

  const install = Effect.gen(function* () {
    if (state.status !== "ready") return yield* new UpdaterError({ message: "Update is not ready to install" })
    const version = state.version
    transition({ status: "installing", version })
    return yield* Effect.tryPromise({ try: () => input.stop(), catch: updaterError }).pipe(
      Effect.andThen(input.backend.quitAndInstall().pipe(Effect.mapError(updaterError))),
      Effect.ensuring(Effect.sync(() => transition({ status: "ready", version }))),
    )
  })

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      MutableHashSet.add(listeners, listener)
      listener(state)
      return () => MutableHashSet.remove(listeners, listener)
    },
    start: () => Effect.runPromise(start),
    check: () => Effect.runPromise(check),
    install: () => Effect.runPromise(install),
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>

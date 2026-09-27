import { app, dialog } from "electron"
import pkg from "electron-updater"
import { Data, Effect, Option } from "effect"
import { UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"
import { setAppQuitting } from "./windows"
import { nativeT } from "./native-translations"

const { autoUpdater } = pkg
const key = "ready"

class UpdaterInstallError extends Data.TaggedError("UpdaterInstallError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const installError = (cause: unknown) =>
  new UpdaterInstallError({ message: cause instanceof Error ? cause.message : String(cause), cause })

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  const store = getStore("opencode.updater")
  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      quitAndInstall: () =>
        // quitAndInstall closes all windows before emitting before-quit, so
        // flag the quit first to keep window ids persisted for restore.
        Effect.sync(() => setAppQuitting()).pipe(
          Effect.andThen(Effect.try({ try: () => autoUpdater.quitAndInstall(), catch: installError })),
          // The install failed and the app keeps running; clear the flag so
          // deliberate window closes prune ids again.
          Effect.tapError(() => Effect.sync(() => setAppQuitting(false))),
        ),
    },
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string")
          return Option.none()
        return Option.some({ version: value.version } satisfies UpdaterReadyRecord)
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Effect.promise(() => controller.check())
      if (state.status === "error") {
        if (!alertOnFail) return
        yield* Effect.promise(() =>
          dialog.showMessageBox({
            type: "error",
            message: nativeT("desktop.updater.dialog.checkFailed.message"),
            title: nativeT("desktop.updater.dialog.checkFailed.title"),
          }),
        )
        return
      }
      if (state.status === "up-to-date") {
        if (!alertOnFail) return
        yield* Effect.promise(() =>
          dialog.showMessageBox({
            type: "info",
            message: nativeT("desktop.updater.dialog.upToDate.message"),
            title: nativeT("desktop.updater.dialog.upToDate.title"),
          }),
        )
        return
      }
      if (state.status !== "ready") return

      const response = yield* Effect.promise(() =>
        dialog.showMessageBox({
          type: "info",
          message: nativeT("desktop.updater.dialog.ready.message", { version: state.version }),
          title: nativeT("desktop.updater.dialog.ready.title"),
          buttons: [nativeT("desktop.updater.dialog.restart"), nativeT("desktop.updater.dialog.later")],
          defaultId: 0,
          cancelId: 1,
        }),
      )
      if (response.response === 0)
        yield* Effect.tryPromise({ try: () => controller.install(), catch: installError })
    }),
  )
}

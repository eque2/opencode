import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import { Data, Effect, Option, Schema } from "effect"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { parseDesktopNativeBundle, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"

import type { FatalRendererError, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  openExternalURL,
  openLocalFileURL,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { createDesktopDraftStore } from "./draft-store"
import { nativeT } from "./native-translations"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: nativeT("desktop.dialog.files"), extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

class IpcHandlerError extends Data.TaggedError("IpcHandlerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// Electron sends a rejected handler to the renderer as `String(error)`. A plain Error keeps the
// "Error: <message>" text that the renderer has always received, whatever the tagged error name is.
const runIpcHandler = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.catch((error) => Effect.die(new Error(error.message)))))

const encodeStoreValue = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  setNativeTranslations: (bundle: DesktopNativeBundle) => void
}

export function registerIpcHandlers(deps: Deps) {
  const drafts = createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite"))
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", () => updaterSubscriptions.clear())
  app.on("before-quit", () => drafts.flush())
  app.once("will-quit", () => drafts.close())
  app.on("browser-window-created", (_event, win) => win.on("session-end", () => drafts.flush()))

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    runIpcHandler(setForceFocus(event.sender, enabled)),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("set-native-translations", (event: IpcMainInvokeEvent, value: unknown) =>
    runIpcHandler(
      Effect.gen(function* () {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (
          !win ||
          win.isDestroyed() ||
          win.webContents !== event.sender ||
          event.senderFrame !== event.sender.mainFrame
        ) {
          return yield* new IpcHandlerError({ message: "Invalid native translation sender" })
        }
        const bundle = parseDesktopNativeBundle(value)
        if (!bundle) return yield* new IpcHandlerError({ message: "Invalid native translation bundle" })
        return deps.setNativeTranslations(bundle)
      }),
    ),
  )
  // A missing key, an unreadable store, and a value that does not encode to JSON all read as absent.
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) =>
    Option.getOrNull(
      Option.liftThrowable(() => getStore(name).get(key))().pipe(
        Option.flatMap(Option.fromNullishOr),
        Option.flatMap((value) => (typeof value === "string" ? Option.some(value) : encodeStoreValue(value))),
      ),
    ),
  )
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  ipcMain.handle("draft-get", (_event, key: string) => drafts.get(key))
  ipcMain.handle("draft-set", (_event, key: string, value: string) => drafts.set(key, value))
  ipcMain.handle("draft-delete", (_event, key: string) => drafts.set(key, null))
  ipcMain.handle("draft-blob-put", (_event, data: ArrayBuffer) => drafts.putBlob(new Uint8Array(data)))
  ipcMain.handle("draft-blob-get", (_event, id: string) =>
    Option.fromNullishOr(drafts.getBlob(id)).pipe(
      Option.map((data) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
      Option.getOrNull,
    ),
  )

  ipcMain.handle(
    "open-directory-picker",
    (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) =>
      Effect.runPromise(
        Effect.promise(() =>
          dialog.showOpenDialog({
            properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
            title: opts?.title ?? nativeT("desktop.dialog.chooseFolder"),
            defaultPath: opts?.defaultPath,
          }),
        ).pipe(
          Effect.map((result) =>
            Option.liftPredicate(result, (picked) => !picked.canceled).pipe(
              Option.map((picked) => (opts?.multiple ? picked.filePaths : picked.filePaths[0])),
              Option.getOrNull,
            ),
          ),
        ),
      ),
  )

  ipcMain.handle(
    "open-file-picker",
    (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) =>
      runIpcHandler(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            dialog.showOpenDialog({
              properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
              title: opts?.title ?? nativeT("desktop.dialog.chooseFile"),
              defaultPath: opts?.defaultPath,
              filters: pickerFilters(opts?.extensions),
            }),
          )
          if (result.canceled) return Option.none()
          const files = yield* Effect.forEach(
            result.filePaths,
            (filePath) =>
              Effect.tryPromise({ try: () => stat(filePath), catch: toIpcHandlerError }).pipe(
                Effect.map((info) => ({ path: filePath, name: basename(filePath), size: info.size })),
              ),
            { concurrency: "unbounded" },
          )
          yield* assertAttachmentBudget(files)
          const token = pickedFiles.add(event.sender.id, result.filePaths)
          return Option.some({ token, files })
        }).pipe(Effect.map(Option.getOrNull)),
      ),
  )

  ipcMain.handle("read-picked-file", (event: IpcMainInvokeEvent, token: string, filePath: string) =>
    runIpcHandler(pickedFiles.read(event.sender.id, token, filePath)),
  )

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle("save-file-picker", (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) =>
    Effect.runPromise(
      Effect.promise(() =>
        dialog.showSaveDialog({
          title: opts?.title ?? nativeT("desktop.dialog.saveFile"),
          defaultPath: opts?.defaultPath,
        }),
      ).pipe(
        Effect.map((result) =>
          Option.fromNullishOr(result.filePath).pipe(
            Option.filter(() => !result.canceled),
            Option.getOrNull,
          ),
        ),
      ),
    ),
  )

  ipcMain.on("open-external", (_event: IpcMainEvent, url: string) => {
    openExternalURL(url)
  })

  ipcMain.on("open-local-file", (_event: IpcMainEvent, url: string) => {
    openLocalFileURL(url)
  })

  ipcMain.handle("open-path", (_event: IpcMainInvokeEvent, path: string, app?: string) =>
    runIpcHandler(app ? openWithApp(path, app) : Effect.promise(() => shell.openPath(path))),
  )

  ipcMain.handle("reveal-path", (_event: IpcMainInvokeEvent, path: string) =>
    Effect.runPromise(
      Effect.isSuccess(Effect.tryPromise(() => stat(path))).pipe(
        Effect.tap((exists) => (exists ? Effect.sync(() => shell.showItemInFolder(path)) : Effect.void)),
      ),
    ),
  )

  ipcMain.handle("read-clipboard-image", () =>
    Option.liftPredicate(clipboard.readImage(), (image) => !image.isEmpty()).pipe(
      Option.map((image) => {
        const size = image.getSize()
        return { buffer: image.toPNG().buffer, width: size.width, height: size.height }
      }),
      Option.getOrNull,
    ),
  )

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) =>
    runIpcHandler(
      Effect.gen(function* () {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return yield* new IpcHandlerError({ message: "Window not found" })
        const id = getWindowID(win)
        if (!id) return yield* new IpcHandlerError({ message: "Window ID not found" })
        return id
      }),
    ),
  )

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

const openWithApp = (path: string, app: string) =>
  Effect.callback<void, IpcHandlerError>((resume) => {
    const [cmd, args] =
      process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
    execFile(cmd, args, (err) => resume(err ? Effect.fail(toIpcHandlerError(err)) : Effect.void))
  })

const toIpcHandlerError = (cause: unknown) =>
  new IpcHandlerError({ message: cause instanceof Error ? cause.message : String(cause), cause })

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}

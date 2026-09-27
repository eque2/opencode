import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import { Array as Arr, Config, ConfigProvider, Data, Deferred, Effect, Fiber, Option } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import { setNativeTranslations } from "./native-translations"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

class PortError extends Data.TaggedError("PortError")<{ readonly message: string }> {}
class StartupStepError extends Data.TaggedError("StartupStepError")<{ readonly cause: unknown }> {}

let logger: ReturnType<typeof initLogging>
let server: Option.Option<SidecarListener> = Option.none()

let pendingDeepLinks: ReadonlyArray<string> = []

// Electron 41.2 runs Node 24.14.1, which has http.setGlobalProxyFromEnv; latest @types/node@24
// is 24.12.2 and does not declare it.
const hasEnvProxy = (module: typeof http): module is typeof http & { setGlobalProxyFromEnv: () => void } =>
  "setGlobalProxyFromEnv" in module && typeof module.setGlobalProxyFromEnv === "function"

const useEnvProxy = Effect.suspend(() => {
  // A namespace import does not narrow, so the guard checks a local binding.
  const module = http
  return hasEnvProxy(module)
    ? Effect.try({ try: () => module.setGlobalProxyFromEnv(), catch: (cause) => new StartupStepError({ cause }) })
    : Effect.fail(new StartupStepError({ cause: "http.setGlobalProxyFromEnv is not available" }))
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      logger.warn("failed to load proxy environment", error.cause)
    }),
  ),
)

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks = [...pendingDeepLinks, ...urls]
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (Option.isNone(server)) return
  const current = server.value
  server = Option.none()
  await current.stop()
}

// Reads one environment variable when the Effect runs. The default ConfigProvider keeps a
// copy of process.env, but startup writes process.env (preferAppEnv, ensureLoopbackNoProxy).
// The provider reads process.env itself, which keeps Windows case-insensitive lookups.
const readEnv = (name: string) =>
  Config.option(Config.String(name)).parse(ConfigProvider.fromEnvRecord(process.env)).pipe(Effect.orDie)

// NO_PROXY and no_proxy run in order: on Windows they name one variable, and the second
// pass must read the value that the first pass wrote.
const ensureLoopbackNoProxy = Effect.forEach(
  ["NO_PROXY", "no_proxy"],
  (key) =>
    readEnv(key).pipe(
      Effect.map((value) => {
        const loopback = ["127.0.0.1", "localhost", "::1"]
        const items = Option.getOrElse(value, () => "")
          .split(",")
          .map((value: string) => value.trim())
          .filter((value: string) => Boolean(value))
        const missing = loopback.filter((host) => !items.some((value: string) => value.toLowerCase() === host))

        Object.assign(process.env, { [key]: [...items, ...missing].join(",") })
      }),
    ),
  { discard: true },
)

// Creates the throwaway data folders for the onboarding E2E run and points the app and the
// sidecar at them through process.env.
function createOnboardingTestRoot() {
  const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
  rmSync(root, { recursive: true, force: true })
  ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
    mkdirSync(join(root, dir), { recursive: true }),
  )
  Object.assign(process.env, {
    OPENCODE_DB: ":memory:",
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  })
  return root
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  yield* Effect.try({ try: () => process.chdir(homedir()), catch: (cause) => new StartupStepError({ cause }) }).pipe(
    Effect.ignore,
  )

  Object.assign(process.env, { OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true" })
  const testOnboarding = Option.contains(yield* readEnv("OPENCODE_TEST_ONBOARDING"), "1")
  const sidecarVersion = Option.contains(yield* readEnv("OPENCODE_SIDECAR_V2"), "1") ? "v2" : "v1"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
  const onboardingTestRoot = testOnboarding ? Option.some(createOnboardingTestRoot()) : Option.none<string>()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    Option.match(onboardingTestRoot, {
      onNone: () => join(app.getPath("appData"), appId),
      onSome: (root) => join(root, "desktop"),
    }),
  )
  if (Option.isSome(onboardingTestRoot)) app.setPath("sessionData", join(onboardingTestRoot.value, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch()
      app.quit()
    })
  }

  yield* Effect.try({
    try: () => setDefaultCACertificates(Arr.dedupe([...getCACertificates("default"), ...getCACertificates("system")])),
    catch: (cause) => new StartupStepError({ cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to load system certificates", error.cause)
      }),
    ),
  )

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Option.isSome(onboardingTestRoot),
  })

  yield* ensureLoopbackNoProxy
  yield* useEnvProxy
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const shellEnv = preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.quit())
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  if (!testOnboarding) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => {
      const links = [...pendingDeepLinks]
      pendingDeepLinks = []
      return links
    },
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    // The desktop app keeps no Linux display backend setting, so the IPC reply is always absent.
    getDisplayBackend: () => Effect.runPromise(Effect.succeed(Option.getOrNull(Option.none<string>()))),
    setDisplayBackend: () => {},
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: sidecarVersion })

    yield* ensureLoopbackNoProxy
    yield* useEnvProxy

    if (sidecarVersion === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() => startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME))
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    const port = yield* Effect.gen(function* () {
      const fromEnv = yield* readEnv("OPENCODE_PORT")
      if (Option.isSome(fromEnv)) {
        const parsed = Number.parseInt(fromEnv.value, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const socket = createServer()
      // Node calls these listeners outside the fiber, so each one completes the Deferred directly.
      socket.on("error", (e) => {
        Deferred.doneUnsafe(res, Effect.fail(e))
      })
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          Deferred.doneUnsafe(res, Effect.fail(new PortError({ message: "Failed to get port" })))
          return
        }
        const port = address.port
        socket.close(() => {
          Deferred.doneUnsafe(res, Effect.succeed(port))
        })
      })

      return yield* Deferred.await(res)
    })
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = Option.some(listener)
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
})

Effect.runFork(main)

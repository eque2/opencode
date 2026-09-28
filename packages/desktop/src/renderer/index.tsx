// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  AppBaseProviders,
  AppInterface,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  createDraftStore,
  ServerConnection,
  useCommand,
  useWslServers,
  useLanguage,
} from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import * as Sentry from "@sentry/solid"
import type { AsyncStorage } from "@solid-primitives/storage"
import { Clock, Data, Effect, MutableHashMap, Option, Result } from "effect"
import { createMemoryHistory, MemoryRouter, type BaseRouterProps } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { t } from "./i18n"
import { initializationData } from "./initialization"
import { DesktopFirstLaunchOnboarding } from "./onboarding"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"
import { windowFullscreen } from "./window-fullscreen"
import { availableStartupServer, readyWslConnections } from "./wsl/connections"
import "./styles.css"
import { Splash } from "@opencode-ai/ui/logo"
import { useTheme } from "@opencode-ai/ui/theme/context"

/** The page has no #root element to mount the desktop renderer into. */
class RootNotFoundError extends Data.TaggedError("Desktop.RootNotFoundError")<{ readonly message: string }> {}

/** The #root element that index.html provides. None when it is missing or not an HTML element. */
const root = Option.liftPredicate(
  document.getElementById("root"),
  (element): element is HTMLElement => element instanceof HTMLElement,
)
// A dev build stops at module load with a readable error when #root is missing.
if (import.meta.env.DEV)
  Option.getOrThrowWith(root, () => new RootNotFoundError({ message: t("desktop.error.dev.rootNotFound") }))

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `desktop@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "desktop",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" &&
          !(
            import.meta.env.OPENCODE_CHANNEL === "prod" &&
            (i.name === "GlobalHandlers" || i.name === "BrowserApiErrors")
          ),
      )
    },
  })
}

const [updaterState, setUpdaterState] = createSignal<UpdaterState>({ status: "disabled" })
void window.api.updater.subscribe(setUpdaterState)

const deepLinkEvent = "opencode:deep-link"

type DesktopWindowState = {
  id?: string
}

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

function windowLastActiveUrlKey(windowID: string) {
  return `opencode.desktop.window.${windowID}.last-active-url`
}

function getLastActiveUrl(windowID: string) {
  if (typeof localStorage !== "object") return "/"
  // getItem can throw when the browser blocks storage; that counts as no stored URL.
  return Result.try(() => localStorage.getItem(windowLastActiveUrlKey(windowID))).pipe(
    Result.getSuccess,
    Option.flatMap(Option.fromNullishOr),
    Option.filter((value) => value.startsWith("/") && !value.startsWith("//")),
    Option.getOrElse(() => "/"),
  )
}

function setLastActiveUrl(windowID: string, value: string) {
  if (typeof localStorage !== "object") return
  // setItem can throw when storage is full or blocked; the URL is then not remembered.
  Result.try(() => localStorage.setItem(windowLastActiveUrlKey(windowID), value))
}

function DesktopMemoryRouter(props: BaseRouterProps & { windowID: string }) {
  const history = createMemoryHistory()
  const initialUrl = getLastActiveUrl(props.windowID)
  if (initialUrl !== "/") history.set({ value: initialUrl, replace: true, scroll: false })
  onCleanup(history.listen((value) => setLastActiveUrl(props.windowID, value)))
  return <MemoryRouter {...props} history={history} />
}

/** The desktop Platform. Its storage is always present and always asynchronous. */
type DesktopPlatform = { storage: (name?: string) => AsyncStorage } & Platform

const createPlatform = (windowState: DesktopWindowState): DesktopPlatform => {
  const attachmentPaths = new WeakMap<File, string>()
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) =>
    Effect.runPromise(
      Effect.gen(function* () {
        switch (action) {
          case "view.resetZoom":
            resetZoom()
            return
          case "view.zoomIn":
            zoomIn()
            return
          case "view.zoomOut":
            zoomOut()
            return
        }

        yield* Effect.promise(() => window.api.runDesktopMenuAction(action))
      }),
    )

  const storage = (() => {
    const cache = MutableHashMap.empty<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: (index: number) =>
          Effect.runPromise(
            Effect.map(
              Effect.promise(() => window.api.storeKeys(name)),
              (keys) => keys[index],
            ),
          ),
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") =>
      Option.getOrElse(MutableHashMap.get(cache, name), () => {
        const api = createStorage(name)
        MutableHashMap.set(cache, name, api)
        return api
      })
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    windowID: windowState.id,

    openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title,
      })
    },

    openAttachmentPickerDialog(opts, onFile) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            window.api.openFilePicker({
              multiple: opts?.multiple ?? false,
              title: opts?.title,
              defaultPath: opts?.defaultPath,
              extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
            }),
          )
          if (!result) return
          // Files are read and handed over one at a time; the picked files are released even when one fails.
          yield* Effect.forEach(
            result.files,
            (file) =>
              Effect.gen(function* () {
                const data = yield* Effect.promise(() => window.api.readPickedFile(result.token, file.path))
                const selected = new File([data], file.name)
                attachmentPaths.set(selected, file.path)
                yield* Effect.promise(() => onFile(selected))
              }),
            { discard: true },
          ).pipe(Effect.ensuring(Effect.promise(() => window.api.releasePickedFiles(result.token))))
        }),
      )
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    },

    openExternal(url: string) {
      window.api.openExternal(url)
    },
    openLocalFile(url: string) {
      window.api.openLocalFile(url)
    },
    openPath(path: string, app?: string) {
      if (os !== "windows") return window.api.openPath(path, app)
      return Effect.runPromise(
        Effect.gen(function* () {
          // A failed or empty resolution opens the path with the default app.
          const resolvedApp = app
            ? yield* Effect.tryPromise(() => window.api.resolveAppPath(app)).pipe(
                Effect.option,
                Effect.map(Option.flatMap(Option.fromNullishOr)),
              )
            : Option.none<string>()
          yield* Effect.promise(() => window.api.openPath(path, Option.getOrUndefined(resolvedApp)))
        }),
      )
    },
    revealPath(path: string) {
      return window.api.revealPath(path)
    },

    storage,
    draftStore: createDraftStore({
      get: window.api.draftGet,
      set: window.api.draftSet,
      remove: window.api.draftDelete,
      putBlob: (blob) =>
        Effect.runPromise(
          Effect.flatMap(
            Effect.promise(() => blob.arrayBuffer()),
            (data) => Effect.promise(() => window.api.draftBlobPut(data)),
          ),
        ),
      getBlob: (id) => window.api.draftBlobGet(id).then((data) => data && new Blob([data])),
    }),

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    setForceFocus: (enabled) => window.api.setForceFocus(enabled),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: () =>
      Effect.runPromise(
        Effect.tryPromise(() => window.api.killSidecar()).pipe(
          // Relaunch even when the sidecar did not stop cleanly.
          Effect.ignore,
          Effect.andThen(Effect.sync(() => window.api.relaunch())),
        ),
      ),

    notify: (title, description, onClick) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const focused = yield* Effect.tryPromise(() => window.api.getWindowFocused()).pipe(
            Effect.orElseSucceed(() => document.hasFocus()),
          )
          if (focused) return

          const notification = new Notification(title, {
            body: description ?? "",
            icon: "https://opencode.ai/favicon-96x96-v3.png",
          })
          notification.onclick = () => {
            void window.api.showWindow()
            void window.api.setWindowFocus()
            onClick?.()
            notification.close()
          }
        }),
      ),

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    // The Platform contract resolves to null for "no default server"; a failed read or an empty URL counts as none.
    getDefaultServer: () =>
      Effect.runPromise(
        Effect.tryPromise(() => window.api.getDefaultServerUrl()).pipe(
          Effect.option,
          Effect.map((url) =>
            url.pipe(
              Option.flatMap(Option.fromNullishOr),
              Option.filter((value) => value !== ""),
              Option.map(ServerConnection.Key.make),
              Option.getOrNull,
            ),
          ),
        ),
      ),

    setDefaultServer: (url: string | null) => window.api.setDefaultServerUrl(url),

    ...(os === "windows" ? { wslServers: window.api.wslServers } : {}),

    // The Platform contract resolves to null for "no preference"; a failed read counts as none.
    getDisplayBackend: () =>
      Effect.runPromise(
        Effect.tryPromise(() => window.api.getDisplayBackend()).pipe(
          Effect.option,
          Effect.map((backend) => Option.getOrNull(Option.flatMap(backend, Option.fromNullishOr))),
        ),
      ),

    setDisplayBackend: (backend) => window.api.setDisplayBackend(backend),

    webviewZoom,

    windowFullscreen,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: (appName: string) => window.api.checkAppExists(appName),

    // The Platform contract resolves to null when the clipboard holds no image; a failed read counts as none.
    readClipboardImage() {
      return Effect.runPromise(
        Effect.gen(function* () {
          const image = yield* Effect.tryPromise(() => window.api.readClipboardImage()).pipe(
            Effect.option,
            Effect.map(Option.flatMap(Option.fromNullishOr)),
          )
          if (Option.isNone(image)) return Option.none<File>()
          const now = yield* Clock.currentTimeMillis
          const blob = new Blob([image.value.buffer], { type: "image/png" })
          return Option.some(
            new File([blob], `pasted-image-${now}.png`, {
              type: "image/png",
            }),
          )
        }).pipe(Effect.map(Option.getOrNull)),
      )
    },
  }
}

let menuTrigger = Option.none<(id: string) => void>()
window.api.onMenuCommand((id) => {
  if (Option.isSome(menuTrigger)) menuTrigger.value(id)
})
listenForDeepLinks()

function LoadingSplash() {
  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <Splash class="w-16 h-20 opacity-50 animate-pulse" />
    </div>
  )
}

function DesktopRoot(props: { windowState: DesktopWindowState }) {
  const platform = createPlatform(props.windowState)
  // The resource resolves to the stored locale, or to no value (AppBaseProviders then keeps its default).
  const loadLocale = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* Effect.promise(() => platform.storage("opencode.global.dat").getItem("language"))
        const raw = current ?? (yield* Effect.promise(() => platform.storage().getItem("language.v1")))
        if (!raw) return Option.none<Locale>()
        const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
        if (!locale) return Option.none<Locale>()
        const next = normalizeLocale(locale)
        if (next !== "en") yield* Effect.promise(() => loadLocaleDict(next))
        return Option.some(next)
      }).pipe(Effect.map(Option.getOrUndefined)),
    )

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() => window.api.awaitInitialization())

  const [defaultServer] = createResource(() => platform.getDefaultServer?.())
  const [locale] = createResource(loadLocale)
  const router = (props: BaseRouterProps) => (
    <DesktopMemoryRouter {...props} windowID={platform.windowID ?? "browser"} />
  )
  const onboarding = Promise.withResolvers<void>()

  function Inner() {
    const cmd = useCommand()
    menuTrigger = Option.some((id: string) => cmd.trigger(id))

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    // eslint-disable-next-line effect/no-null-use-option -- (a) a Solid component returns null to render nothing; Inner only wires the menu and the theme background
    return null
  }

  function App() {
    const wslServers = useWslServers()
    const language = useLanguage()
    const ready = createMemo(
      () => !defaultServer.loading && !sidecar.loading && !locale.loading && !wslServers.isLoading,
    )
    const servers = createMemo(() => {
      const data = initializationData(sidecar)
      const local: ServerConnection.Any[] = data
        ? [
            {
              displayName: language.t("desktop.server.local"),
              type: "sidecar",
              variant: "base",
              http: {
                url: data.url,
                username: Option.getOrUndefined(Option.fromNullishOr(data.username)),
                password: Option.getOrUndefined(Option.fromNullishOr(data.password)),
              },
            },
          ]
        : []
      return [...local, ...readyWslConnections(wslServers.data, language.t("wsl.server.label"))]
    })
    const effectiveDefaultServer = createMemo(() =>
      ServerConnection.Key.make(availableStartupServer(defaultServer.latest, wslServers.data)),
    )
    return (
      <Show when={ready()} fallback={<LoadingSplash />}>
        <Show when={effectiveDefaultServer()} keyed>
          {(key) => (
            <AppInterface
              defaultServer={key}
              servers={servers()}
              router={router}
              startup={onboarding.promise}
              serverScoped={
                <DesktopFirstLaunchOnboarding
                  initialUrl={getLastActiveUrl(platform.windowID ?? "browser")}
                  onLoaded={onboarding.resolve}
                />
              }
            >
              <Inner />
            </AppInterface>
          )}
        </Show>
      </Show>
    )
  }

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders
        locale={locale.latest}
        onNativeTranslations={(bundle) => {
          // A failed hand-over leaves the native menus in their current language.
          Effect.runFork(Effect.tryPromise(() => window.api.setNativeTranslations(bundle)).pipe(Effect.ignore))
        }}
      >
        <Show when={true}>{(_) => <App />}</Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

if (Option.isSome(root)) {
  render(() => {
    const [windowState] = createResource(() => {
      const api = window.api as typeof window.api & {
        getWindowID?: () => Promise<string>
      }
      return Effect.runPromise(
        Option.match(Option.fromNullishOr(api.getWindowID?.()), {
          onNone: () => Effect.succeed<DesktopWindowState>({}),
          onSome: (windowID) =>
            Effect.map(
              Effect.promise(() => windowID),
              (id): DesktopWindowState => ({ id }),
            ),
        }),
      )
    })

    return (
      <Show when={windowState.latest} fallback={<LoadingSplash />} keyed>
        {(state) => <DesktopRoot windowState={state} />}
      </Show>
    )
  }, root.value)
}

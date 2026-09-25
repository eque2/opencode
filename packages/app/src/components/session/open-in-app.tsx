import { createEffect, createMemo } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Data, Effect, Option } from "effect"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"

export const OPEN_APPS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

export type OpenApp = (typeof OPEN_APPS)[number]
export type OpenAppOS = "macos" | "windows" | "linux" | "unknown"

export const MAC_OPEN_APPS = [
  {
    id: "vscode",
    label: "session.header.open.app.vscode",
    icon: "vscode",
    openWith: "Visual Studio Code",
  },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  {
    id: "antigravity",
    label: "session.header.open.app.antigravity",
    icon: "antigravity",
    openWith: "Antigravity",
  },
  { id: "terminal", label: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  {
    id: "android-studio",
    label: "session.header.open.app.androidStudio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

export const WINDOWS_OPEN_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "powershell",
    label: "session.header.open.app.powershell",
    icon: "powershell",
    openWith: "powershell",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

export const LINUX_OPEN_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

export function detectOpenAppOS(platform: ReturnType<typeof usePlatform>): OpenAppOS {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

export function openAppFileManager(os: OpenAppOS) {
  if (os === "macos") return { label: "session.header.open.finder", icon: "finder" as const }
  if (os === "windows") return { label: "session.header.open.fileExplorer", icon: "file-explorer" as const }
  return { label: "session.header.open.fileManager", icon: "finder" as const }
}

export function openAppsForOS(os: OpenAppOS) {
  if (os === "macos") return MAC_OPEN_APPS
  if (os === "windows") return WINDOWS_OPEN_APPS
  return LINUX_OPEN_APPS
}

/** A platform or clipboard request of the "open in" menu that rejected. `message` is shown in the error toast. */
class OpenInAppError extends Data.TaggedError("App.OpenInAppError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const toOpenInAppError = (cause: unknown) =>
  new OpenInAppError({ message: cause instanceof Error ? cause.message : String(cause), cause })

/** Runs a menu request in the background. A defect goes to the Effect logger. */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

/**
 * Runs a request of an optional platform method. A platform without the
 * method returns no Promise from the optional call; then nothing runs and the
 * result is Option.none().
 */
const platformRequest = <A,>(request: () => Promise<A> | undefined) =>
  Effect.suspend(() =>
    Option.match(Option.fromNullishOr(request()), {
      onNone: () => Effect.succeedNone,
      onSome: (pending) =>
        Effect.tryPromise({ try: () => pending, catch: toOpenInAppError }).pipe(Effect.map(Option.some)),
    }),
  )

const showRequestError = (language: ReturnType<typeof useLanguage>, error: OpenInAppError) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: error.message,
  })
}

export function useOpenInApp(input: { directory: () => string }) {
  const platform = usePlatform()
  const server = useServer()
  const language = useLanguage()

  const os = createMemo(() => detectOpenAppOS(platform))
  const apps = createMemo(() => openAppsForOS(os()))
  const fileManager = createMemo(() => openAppFileManager(os()))

  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({
    finder: true,
  })

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const list = apps()

    // Each app is unknown until its check answers; the menu lists only apps marked true.
    setExists(
      produce((draft) => {
        for (const app of list) delete draft[app.id]
      }),
    )

    runDetached(
      Effect.forEach(
        list,
        (app) =>
          platformRequest(() => platform.checkAppExists?.(app.openWith)).pipe(
            Effect.map((found) => Option.getOrElse(found, () => false)),
            Effect.orElseSucceed(() => false),
            Effect.map((ok) => [app.id, ok] as const),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.andThen((entries) =>
          Effect.sync(() =>
            setExists(
              produce((draft) => {
                for (const [id, ok] of entries) draft[id] = ok
              }),
            ),
          ),
        ),
      ),
    )
  })

  const options = createMemo(() => {
    return [
      { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon },
      ...apps()
        .filter((app) => exists[app.id])
        .map((app) => ({ ...app, label: language.t(app.label) })),
    ] as const
  })

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp | "finder" }))
  const [menu, setMenu] = createStore({ open: false })
  const [openRequest, setOpenRequest] = createStore({
    app: Option.none<OpenApp>(),
  })

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const current = createMemo(
    () =>
      options().find((o) => o.id === prefs.app) ??
      options()[0] ??
      ({ id: "finder", label: fileManager().label, icon: fileManager().icon } as const),
  )
  const opening = createMemo(() => Option.isSome(openRequest.app))

  const selectApp = (app: OpenApp | "finder") => {
    if (!options().some((item) => item.id === app)) return
    setPrefs("app", app)
  }

  const openDir = (app: OpenApp | "finder") => {
    if (opening() || !canOpen() || !platform.openPath) return
    const directory = input.directory()
    if (!directory) return

    const item = options().find((o) => o.id === app)
    // The file manager entry has no openWith, so the platform opens the folder with its default app.
    const openWith = item && "openWith" in item ? Option.some(item.openWith) : Option.none<string>()
    setOpenRequest("app", Option.some(app))
    runDetached(
      platformRequest(() =>
        Option.match(openWith, {
          onNone: () => platform.openPath?.(directory),
          onSome: (name) => platform.openPath?.(directory, name),
        }),
      ).pipe(
        Effect.catch((error) => Effect.sync(() => showRequestError(language, error))),
        Effect.ensuring(Effect.sync(() => setOpenRequest("app", Option.none()))),
      ),
    )
  }

  const copyPath = () => {
    const directory = input.directory()
    if (!directory) return
    runDetached(
      Effect.tryPromise({ try: () => navigator.clipboard.writeText(directory), catch: toOpenInAppError }).pipe(
        Effect.andThen(
          Effect.sync(() =>
            showToast({
              variant: "success",
              icon: "circle-check",
              title: language.t("session.share.copy.copied"),
              description: directory,
            }),
          ),
        ),
        Effect.catch((error) => Effect.sync(() => showRequestError(language, error))),
      ),
    )
  }

  return {
    canOpen,
    opening,
    current,
    options,
    menu,
    setMenu,
    openDir,
    selectApp,
    copyPath,
  }
}

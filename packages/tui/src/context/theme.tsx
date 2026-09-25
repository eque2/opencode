import { CliRenderEvents, SyntaxStyle, type TerminalColors } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSubtleSyntax,
  generateSyntax,
  generateSystem,
  hasTheme,
  isTheme,
  resolveTheme,
  selectedForeground,
  setCustomThemes,
  setSystemTheme,
  subscribeThemes,
  terminalMode,
  tint,
  upsertTheme,
  type Theme,
  type ThemeJson,
} from "../theme"
import { Duration, Effect, Fiber, MutableHashSet, Option, Result } from "effect"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useTuiConfig } from "../config"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { readFile } from "node:fs/promises"
import path from "node:path"

export type ThemeSource = Readonly<{
  discover(): Promise<Record<string, unknown>>
  subscribeRefresh?(refresh: () => void): () => void
}>

const themeSource: ThemeSource = {
  async discover() {
    const directories = [Global.Path.config]
    for (let current = process.cwd(); ; current = path.dirname(current)) {
      directories.push(path.join(current, ".opencode"))
      if (path.dirname(current) === current) break
    }
    return discoverThemes(directories)
  },
  subscribeRefresh(refresh) {
    process.on("SIGUSR2", refresh)
    return () => process.off("SIGUSR2", refresh)
  },
}

export async function discoverThemes(directories: string[]) {
  const result: Record<string, unknown> = {}
  for (const directory of directories) {
    const files = await Glob.scan("themes/*.json", { cwd: directory, absolute: true, dot: true, symlink: true })
    for (const file of files) {
      result[path.basename(file, ".json")] = JSON.parse(await readFile(file, "utf8")) as unknown
    }
  }
  return result
}

export {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSubtleSyntax,
  generateSyntax,
  generateSystem,
  hasTheme,
  isTheme,
  resolveTheme,
  selectedForeground,
  terminalMode,
  tint,
  upsertTheme,
  type Theme,
  type ThemeJson,
  type SyntaxStyleOverrides,
} from "../theme"

const THEME_REFRESH_DELAYS = [250, 1000] as const

type Mode = "dark" | "light"

type State = {
  themes: Record<string, ThemeJson>
  mode: Mode
  lock: Option.Option<Mode>
  active: string
  ready: boolean
}

const [store, setStore] = createStore<State>({
  themes: allThemes(),
  mode: "dark",
  lock: Option.none(),
  active: "opencode",
  ready: false,
})

const isMode = (value: unknown): value is Mode => value === "dark" || value === "light"

subscribeThemes((themes) => setStore("themes", themes))

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: Mode; source?: ThemeSource }) => {
    const renderer = useRenderer()
    const config = useTuiConfig()
    const kv = useKV()
    const themes = props.source ?? themeSource
    const pick = (value: unknown): Option.Option<Mode> => Option.liftPredicate(value, isMode)

    // kv keeps the mode lock, and the pinned mode next to it, only while the mode is locked. Both are written from
    // the lock state; an unset key is how kv stores "no value".
    const persistLock = () => kv.set("theme_mode_lock", Option.getOrUndefined(store.lock))
    const persistPinnedMode = () => kv.set("theme_mode", Option.getOrUndefined(Option.as(store.lock, store.mode)))

    setStore(
      produce((draft) => {
        const lock = pick(kv.get("theme_mode_lock"))
        draft.mode = lock.pipe(
          Option.orElse(() => pick(renderer.themeMode)),
          Option.getOrElse(() => props.mode),
        )
        draft.lock = lock
        const active = config.theme ?? kv.get("theme", "opencode")
        draft.active = typeof active === "string" ? active : "opencode"
        draft.ready = false
      }),
    )
    if (Option.isNone(store.lock) && Option.isSome(pick(kv.get("theme_mode")))) persistPinnedMode()

    createEffect(() => {
      const theme = config.theme
      if (theme) setStore("active", theme)
    })

    function syncCustomThemes() {
      return themes
        .discover()
        .then((themes) => {
          setCustomThemes(
            Object.entries(themes).reduce<Record<string, ThemeJson>>((result, [name, theme]) => {
              if (isTheme(theme)) result[name] = theme
              return result
            }, {}),
          )
        })
        .catch(() => setStore("active", "opencode"))
    }

    onMount(() => {
      void Promise.allSettled([resolveSystemTheme(store.mode), syncCustomThemes()]).finally(() => {
        setStore("ready", true)
      })
    })

    let systemThemeSignature: string | undefined
    let systemThemeMode: Mode | undefined
    let hasResolvedSystemTheme = false
    function resolveSystemTheme(mode: Mode = store.mode) {
      return renderer
        .getPalette({ size: 16 })
        .then((colors: TerminalColors) => {
          if (!colors.palette[0]) {
            if (hasResolvedSystemTheme) return
            setSystemTheme(Option.none())
            if (store.active === "system") setStore("active", "opencode")
            return
          }
          const next = Option.getOrElse(store.lock, () => terminalMode(colors) ?? mode)
          if (store.mode !== next) setStore("mode", next)
          const signature = JSON.stringify(colors)
          hasResolvedSystemTheme = true
          if (store.themes.system && systemThemeSignature === signature && systemThemeMode === next) return
          systemThemeSignature = signature
          systemThemeMode = next
          setSystemTheme(Option.some(generateSystem(colors, next)))
        })
        .catch(() => {
          if (hasResolvedSystemTheme) return
          setSystemTheme(Option.none())
          if (store.active === "system") setStore("active", "opencode")
        })
    }

    let systemRefreshRunning = false
    let systemRefreshQueued = false
    let systemRefreshMode = store.mode
    function refreshSystemTheme(mode: Mode = store.mode) {
      systemRefreshMode = mode
      if (systemRefreshRunning) {
        systemRefreshQueued = true
        return
      }

      systemRefreshRunning = true
      const retry = renderer.paletteDetectionStatus === "detecting"
      renderer.clearPaletteCache()
      void resolveSystemTheme(mode).finally(() => {
        systemRefreshRunning = false
        if (!retry && !systemRefreshQueued) return
        systemRefreshQueued = false
        refreshSystemTheme(systemRefreshMode)
      })
    }

    function apply(mode: Mode) {
      const changed = store.mode !== mode
      if (changed) setStore("mode", mode)
      if (Option.isSome(store.lock)) persistPinnedMode()
      if (changed) refreshSystemTheme(mode)
    }

    function pin(mode: Mode = store.mode) {
      setStore("lock", Option.some(mode))
      persistLock()
      apply(mode)
    }

    function free() {
      setStore("lock", Option.none())
      persistLock()
      persistPinnedMode()
      refreshSystemTheme(renderer.themeMode ?? store.mode)
    }

    const handle = (mode: Mode) => {
      if (Option.isSome(store.lock)) return
      apply(mode)
    }
    renderer.on(CliRenderEvents.THEME_MODE, handle)

    const handleThemeNotification = (sequence: string) => {
      if (sequence !== "\x1b[?997;1n" && sequence !== "\x1b[?997;2n") return false
      queueMicrotask(() => refreshSystemTheme())
      return false
    }
    renderer.prependInputHandler(handleThemeNotification)

    // A refresh request re-reads the terminal palette after each delay, and the custom theme files after the last
    // one. The delays run side by side in one fiber, and a new request interrupts it and starts again.
    let refreshFiber: Option.Option<Fiber.Fiber<void>> = Option.none()
    const interruptRefresh = () => {
      if (Option.isSome(refreshFiber)) Effect.runFork(Fiber.interrupt(refreshFiber.value))
      refreshFiber = Option.none()
    }
    const lastRefreshDelay = THEME_REFRESH_DELAYS[THEME_REFRESH_DELAYS.length - 1]
    const refresh = () => {
      interruptRefresh()
      refreshFiber = Option.some(
        Effect.runFork(
          Effect.forEach(
            THEME_REFRESH_DELAYS,
            (delay) =>
              Effect.sleep(Duration.millis(delay)).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    refreshSystemTheme()
                    if (delay === lastRefreshDelay) void syncCustomThemes()
                  }),
                ),
              ),
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.tapDefect((defect) => Effect.logError(defect))),
        ),
      )
    }
    let unsubscribeRefresh: (() => void) | undefined
    unsubscribeRefresh = themes.subscribeRefresh?.(refresh)

    onCleanup(() => {
      renderer.off(CliRenderEvents.THEME_MODE, handle)
      renderer.removeInputHandler(handleThemeNotification)
      unsubscribeRefresh?.()
      interruptRefresh()
    })

    // Resolves a known theme. A theme whose colors do not resolve is logged and skipped, so the next choice applies.
    const tryResolve = (name: string): Option.Option<Theme> => {
      const theme = store.themes[name]
      if (!theme) return Option.none()
      return Result.match(resolveTheme(theme, store.mode), {
        onSuccess: Option.some,
        onFailure: (error) => {
          Effect.runFork(Effect.logWarning("Theme colors do not resolve", { theme: name, error: error.message }))
          return Option.none()
        },
      })
    }

    // The active theme, else the saved theme, else opencode. The bundled opencode theme always resolves
    // (theme.test.ts checks every bundled theme), so a failure there is a defect in the bundled asset.
    const values = createMemo(() =>
      tryResolve(store.active).pipe(
        Option.orElse(() => {
          const saved = kv.get("theme")
          return typeof saved === "string" ? tryResolve(saved) : Option.none()
        }),
        Option.orElse(() => tryResolve("opencode")),
        Option.getOrElse(() => Result.getOrThrow(resolveTheme(DEFAULT_THEMES.opencode, store.mode))),
      ),
    )

    createEffect(() => renderer.setBackgroundColor(values().background))

    const syntax = createSyntaxStyleMemo(() => generateSyntax(values()))
    const subtleSyntax = createSyntaxStyleMemo(() => generateSubtleSyntax(values()))

    return {
      theme: new Proxy(values(), {
        get(_target, prop) {
          // @ts-expect-error Properties are forwarded to the current reactive value.
          return values()[prop]
        },
      }),
      get selected() {
        return store.active
      },
      all: allThemes,
      has: hasTheme,
      syntax,
      subtleSyntax,
      mode: () => store.mode,
      locked: () => Option.isSome(store.lock),
      lock: () => pin(store.mode),
      unlock: free,
      setMode: pin,
      set(theme: string) {
        if (!hasTheme(theme)) return false
        setStore("active", theme)
        kv.set("theme", theme)
        return true
      },
      get ready() {
        return store.ready
      },
    }
  },
})

export function createSyntaxStyleMemo(factory: () => SyntaxStyle) {
  const renderer = useRenderer()
  const retained = MutableHashSet.empty<SyntaxStyle>()
  let current: SyntaxStyle | undefined

  const release = (style: SyntaxStyle) => {
    MutableHashSet.add(retained, style)
    void renderer
      .idle()
      .catch(() => {})
      .finally(() => {
        if (!MutableHashSet.has(retained, style)) return
        MutableHashSet.remove(retained, style)
        style.destroy()
      })
  }

  onCleanup(() => {
    if (current) release(current)
  })

  return createMemo(() => {
    const previous = current
    current = factory()
    if (previous) release(previous)
    return current
  })
}

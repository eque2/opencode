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
import { Duration, Effect, Fiber, FileSystem, MutableHashSet, Option, Result, Schema } from "effect"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"
import { useTuiConfig } from "../config"
import { Global } from "@opencode-ai/core/global"
import { Glob } from "@opencode-ai/core/util/glob"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "node:path"

/** Listing or reading the custom theme files failed. */
export class ThemeDiscoveryError extends Schema.TaggedError<ThemeDiscoveryError>()("TuiTheme.DiscoveryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type ThemeSource = Readonly<{
  /** The custom theme files by name, as parsed JSON. */
  discover: Effect.Effect<Record<string, unknown>, ThemeDiscoveryError>
  subscribeRefresh?(refresh: () => void): () => void
}>

const filesystem = LayerNode.compile(LayerNodePlatform.filesystem)

// The .opencode directory in `directory` and in each of its ancestors, nearest first.
function projectConfigDirectories(directory: string): ReadonlyArray<string> {
  const parent = path.dirname(directory)
  const own = path.join(directory, ".opencode")
  return parent === directory ? [own] : [own, ...projectConfigDirectories(parent)]
}

const themeSource: ThemeSource = {
  discover: Effect.suspend(() =>
    discoverThemes([Global.Path.config, ...projectConfigDirectories(process.cwd())]),
  ).pipe(Effect.provide(filesystem)),
  subscribeRefresh(refresh) {
    process.on("SIGUSR2", refresh)
    return () => process.off("SIGUSR2", refresh)
  },
}

// Theme files are untyped JSON here; isTheme checks each one before it is used.
const decodeThemeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** Reads `themes/*.json` in each directory. A later directory wins for the same theme name. */
export const discoverThemes = Effect.fn("TuiTheme.discoverThemes")(function* (directories: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const found = yield* Effect.forEach(directories, (directory) =>
    Effect.tryPromise({
      try: () => Glob.scan("themes/*.json", { cwd: directory, absolute: true, dot: true, symlink: true }),
      catch: (cause) => new ThemeDiscoveryError({ message: `Failed to list the themes in ${directory}`, cause }),
    }).pipe(
      Effect.flatMap((files) =>
        Effect.forEach(files, (file) =>
          fs.readFileString(file).pipe(
            Effect.flatMap(decodeThemeFile),
            Effect.map((theme): readonly [string, unknown] => [path.basename(file, ".json"), theme]),
            Effect.mapError((cause) => new ThemeDiscoveryError({ message: `Failed to read the theme ${file}`, cause })),
          ),
        ),
      ),
    ),
  )
  return Object.fromEntries(found.flat())
})

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

// The JSON text of the terminal colors. An unchanged signature skips regenerating the system theme; the colors are
// untyped JSON here, so the text matches JSON.stringify.
const encodePaletteSignature = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
      return Effect.runPromise(themes.discover)
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
          const signature = encodePaletteSignature(colors)
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

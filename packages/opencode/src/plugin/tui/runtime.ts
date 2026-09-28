import { runtimeModules as keymapRuntimeModules } from "@opentui/keymap/runtime-modules"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import {
  type TuiDispose,
  type TuiPlugin,
  type TuiPluginApi,
  type TuiPluginInstallResult,
  type TuiPluginModule,
  type TuiPluginMeta,
  type TuiPluginStatus,
  type TuiSlotPlugin,
  type TuiTheme,
} from "@opencode-ai/plugin/tui"
import path from "path"
import { fileURLToPath } from "url"
import { TuiConfig } from "@/config/tui"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { errorData, errorMessage } from "@opencode-ai/tui/util/error"
import { isRecord } from "@opencode-ai/tui/util/record"
import { resolveHostAttentionSoundPaths } from "@/config/tui-host-attention"
import {
  packageThemes,
  readPluginId,
  readV1Plugin,
  resolvePluginId,
  type PluginPackage,
  type PluginSource,
} from "@/plugin/shared"
import { PluginLoader } from "@/plugin/loader"
import { PluginMeta } from "@/plugin/meta"
import { installPlugin as installModulePlugin, patchPluginConfig, readPluginManifest } from "@/plugin/install"
import { hasTheme, upsertTheme } from "@opencode-ai/tui/context/theme"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { Flock } from "@opencode-ai/core/util/flock"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { internalTuiPlugins, type InternalTuiPlugin } from "./internal"
import type { HostPluginApi, HostSlots } from "@opencode-ai/tui/plugin/slots"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { createCommandShim } from "@opencode-ai/tui/plugin/command-shim"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Cause, Clock, Console, Duration, Effect, HashSet, MutableHashMap, Option, Predicate, Result, Schema } from "effect"
import { createPluginRuntime, type PluginRuntime, type TuiPluginHost } from "@opencode-ai/tui/plugin/runtime"

ensureRuntimePluginSupport({ additional: keymapRuntimeModules })

type PluginLoad = {
  options: Option.Option<ConfigPluginV1.Options>
  spec: string
  target: string
  retry: boolean
  source: PluginSource | "internal"
  id: string
  module: TuiPluginModule
  origin: ConfigPlugin.Origin
  plugin_root: string
  theme_files: string[]
}

type Api = HostPluginApi

type PluginScope = {
  lifecycle: TuiPluginApi["lifecycle"]
  track: (fn: () => void) => () => void
  dispose: Effect.Effect<void>
}

type PluginEntry = {
  id: string
  load: PluginLoad
  meta: TuiPluginMeta
  themes: Record<string, PluginMeta.Theme>
  plugin: TuiPlugin
  enabled: boolean
  scope: Option.Option<PluginScope>
}

// A plugin step failed: plugin code threw or rejected, or a plugin file could not be read.
export class PluginStepError extends Schema.TaggedError<PluginStepError>()("TuiPluginRuntime.PluginStepError", {
  cause: Schema.Defect(),
}) {}

export class InitDirectoryError extends Schema.TaggedError<InitDirectoryError>()(
  "TuiPluginRuntime.InitDirectoryError",
  { message: Schema.String },
) {}

const ScopedKeymapMethods = HashSet.fromIterable<PropertyKey>([
  "acquireResource",
  "registerLayer",
  "registerLayerFields",
  "prependLayerBindingsTransformer",
  "appendLayerBindingsTransformer",
  "prependBindingTransformer",
  "appendBindingTransformer",
  "prependBindingParser",
  "appendBindingParser",
  "registerToken",
  "registerSequencePattern",
  "prependBindingExpander",
  "appendBindingExpander",
  "registerBindingFields",
  "registerCommandFields",
  "prependCommandTransformer",
  "appendCommandTransformer",
  "prependCommandResolver",
  "appendCommandResolver",
  "prependLayerAnalyzer",
  "appendLayerAnalyzer",
  "intercept",
  "on",
  "prependEventMatchResolver",
  "appendEventMatchResolver",
  "prependDisambiguationResolver",
  "appendDisambiguationResolver",
])

type RuntimeState = {
  directory: string
  api: Api
  view: PluginRuntime
  dispose?: () => void
  slots: HostSlots
  plugins: PluginEntry[]
  plugins_by_id: MutableHashMap.MutableHashMap<string, PluginEntry>
  pending: MutableHashMap.MutableHashMap<string, ConfigPlugin.Origin>
  dispose_timeout_ms: number
}

const DISPOSE_TIMEOUT_MS = 5000
const KV_KEY = "plugin_enabled"
const EMPTY_TUI: TuiPluginModule = {
  // The plugin contract returns a Promise; a theme-only package has no TUI work to run.
  tui: () => Effect.runPromise(Effect.void),
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const fileSystemLayer = LayerNode.compile(FSUtil.node)

// The TUI host and the plugin API take Promise callbacks. Each Promise edge provides the filesystem layer to its own run.
function runPromise<A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(fileSystemLayer)))
}

const attempt = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PluginStepError({ cause }) })

const attemptSync = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new PluginStepError({ cause }) })

// Plugin callbacks return a Promise or a plain value. Settle both, and keep the thrown value as the cause.
const settle = (run: () => unknown) =>
  attemptSync(run).pipe(
    Effect.flatMap((out) => (Predicate.isPromiseLike(out) ? attempt(() => out) : Effect.void)),
    Effect.asVoid,
  )

const isDisposer = (value: unknown): value is () => void => typeof value === "function"

const isTuiModule = (value: Record<string, unknown>): value is Record<string, unknown> & TuiPluginModule =>
  typeof value.tui === "function"

function fail(message: string, data: Record<string, unknown>) {
  if (!("error" in data)) return Console.error(`[tui.plugin] ${message}`, data)

  const text = `${message}: ${errorMessage(data.error)}`
  const next = { ...data, error: errorData(data.error) }
  return Console.error(`[tui.plugin] ${text}`, next)
}

function warn(message: string, data: Record<string, unknown>) {
  return Console.warn(`[tui.plugin] ${message}`, data)
}

function createScopedKeymap(keymap: TuiPluginApi["keymap"], scope: PluginScope): TuiPluginApi["keymap"] {
  const cache = MutableHashMap.empty<PropertyKey, unknown>()
  return new Proxy(keymap, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== "function") return value
      const hit = MutableHashMap.get(cache, prop)
      if (Option.isSome(hit)) return hit.value
      const fn = HashSet.has(ScopedKeymapMethods, prop)
        ? (...args: unknown[]) => {
            const dispose: unknown = Reflect.apply(value, target, args)
            return isDisposer(dispose) ? scope.track(dispose) : () => {}
          }
        : (...args: unknown[]): unknown => Reflect.apply(value, target, args)
      MutableHashMap.set(cache, prop, fn)
      return fn
    },
  })
}

function createScopedAttention(
  attention: TuiPluginApi["attention"],
  scope: PluginScope,
  root: string,
): TuiPluginApi["attention"] {
  return {
    notify(input) {
      return attention.notify(input)
    },
    soundboard: {
      registerPack(pack) {
        return scope.track(
          attention.soundboard.registerPack({
            ...pack,
            sounds: resolveHostAttentionSoundPaths(root, pack.sounds, { trim: true }),
          }),
        )
      },
      activate(id, options) {
        return attention.soundboard.activate(id, options)
      },
      current() {
        return attention.soundboard.current()
      },
      list() {
        return attention.soundboard.list()
      },
    },
  }
}

function createScopedMode(mode: TuiPluginApi["mode"], scope: PluginScope): TuiPluginApi["mode"] {
  return {
    current() {
      return mode.current()
    },
    push(value) {
      return scope.track(mode.push(value))
    },
  }
}

// Success holds `Option.none()` when the cleanup did not settle within the time limit.
function runCleanup(fn: TuiDispose, ms: number) {
  return settle(fn).pipe(Effect.timeoutOption(Duration.millis(ms)), Effect.result)
}

function isTheme(value: unknown) {
  if (!isRecord(value)) return false
  if (!("theme" in value)) return false
  if (!isRecord(value.theme)) return false
  return true
}

function resolveRoot(root: string) {
  if (root.startsWith("file://")) {
    const file = fileURLToPath(root)
    if (root.endsWith("/")) return file
    return path.dirname(file)
  }
  if (path.isAbsolute(root)) return root
  return path.resolve(process.cwd(), root)
}

const installTheme = Effect.fn("TuiPluginRuntime.installTheme")(function* (
  meta: ConfigPlugin.Origin,
  root: string,
  plugin: PluginEntry,
  file: string,
) {
  const fsu = yield* FSUtil.Service
  const raw = file.startsWith("file://") ? fileURLToPath(file) : file
  const src = path.isAbsolute(raw) ? raw : path.resolve(root, raw)
  const name = path.basename(src, path.extname(src))
  const source_dir = path.dirname(meta.source)
  const local_dir =
    path.basename(source_dir) === ".opencode"
      ? path.join(source_dir, "themes")
      : path.join(source_dir, ".opencode", "themes")
  const dest_dir = meta.scope === "local" ? local_dir : path.join(Global.Path.config, "themes")
  const dest = path.join(dest_dir, `${name}.json`)
  // A stat failure other than a missing file is a defect: the install call rejects with it.
  const stat = yield* fsu.stat(src).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.orDie,
  )
  // The Date time of the stat is the floor of its sub-millisecond mtimeMs.
  const info: PluginMeta.Theme = {
    src,
    dest,
    ...Option.match(stat, {
      onNone: () => ({}),
      onSome: (value) => ({
        ...Option.match(value.mtime, { onNone: () => ({}), onSome: (date) => ({ mtime: date.getTime() }) }),
        size: Number(value.size),
      }),
    }),
  }

  const save = Effect.gen(function* () {
    plugin.themes[name] = info
    yield* PluginMeta.setTheme(plugin.id, name, info).pipe(Effect.catchCause(() => Effect.void))
  })

  const write = Effect.gen(function* () {
    const exists = hasTheme(name)
    const prev = Option.fromNullishOr(plugin.themes[name])
    if (exists) {
      if (plugin.meta.state !== "updated") {
        if (Option.isNone(prev) && (yield* fsu.existsSafe(dest))) yield* save
        return
      }
      if (
        Option.isSome(prev) &&
        prev.value.dest === dest &&
        prev.value.mtime === info.mtime &&
        prev.value.size === info.size
      )
        return
    }

    const text = yield* Effect.option(fsu.readFileString(src))
    if (Option.isNone(text)) return

    const data = decodeJson(text.value)
    if (Option.isNone(data)) return
    if (!isTheme(data.value)) return

    if (exists || !(yield* fsu.existsSafe(dest))) {
      yield* Effect.ignore(fsu.writeWithDirs(dest, text.value))
    }

    upsertTheme(name, data.value)
    yield* save
  })

  // A lock or write failure leaves the theme uninstalled without failing the plugin.
  yield* Effect.scoped(Flock.effect(`tui-theme:${dest}`).pipe(Effect.andThen(write))).pipe(
    Effect.catchCause(() => Effect.void),
  )
})

function createThemeInstaller(meta: ConfigPlugin.Origin, root: string, plugin: PluginEntry): TuiTheme["install"] {
  return (file) => runPromise(installTheme(meta, root, plugin, file))
}

const createMeta = Effect.fn("TuiPluginRuntime.createMeta")(function* (
  source: PluginLoad["source"],
  spec: string,
  target: string,
  meta: Option.Option<PluginMeta.Hit>,
  id: string,
) {
  if (Option.isSome(meta)) {
    return {
      state: meta.value.state,
      ...meta.value.entry,
    } satisfies TuiPluginMeta
  }

  const now = yield* Clock.currentTimeMillis
  return {
    state: source === "internal" ? "same" : "first",
    id,
    source,
    spec,
    target,
    first_time: now,
    last_time: now,
    time_changed: now,
    load_count: 1,
    fingerprint: target,
  } satisfies TuiPluginMeta
})

function loadInternalPlugin(item: InternalTuiPlugin): PluginLoad {
  const spec = item.id
  const target = spec

  return {
    options: Option.none(),
    spec,
    target,
    retry: false,
    source: "internal",
    id: item.id,
    module: item,
    origin: {
      spec,
      scope: "global",
      source: target,
    },
    plugin_root: process.cwd(),
    theme_files: [],
  }
}

function readThemeFiles(spec: string, pkg?: PluginPackage) {
  if (!pkg) return Effect.succeed<string[]>([])
  // Any failure, a realpath defect included, skips the themes with a warning, as the sync throw did before.
  return packageThemes(spec, pkg).pipe(
    Effect.catchCause((cause) =>
      warn("invalid tui plugin oc-themes", {
        path: spec,
        pkg: pkg.pkg,
        error: Cause.squash(cause),
      }).pipe(Effect.as<string[]>([])),
    ),
  )
}

const syncPluginThemes = Effect.fn("TuiPluginRuntime.syncPluginThemes")(function* (plugin: PluginEntry) {
  if (!plugin.load.theme_files.length) return
  if (plugin.meta.state === "same") return
  for (const file of plugin.load.theme_files) {
    yield* installTheme(plugin.load.origin, plugin.load.plugin_root, plugin, file).pipe(
      Effect.catchCause((cause) =>
        warn("failed to sync tui plugin oc-themes", {
          path: plugin.load.spec,
          id: plugin.id,
          theme: file,
          error: Cause.squash(cause),
        }),
      ),
    )
  }
})

function createPluginScope(load: PluginLoad, id: string, disposeTimeoutMs: number): PluginScope {
  const ctrl = new AbortController()
  let queue: ReadonlyArray<{ key: symbol; fn: TuiDispose }> = []
  let done = false

  const onDispose = (fn: TuiDispose) => {
    if (done) return () => {}
    const key = Symbol()
    queue = [...queue, { key, fn }]
    let drop = false
    return () => {
      if (drop) return
      drop = true
      queue = queue.filter((x) => x.key !== key)
    }
  }

  const track = (fn: () => void) => {
    let drop = false
    let off = () => {}
    const wrapped = () => {
      if (drop) return
      drop = true
      off()
      fn()
    }
    off = onDispose(wrapped)
    return wrapped
  }

  const lifecycle: TuiPluginApi["lifecycle"] = {
    signal: ctrl.signal,
    onDispose,
  }

  const timedOut = fail("timed out cleaning up tui plugin", {
    path: load.spec,
    id,
    timeout: disposeTimeoutMs,
  })

  const dispose = Effect.gen(function* () {
    if (done) return
    done = true
    ctrl.abort()
    const pending = [...queue].reverse()
    queue = []
    const until = (yield* Clock.currentTimeMillis) + disposeTimeoutMs
    for (const item of pending) {
      const left = until - (yield* Clock.currentTimeMillis)
      if (left <= 0) {
        yield* timedOut
        break
      }

      const out = yield* runCleanup(item.fn, left)
      if (Result.isFailure(out)) {
        yield* fail("failed to clean up tui plugin", {
          path: load.spec,
          id,
          error: out.failure.cause,
        })
        continue
      }
      if (Option.isNone(out.success)) {
        yield* timedOut
        break
      }
    }
  })

  return {
    lifecycle,
    track,
    dispose,
  }
}

function readPluginEnabledMap(value: unknown) {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((item): item is [string, boolean] => typeof item[1] === "boolean"),
  )
}

function pluginEnabledState(state: RuntimeState, config: TuiConfig.Resolved) {
  return {
    ...readPluginEnabledMap(config.plugin_enabled),
    ...readPluginEnabledMap(state.api.kv.get(KV_KEY, {})),
  }
}

function writePluginEnabledState(api: Api, id: string, enabled: boolean) {
  api.kv.set(KV_KEY, {
    ...readPluginEnabledMap(api.kv.get(KV_KEY, {})),
    [id]: enabled,
  })
}

function listPluginStatus(state: RuntimeState): TuiPluginStatus[] {
  return state.plugins.map((plugin) => ({
    id: plugin.id,
    source: plugin.meta.source,
    spec: plugin.meta.spec,
    target: plugin.meta.target,
    enabled: plugin.enabled,
    active: Option.isSome(plugin.scope),
  }))
}

const deactivatePluginEntry = Effect.fn("TuiPluginRuntime.deactivatePluginEntry")(function* (
  state: RuntimeState,
  plugin: PluginEntry,
  persist: boolean,
) {
  plugin.enabled = false
  if (persist) writePluginEnabledState(state.api, plugin.id, false)
  const scope = plugin.scope
  plugin.scope = Option.none()
  if (Option.isSome(scope)) yield* scope.value.dispose
  state.view.update({ status: listPluginStatus(state) })
  return true
})

const activatePluginEntry = Effect.fn("TuiPluginRuntime.activatePluginEntry")(function* (
  state: RuntimeState,
  plugin: PluginEntry,
  persist: boolean,
) {
  plugin.enabled = true
  if (persist) writePluginEnabledState(state.api, plugin.id, true)
  if (Option.isSome(plugin.scope)) {
    state.view.update({ status: listPluginStatus(state) })
    return true
  }

  const scope = createPluginScope(plugin.load, plugin.id, state.dispose_timeout_ms)
  const api = pluginApi(state, plugin, scope, plugin.id)
  const ok = yield* syncPluginThemes(plugin).pipe(
    // The plugin contract takes `undefined` when a plugin has no options.
    Effect.andThen(settle(() => plugin.plugin(api, Option.getOrUndefined(plugin.load.options), plugin.meta))),
    Effect.as(true),
    Effect.catch((error) =>
      fail("failed to initialize tui plugin", {
        path: plugin.load.spec,
        id: plugin.id,
        error: error.cause,
      }).pipe(Effect.as(false)),
    ),
  )

  if (!ok) {
    yield* scope.dispose
    state.view.update({ status: listPluginStatus(state) })
    return false
  }

  if (!plugin.enabled) {
    yield* scope.dispose
    state.view.update({ status: listPluginStatus(state) })
    return true
  }

  plugin.scope = Option.some(scope)
  state.view.update({ status: listPluginStatus(state) })
  return true
})

function activatePluginById(state: RuntimeState, id: string, persist: boolean) {
  return Option.match(MutableHashMap.get(state.plugins_by_id, id), {
    onNone: () => Effect.succeed(false),
    onSome: (plugin) => activatePluginEntry(state, plugin, persist),
  })
}

function deactivatePluginById(state: RuntimeState, id: string, persist: boolean) {
  return Option.match(MutableHashMap.get(state.plugins_by_id, id), {
    onNone: () => Effect.succeed(false),
    onSome: (plugin) => deactivatePluginEntry(state, plugin, persist),
  })
}

function pluginApi(runtime: RuntimeState, plugin: PluginEntry, scope: PluginScope, base: string): TuiPluginApi {
  const api = runtime.api
  const host = runtime.slots
  const load = plugin.load

  const route: TuiPluginApi["route"] = {
    register(list) {
      return scope.track(api.route.register(list))
    },
    navigate(name, params) {
      api.route.navigate(name, params)
    },
    get current() {
      return api.route.current
    },
  }

  const theme: TuiPluginApi["theme"] = Object.assign(Object.create(api.theme), {
    install: createThemeInstaller(load.origin, load.plugin_root, plugin),
  })

  const event: TuiPluginApi["event"] = {
    on(type, handler) {
      return scope.track(api.event.on(type, handler))
    },
  }

  const keymap = createScopedKeymap(api.keymap, scope)

  let count = 0

  const slots: TuiPluginApi["slots"] = {
    register(plugin: TuiSlotPlugin) {
      const id = count ? `${base}:${count}` : base
      count += 1
      scope.track(host.register({ ...plugin, id }))
      return id
    },
  }

  // The plugins API is part of the Promise-based plugin contract.
  return {
    app: api.app,
    attention: createScopedAttention(api.attention, scope, load.plugin_root),
    // Keep deprecated `api.command` working for v1 plugins; remove in v2.
    command: createCommandShim(keymap, api.ui.dialog, api.tuiConfig.keybinds),
    keys: api.keys,
    keymap,
    mode: createScopedMode(api.mode, scope),
    route,
    ui: api.ui,
    tuiConfig: api.tuiConfig,
    kv: api.kv,
    state: api.state,
    theme,
    get client() {
      return api.client
    },
    event,
    renderer: api.renderer,
    slots,
    plugins: {
      list() {
        return listPluginStatus(runtime)
      },
      activate(id) {
        return runPromise(activatePluginById(runtime, id, true))
      },
      deactivate(id) {
        return runPromise(deactivatePluginById(runtime, id, true))
      },
      add(spec) {
        return runPromise(addPluginBySpec(runtime, spec))
      },
      install(spec, options) {
        return runPromise(installPluginBySpec(runtime, spec, options?.global))
      },
    },
    lifecycle: scope.lifecycle,
  }
}

const addPluginEntry = Effect.fn("TuiPluginRuntime.addPluginEntry")(function* (
  state: RuntimeState,
  plugin: PluginEntry,
) {
  if (MutableHashMap.has(state.plugins_by_id, plugin.id)) {
    yield* fail("duplicate tui plugin id", {
      id: plugin.id,
      path: plugin.load.spec,
    })
    return false
  }

  MutableHashMap.set(state.plugins_by_id, plugin.id, plugin)
  state.plugins = [...state.plugins, plugin]
  return true
})

function applyInitialPluginEnabledState(state: RuntimeState, config: TuiConfig.Resolved) {
  const map = pluginEnabledState(state, config)
  for (const plugin of state.plugins) {
    const enabled = map[plugin.id]
    if (enabled === undefined) continue
    plugin.enabled = enabled
  }
}

const finishExternalPlugin = Effect.fn("TuiPluginRuntime.finishExternalPlugin")(function* (
  loaded: PluginLoader.Loaded,
  origin: ConfigPlugin.Origin,
  retry: boolean,
) {
  const mod = yield* attemptSync(() => readV1Plugin(loaded.mod, loaded.spec, "tui")).pipe(
    Effect.map((value) => Option.filter(Option.fromNullishOr(value), isTuiModule)),
    Effect.catch((error) =>
      fail("failed to load tui plugin", {
        path: loaded.spec,
        target: loaded.entry,
        retry,
        error: error.cause,
      }).pipe(Effect.as(Option.none())),
    ),
  )
  if (Option.isNone(mod)) return Option.none<PluginLoad>()

  // An invalid id export is a defect of this load attempt, as it was before the id lookup.
  const declared = readPluginId(mod.value.id, loaded.spec)
  const id = yield* attempt(() => resolvePluginId(loaded.source, loaded.spec, loaded.target, declared, loaded.pkg)).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      fail("failed to load tui plugin", {
        path: loaded.spec,
        target: loaded.target,
        retry,
        error: error.cause,
      }).pipe(Effect.as(Option.none<string>())),
    ),
  )
  if (Option.isNone(id) || !id.value) return Option.none<PluginLoad>()

  const theme_files = yield* readThemeFiles(loaded.spec, loaded.pkg)

  return Option.some<PluginLoad>({
    options: Option.fromNullishOr(loaded.options),
    spec: loaded.spec,
    target: loaded.target,
    retry,
    source: loaded.source,
    id: id.value,
    module: mod.value,
    origin,
    plugin_root: loaded.pkg?.dir ?? resolveRoot(loaded.target),
    theme_files,
  })
})

const missingExternalPlugin = Effect.fn("TuiPluginRuntime.missingExternalPlugin")(function* (
  loaded: PluginLoader.Missing,
  origin: ConfigPlugin.Origin,
  retry: boolean,
) {
  const theme_files = yield* readThemeFiles(loaded.spec, loaded.pkg)
  if (!theme_files.length) return Option.none<PluginLoad>()

  const name = Option.fromNullishOr(loaded.pkg?.json.name).pipe(
    Option.filter(Predicate.isString),
    Option.map((value) => value.trim()),
    Option.filter((value) => value.length > 0),
  )
  const id = yield* attempt(() =>
    // The shared resolver takes `undefined` when the package has no usable name.
    resolvePluginId(loaded.source, loaded.spec, loaded.target, Option.getOrUndefined(name), loaded.pkg),
  ).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      fail("failed to load tui plugin", {
        path: loaded.spec,
        target: loaded.target,
        retry,
        error: error.cause,
      }).pipe(Effect.as(Option.none<string>())),
    ),
  )
  if (Option.isNone(id) || !id.value) return Option.none<PluginLoad>()

  return Option.some<PluginLoad>({
    options: Option.fromNullishOr(loaded.options),
    spec: loaded.spec,
    target: loaded.target,
    retry,
    source: loaded.source,
    id: id.value,
    module: EMPTY_TUI,
    origin,
    plugin_root: loaded.pkg?.dir ?? resolveRoot(loaded.target),
    theme_files,
  })
})

// The loader takes Promise callbacks; each one runs its Effect at this edge.
function resolveExternalPlugins(list: ConfigPlugin.Origin[]) {
  return attempt(() =>
    PluginLoader.loadExternal<PluginLoad>({
      items: list,
      kind: "tui",
      wait: () => Effect.runPromise(Effect.ignore(attempt(() => TuiConfig.waitForDependencies()))),
      finish: (loaded, origin, retry) =>
        runPromise(finishExternalPlugin(loaded, origin, retry).pipe(Effect.map(Option.getOrUndefined))),
      missing: (loaded, origin, retry) =>
        runPromise(missingExternalPlugin(loaded, origin, retry).pipe(Effect.map(Option.getOrUndefined))),
      report: {
        start() {},
        missing(candidate, retry, message) {
          Effect.runFork(warn("tui plugin has no entrypoint", { path: candidate.plan.spec, retry, message }))
        },
        error(candidate, retry, stage, error, resolved) {
          const spec = candidate.plan.spec
          if (stage === "install") {
            Effect.runFork(fail("failed to resolve tui plugin", { path: spec, retry, error }))
            return
          }
          if (stage === "compatibility") {
            Effect.runFork(fail("tui plugin incompatible", { path: spec, retry, error }))
            return
          }
          if (stage === "entry") {
            Effect.runFork(fail("failed to resolve tui plugin entry", { path: spec, retry, error }))
            return
          }
          Effect.runFork(fail("failed to load tui plugin", { path: spec, target: resolved?.entry, retry, error }))
        },
      },
    }),
  )
}

const addExternalPluginEntries = Effect.fn("TuiPluginRuntime.addExternalPluginEntries")(function* (
  state: RuntimeState,
  ready: ReadonlyArray<PluginLoad>,
) {
  if (!ready.length) return { plugins: [], ok: true }

  const meta = yield* PluginMeta.touchMany(
    ready.map((item) => ({
      spec: item.spec,
      target: item.target,
      id: item.id,
    })),
  ).pipe(
    Effect.map(Option.some),
    Effect.catchCause(() => Effect.succeed(Option.none())),
  )

  const added = yield* Effect.forEach(ready, (entry, i) =>
    Effect.gen(function* () {
      const hit = Option.flatMap(meta, (hits) => Option.fromNullishOr(hits[i]))
      const info = yield* createMeta(entry.source, entry.spec, entry.target, hit, entry.id)
      const plugin: PluginEntry = {
        id: entry.id,
        load: entry,
        meta: info,
        themes: Option.match(hit, {
          onNone: () => ({}),
          onSome: (value) => ({ ...value.entry.themes }),
        }),
        plugin: entry.module.tui,
        enabled: true,
        scope: Option.none(),
      }
      return { plugin, ok: yield* addPluginEntry(state, plugin) }
    }),
  )

  return {
    plugins: added.filter((item) => item.ok).map((item) => item.plugin),
    ok: added.every((item) => item.ok),
  }
})

function defaultPluginOrigin(state: RuntimeState, spec: string): ConfigPlugin.Origin {
  return {
    spec,
    scope: "local",
    source: state.api.state.path.config || path.join(state.directory, ".opencode", "tui.json"),
  }
}

function installCause(err: unknown) {
  if (!err || typeof err !== "object") return Option.none()
  if (!("cause" in err)) return Option.none()
  return Option.fromNullishOr(err.cause)
}

function installDetail(err: unknown) {
  const hit = Option.getOrElse(installCause(err), () => err)
  if (!(hit instanceof AppProcess.AppProcessError)) {
    return {
      message: errorMessage(hit),
      missing: false,
    }
  }

  const lines = (hit.stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
  return {
    message: errs[0] ?? lines.at(-1) ?? errorMessage(hit),
    missing: lines.some((line) => line.includes("No version matching")),
  }
}

const addPluginBySpec = Effect.fn("TuiPluginRuntime.addPluginBySpec")(function* (state: RuntimeState, raw: string) {
  const spec = raw.trim()
  if (!spec) return false

  const cfg = Option.getOrElse(MutableHashMap.get(state.pending, spec), () => defaultPluginOrigin(state, spec))
  const next = ConfigPlugin.pluginSpecifier(cfg.spec)
  if (state.plugins.some((plugin) => plugin.load.spec === next)) {
    MutableHashMap.remove(state.pending, spec)
    return true
  }
  const ready = yield* resolveExternalPlugins([cfg]).pipe(
    Effect.catch((error) =>
      fail("failed to add tui plugin", { path: next, error: error.cause }).pipe(Effect.as<PluginLoad[]>([])),
    ),
  )
  if (!ready.length) {
    return false
  }

  const first = Option.fromNullishOr(ready[0])
  if (Option.isNone(first)) {
    yield* fail("failed to add tui plugin", { path: next })
    return false
  }
  if (MutableHashMap.has(state.plugins_by_id, first.value.id)) {
    MutableHashMap.remove(state.pending, spec)
    return true
  }

  const out = yield* addExternalPluginEntries(state, [first.value])
  const active = yield* Effect.forEach(out.plugins, (plugin) => activatePluginEntry(state, plugin, false))
  const ok = out.ok && out.plugins.length > 0 && active.every(Boolean)

  if (ok) MutableHashMap.remove(state.pending, spec)
  if (!ok) {
    yield* fail("failed to add tui plugin", { path: next })
  }
  return ok
})

const installPluginBySpec = Effect.fn("TuiPluginRuntime.installPluginBySpec")(function* (
  state: RuntimeState,
  raw: string,
  global = false,
) {
  const spec = raw.trim()
  if (!spec) {
    return {
      ok: false,
      message: "Plugin package name is required",
    } satisfies TuiPluginInstallResult
  }

  const dir = state.api.state.path
  if (!dir.directory) {
    return {
      ok: false,
      message: "Paths are still syncing. Try again in a moment.",
    } satisfies TuiPluginInstallResult
  }

  // These helpers report failures as results; a rejection is a defect and rejects the install call.
  const install = yield* Effect.promise(() => installModulePlugin(spec))
  if (!install.ok) {
    const out = installDetail(install.error)
    return {
      ok: false,
      message: out.message,
      missing: out.missing,
    } satisfies TuiPluginInstallResult
  }

  const manifest = yield* Effect.promise(() => readPluginManifest(install.target))
  if (!manifest.ok) {
    if (manifest.code === "manifest_no_targets") {
      return {
        ok: false,
        message: `"${spec}" does not expose plugin entrypoints or oc-themes in package.json`,
      } satisfies TuiPluginInstallResult
    }

    return {
      ok: false,
      message: `Installed "${spec}" but failed to read ${manifest.file}`,
    } satisfies TuiPluginInstallResult
  }

  const patch = yield* Effect.promise(() =>
    patchPluginConfig({
      spec,
      targets: manifest.targets,
      global,
      ...(dir.worktree && dir.worktree !== "/" ? { vcs: "git" } : {}),
      worktree: dir.worktree,
      directory: dir.directory,
    }),
  )
  if (!patch.ok) {
    if (patch.code === "invalid_json") {
      return {
        ok: false,
        message: `Invalid JSON in ${patch.file} (${patch.parse} at line ${patch.line}, column ${patch.col})`,
      } satisfies TuiPluginInstallResult
    }

    return {
      ok: false,
      message: errorMessage(patch.error),
    } satisfies TuiPluginInstallResult
  }

  const tui = manifest.targets.find((item) => item.kind === "tui")
  if (tui) {
    const file = patch.items.find((item) => item.kind === "tui")?.file
    const next: ConfigPluginV1.Spec = tui.opts ? [spec, tui.opts] : spec
    MutableHashMap.set(state.pending, spec, {
      spec: next,
      scope: global ? "global" : "local",
      source: (file ?? dir.config) || path.join(patch.dir, "tui.json"),
    })
  }

  return {
    ok: true,
    dir: patch.dir,
    tui: Boolean(tui),
  } satisfies TuiPluginInstallResult
})

let dir = ""
let loaded: Option.Option<Promise<void>> = Option.none()
let runtime: Option.Option<RuntimeState> = Option.none()

// The exported functions below are the Promise-based host contract (TuiPluginHost and PluginRuntimeCommands).
// Each one runs its Effect at this edge.

export function init(input: {
  api: HostPluginApi
  config: TuiConfig.Resolved & TuiConfig.HostMetadata
  runtime?: PluginRuntime
  dispose?: () => void
  disposeTimeoutMs?: number
}) {
  const cwd = process.cwd()
  if (Option.isSome(loaded)) {
    if (dir !== cwd) {
      return Effect.runPromise(
        Effect.fail(
          new InitDirectoryError({
            message: `TuiPluginRuntime.init() called with a different working directory. expected=${dir} got=${cwd}`,
          }),
        ),
      )
    }
    return loaded.value
  }

  dir = cwd
  const next = setup({ ...input, runtime: input.runtime ?? createPluginRuntime() })
  const task = runPromise(load(next, input.config))
  loaded = Option.some(task)
  return task
}

export function list() {
  return Option.match(runtime, {
    onNone: (): TuiPluginStatus[] => [],
    onSome: listPluginStatus,
  })
}

export function activatePlugin(id: string) {
  return withRuntime(false, (state) => activatePluginById(state, id, true))
}

export function deactivatePlugin(id: string) {
  return withRuntime(false, (state) => deactivatePluginById(state, id, true))
}

export function addPlugin(spec: string) {
  return withRuntime(false, (state) => addPluginBySpec(state, spec))
}

export function installPlugin(spec: string, options?: { global?: boolean }) {
  return withRuntime<TuiPluginInstallResult>({ ok: false, message: "Plugin runtime is not ready." }, (state) =>
    installPluginBySpec(state, spec, options?.global),
  )
}

export function dispose() {
  const task = loaded
  loaded = Option.none()
  dir = ""
  return Effect.runPromise(disposeRuntime(task))
}

function withRuntime<A>(missing: A, run: (state: RuntimeState) => Effect.Effect<A, never, FSUtil.Service>) {
  return runPromise(
    Option.match(runtime, {
      onNone: () => Effect.succeed(missing),
      onSome: run,
    }),
  )
}

const disposeRuntime = Effect.fn("TuiPluginRuntime.dispose")(function* (task: Option.Option<Promise<void>>) {
  if (Option.isSome(task)) {
    yield* attempt(() => task.value).pipe(
      Effect.catch((error) => fail("failed to finish loading tui plugins during disposal", { error: error.cause })),
    )
  }
  const current = runtime
  runtime = Option.none()
  if (Option.isNone(current)) return
  const state = current.value
  const queue = [...state.plugins].reverse()
  for (const plugin of queue) {
    yield* deactivatePluginEntry(state, plugin, false).pipe(
      Effect.catchCause((cause) => fail("failed to dispose tui plugin", { id: plugin.id, error: Cause.squash(cause) })),
    )
  }
  // A throwing host dispose still clears the slots and the view, then rejects the dispose call.
  yield* Effect.sync(() => state.dispose?.()).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        state.slots.dispose()
        state.view.clear()
      }),
    ),
  )
})

function setup(input: {
  api: Api
  runtime: PluginRuntime
  dispose?: () => void
  disposeTimeoutMs?: number
}): RuntimeState {
  const slots = input.runtime.setupSlots(input.api)
  const next: RuntimeState = {
    directory: process.cwd(),
    api: input.api,
    view: input.runtime,
    dispose: input.dispose,
    slots,
    plugins: [],
    plugins_by_id: MutableHashMap.empty(),
    pending: MutableHashMap.empty(),
    dispose_timeout_ms: input.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS,
  }
  runtime = Option.some(next)
  next.view.update({
    commands: {
      activate: activatePlugin,
      deactivate: deactivatePlugin,
      add: addPlugin,
      install: installPlugin,
    },
    status: listPluginStatus(next),
  })
  return next
}

const load = Effect.fn("TuiPluginRuntime.load")(function* (
  next: RuntimeState,
  config: TuiConfig.Resolved & TuiConfig.HostMetadata,
) {
  yield* Effect.gen(function* () {
    const flags = yield* Effect.gen(function* () {
      return yield* RuntimeFlags.Service
    }).pipe(Effect.provide(AppNodeBuilder.build(RuntimeFlags.node)))
    const pluginOrigins = config.plugin_origins ?? (yield* Effect.promise(() => TuiConfig.pluginOrigins()))
    const pure = yield* FlagConfig.OPENCODE_PURE
    const records = pure ? [] : pluginOrigins

    for (const item of internalTuiPlugins(flags)) {
      const entry = loadInternalPlugin(item)
      const meta = yield* createMeta(entry.source, entry.spec, entry.target, Option.none(), entry.id)
      yield* addPluginEntry(next, {
        id: entry.id,
        load: entry,
        meta,
        themes: {},
        plugin: entry.module.tui,
        enabled: item.enabled ?? true,
        scope: Option.none(),
      })
    }

    const ready = yield* resolveExternalPlugins(records)
    yield* addExternalPluginEntries(next, ready)

    applyInitialPluginEnabledState(next, config)
    for (const plugin of next.plugins) {
      if (!plugin.enabled) continue
      // Keep plugin execution sequential for deterministic side effects:
      // command registration order affects keybind/command precedence,
      // route registration is last-wins when ids collide,
      // and hook chains rely on stable plugin ordering.
      yield* activatePluginEntry(next, plugin, false)
    }
    next.view.update({ status: listPluginStatus(next) })
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      return fail("failed to load tui plugins", {
        directory: next.directory,
        error: error instanceof PluginStepError ? error.cause : error,
      })
    }),
  )
})

export function createLegacyTuiPluginHost(): TuiPluginHost {
  return {
    start: init,
    dispose,
  }
}

export * as TuiPluginRuntime from "./runtime"

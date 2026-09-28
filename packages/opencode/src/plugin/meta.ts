import path from "path"
import { fileURLToPath } from "url"

import { Clock, Effect, Option, Schema } from "effect"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Plugin } from "@opencode-ai/schema/plugin"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flock } from "@opencode-ai/core/util/flock"

import { parsePluginSpecifier, pluginSource } from "./shared"

export const Theme = Schema.Struct({
  src: Schema.String,
  dest: Schema.String,
  mtime: Schema.optional(Schema.Number),
  size: Schema.optional(Schema.Number),
}).annotate({ identifier: "PluginMeta.Theme" })
export type Theme = typeof Theme.Type

export const Entry = Schema.Struct({
  id: Plugin.ID,
  source: Schema.Literals(["file", "npm"]),
  spec: Schema.String,
  target: Schema.String,
  requested: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  modified: Schema.optional(Schema.Number),
  first_time: Schema.Number,
  last_time: Schema.Number,
  time_changed: Schema.Number,
  load_count: Schema.Number,
  fingerprint: Schema.String,
  themes: Schema.optional(Schema.Record(Schema.String, Theme)),
}).annotate({ identifier: "PluginMeta.Entry" })
export type Entry = typeof Entry.Type

export type State = "first" | "updated" | "same"

export type Touch = {
  spec: string
  target: string
  id: string
}

export type Hit = { state: State; entry: Entry }

export class TouchError extends Schema.TaggedError<TouchError>()("PluginMeta.TouchError", {
  message: Schema.String,
}) {}

const Store = Schema.Record(Schema.String, Entry).annotate({ identifier: "PluginMeta.Store" })
type Store = typeof Store.Type
type Core = Omit<Entry, "first_time" | "last_time" | "time_changed" | "load_count" | "fingerprint" | "themes">
type Row = Touch & { core: Core }

const StoreText = Schema.fromJsonString(Store, { space: 2 })
const decodeStore = Schema.decodeUnknownEffect(StoreText)
const encodeStore = Schema.encodeEffect(StoreText)

const PackageVersion = Schema.Struct({ version: Schema.optional(Schema.String) }).annotate({
  identifier: "PluginMeta.PackageVersion",
})
const decodePackageVersion = Schema.decodeUnknownOption(Schema.fromJsonString(PackageVersion))

// The variable is read at each run: tests and worker processes set it after start.
const storePath = FlagConfig.OPENCODE_PLUGIN_META_FILE.pipe(
  Effect.map(Option.getOrElse(() => path.join(Global.Path.state, "plugin-meta.json"))),
  Effect.orDie,
)

function lock(file: string) {
  return `plugin-meta:${file}`
}

function fileTarget(spec: string, target: string): Option.Option<string> {
  if (spec.startsWith("file://")) return Option.some(fileURLToPath(spec))
  if (target.startsWith("file://")) return Option.some(fileURLToPath(target))
  return Option.none()
}

// The stat of a path, or None when it is missing. Any other stat failure is a defect, as the rejection was before.
const statOf = Effect.fnUntraced(function* (file: string) {
  const fsu = yield* FSUtil.Service
  return yield* fsu.stat(file).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.orDie,
  )
})

// Node reports sub-millisecond mtimes; the stored value keeps the floor of mtimeMs, which is the Date time.
// A missing file has no time.
const modifiedAt = Effect.fnUntraced(function* (file: string) {
  const stat = yield* statOf(file)
  return Option.flatMap(stat, (info) => Option.map(info.mtime, (date) => date.getTime()))
})

function resolvedTarget(target: string) {
  if (target.startsWith("file://")) return fileURLToPath(target)
  return target
}

const npmVersion = Effect.fnUntraced(function* (target: string) {
  const fsu = yield* FSUtil.Service
  const resolved = resolvedTarget(target)
  const stat = yield* statOf(resolved)
  const dir = Option.exists(stat, (info) => info.type === "Directory") ? resolved : path.dirname(resolved)
  const text = yield* Effect.option(fsu.readFileString(path.join(dir, "package.json")))
  return text.pipe(
    Option.flatMap(decodePackageVersion),
    Option.flatMap((pkg) => Option.fromNullishOr(pkg.version)),
  )
})

const entryCore = Effect.fnUntraced(function* (item: Touch) {
  const spec = item.spec
  const target = item.target
  const source = pluginSource(spec)
  if (source === "file") {
    const modified = yield* Option.match(fileTarget(spec, target), {
      onNone: () => Effect.succeedNone,
      onSome: modifiedAt,
    })
    const core: Core = {
      id: Plugin.ID.make(item.id),
      source,
      spec,
      target,
      ...Option.match(modified, { onNone: () => ({}), onSome: (value) => ({ modified: value }) }),
    }
    return core
  }

  const version = yield* npmVersion(target)
  const core: Core = {
    id: Plugin.ID.make(item.id),
    source,
    spec,
    target,
    requested: parsePluginSpecifier(spec).version,
    ...Option.match(version, { onNone: () => ({}), onSome: (value) => ({ version: value }) }),
  }
  return core
})

function fingerprint(value: Core) {
  if (value.source === "file") return [value.target, value.modified ?? ""].join("|")
  return [value.target, value.requested ?? "", value.version ?? ""].join("|")
}

// A missing or unreadable store starts empty, as before.
const read = Effect.fnUntraced(function* (file: string) {
  const fsu = yield* FSUtil.Service
  return yield* fsu.readFileString(file).pipe(
    Effect.flatMap((text) => decodeStore(text)),
    Effect.orElseSucceed((): Store => ({})),
  )
})

// writeWithDirs creates the parent directory when it is missing. A failed write is a defect, as before.
const write = Effect.fnUntraced(function* (file: string, store: Store) {
  const fsu = yield* FSUtil.Service
  const text = yield* encodeStore(store)
  yield* fsu.writeWithDirs(file, text).pipe(Effect.orDie)
})

// The exports keep no service requirement: worker processes and tests run them with Effect.runPromise alone.
const fileSystemLayer = LayerNode.compile(FSUtil.node)

const row = Effect.fnUntraced(function* (item: Touch) {
  const core = yield* entryCore(item)
  const value: Row = { ...item, core }
  return value
})

function next(prev: Entry | undefined, core: Core, now: number): Hit {
  const print = fingerprint(core)
  const state: State = !prev ? "first" : prev.fingerprint === print ? "same" : "updated"
  const entry: Entry = {
    ...core,
    first_time: prev?.first_time ?? now,
    last_time: now,
    time_changed: state === "updated" ? now : (prev?.time_changed ?? now),
    load_count: (prev?.load_count ?? 0) + 1,
    fingerprint: print,
    ...(prev?.themes ? { themes: prev.themes } : {}),
  }
  return { state, entry }
}

export const touchMany = Effect.fn("PluginMeta.touchMany")(function* (items: ReadonlyArray<Touch>) {
  if (!items.length) return []
  const file = yield* storePath
  const rows = yield* Effect.forEach(items, (item) => row(item), { concurrency: "unbounded" })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(lock(file))
      const store = yield* read(file)
      const now = yield* Clock.currentTimeMillis
      // Apply the rows in order, so a repeated id sees the entry of the row before it.
      const result = rows.reduce(
        (acc: { store: Store; hits: ReadonlyArray<Hit> }, item) => {
          const hit = next(acc.store[item.id], item.core, now)
          return { store: { ...acc.store, [item.id]: hit.entry }, hits: [...acc.hits, hit] }
        },
        { store, hits: [] },
      )
      yield* write(file, result.store)
      return result.hits
    }),
  )
}, Effect.provide(fileSystemLayer))

export const touch = Effect.fn("PluginMeta.touch")(function* (spec: string, target: string, id: string) {
  const hits = yield* touchMany([{ spec, target, id }])
  const hit = hits[0]
  if (hit) return hit
  return yield* new TouchError({ message: "Failed to touch plugin metadata." })
})

export const setTheme = Effect.fn("PluginMeta.setTheme")(function* (id: string, name: string, theme: Theme) {
  const file = yield* storePath
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(lock(file))
      const store = yield* read(file)
      const entry = store[id]
      if (!entry) return
      yield* write(file, { ...store, [id]: { ...entry, themes: { ...entry.themes, [name]: theme } } })
    }),
  )
}, Effect.provide(fileSystemLayer))

export const list = Effect.fn("PluginMeta.list")(function* () {
  const file = yield* storePath
  return yield* Effect.scoped(Flock.effect(lock(file)).pipe(Effect.andThen(read(file))))
}, Effect.provide(fileSystemLayer))

export * as PluginMeta from "./meta"

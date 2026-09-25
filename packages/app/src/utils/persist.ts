import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  Array as Arr,
  Data,
  Effect,
  Iterable,
  MutableHashMap,
  MutableHashSet,
  Option,
  Order,
  Predicate,
  Result,
  Schema,
} from "effect"
import { createResource, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { pathKey } from "@/utils/path-key"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type PersistTarget = {
  draft?: boolean
  storage?: string
  scope?: "window"
  legacyStorageNames?: string[]
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
}

type StorageFactory = NonNullable<Platform["storage"]>
type DraftStore = NonNullable<Platform["draftStore"]>

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "opencode.global.dat"
const WINDOW_STORAGE = "opencode.window"
const LOCAL_PREFIX = "opencode."
const fallback = MutableHashSet.empty<string>()

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
// MutableHashMap iterates in insertion order, so the first key is the least recently used entry.
const cache = MutableHashMap.empty<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = MutableHashMap.get(cache, key)
  if (Option.isNone(entry)) return
  cacheTotal.bytes -= entry.value.bytes
  MutableHashMap.remove(cache, key)
}

function cachePrune() {
  for (;;) {
    if (MutableHashMap.size(cache) <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = Iterable.head(MutableHashMap.keys(cache))
    if (Option.isNone(oldest)) return
    cacheDelete(oldest.value)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = MutableHashMap.get(cache, key)
  if (Option.isSome(entry)) cacheTotal.bytes -= entry.value.bytes
  MutableHashMap.remove(cache, key)
  MutableHashMap.set(cache, key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string): Option.Option<string> {
  const entry = MutableHashMap.get(cache, key)
  if (Option.isNone(entry)) return Option.none()
  MutableHashMap.remove(cache, key)
  MutableHashMap.set(cache, key, entry.value)
  return Option.some(entry.value.value)
}

function fallbackDisabled(scope: string) {
  return MutableHashSet.has(fallback, scope)
}

function fallbackSet(scope: string) {
  MutableHashSet.add(fallback, scope)
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

const largestFirst = Order.flip(Order.mapInput(Order.Number, (item: Evict) => item.size))

function evictionCandidates(storage: Storage, keep: string): ReadonlyArray<Evict> {
  const names = Array.from({ length: storage.length }, (_, index) => storage.key(index))
  const candidates = names
    .filter(Predicate.isNotNull)
    .filter((name) => name.startsWith(LOCAL_PREFIX) && name !== keep)
    .map((name) => ({ key: name, size: storage.getItem(name)?.length ?? 0 }))
  return Arr.sort(candidates, largestFirst)
}

function storeValue(storage: Storage, key: string, value: string) {
  storage.setItem(key, value)
  cacheSet(key, value)
}

// Success(true): the value is written. Success(false): the storage quota is full. Failure: another storage error.
function attemptWrite(run: () => void): Result.Result<boolean, unknown> {
  return Result.try(run).pipe(
    Result.map(() => true),
    Result.orElse((error) => (quota(error) ? Result.succeed(false) : Result.fail(error))),
  )
}

function evict(storage: Storage, keep: string, value: string): Result.Result<boolean, unknown> {
  return Result.flatMap(
    Result.try(() => evictionCandidates(storage, keep)),
    (candidates) => {
      for (const item of candidates) {
        const written = Result.try(() => storage.removeItem(item.key)).pipe(
          Result.flatMap(() => {
            cacheDelete(item.key)
            return attemptWrite(() => storeValue(storage, keep, value))
          }),
        )
        if (Result.isFailure(written) || written.success) return written
      }
      return Result.succeed(false)
    },
  )
}

function write(storage: Storage, key: string, value: string): Result.Result<boolean, unknown> {
  return attemptWrite(() => storeValue(storage, key, value)).pipe(
    Result.flatMap((written) =>
      written
        ? Result.succeed(true)
        : attemptWrite(() => {
            storage.removeItem(key)
            cacheDelete(key)
            storeValue(storage, key, value)
          }),
    ),
    Result.flatMap((written) => (written ? Result.succeed(true) : evict(storage, key, value))),
  )
}

const JsonText = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownOption(JsonText)
const encodeJson = Schema.encodeUnknownOption(JsonText)

function snapshot(value: unknown): Option.Option<unknown> {
  return Option.flatMap(encodeJson(value), (text) => decodeJson(text))
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (Predicate.isNull(value)) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (Predicate.isObject(defaults)) {
    if (!Predicate.isObject(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge(defaults[key], value[key])
      } else {
        result[key] = value[key]
      }
    }
    return result
  }

  return value
}

function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown): Option.Option<string> {
  return decodeJson(raw).pipe(
    Option.map((parsed) => (migrate ? migrate(parsed) : parsed)),
    Option.flatMap((migrated) => encodeJson(merge(defaults, migrated))),
  )
}

type ReadInput<S> = {
  storage: S
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}

type MigrateInput<S> = {
  current: S
  legacyStore: S
  stores: ReadonlyArray<S>
  keys: ReadonlyArray<string>
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}

// None: nothing is stored. Some(None): the stored value was invalid and is removed. Some(Some): the normalized value.
function readCurrent(input: ReadInput<SyncStorage>): Option.Option<Option.Option<string>> {
  return Option.map(Option.fromNullOr(input.storage.getItem(input.key)), (raw) => {
    const next = normalize(input.defaults, raw, input.migrate)
    if (Option.isNone(next)) input.storage.removeItem(input.key)
    else if (raw !== next.value) input.storage.setItem(input.key, next.value)
    return next
  })
}

function moveLegacy(from: SyncStorage, fromKey: string, input: MigrateInput<SyncStorage>): Option.Option<string> {
  return Option.flatMap(Option.fromNullOr(from.getItem(fromKey)), (raw) => {
    const next = normalize(input.defaults, raw, input.migrate)
    if (Option.isSome(next)) input.current.setItem(input.key, next.value)
    from.removeItem(fromKey)
    return next
  })
}

function migrateLegacy(input: MigrateInput<SyncStorage>): Option.Option<string> {
  for (const store of input.stores) {
    const moved = moveLegacy(store, input.key, input)
    if (Option.isSome(moved)) return moved
  }

  for (const key of input.keys) {
    const moved = moveLegacy(input.legacyStore, key, input)
    if (Option.isSome(moved)) return moved
  }

  return Option.none()
}

class PersistStorageError extends Data.TaggedError("App.PersistStorageError")<{ readonly cause: unknown }> {}

const storageError = (cause: unknown) => new PersistStorageError({ cause })

type EffectStorage = {
  readonly getItem: (key: string) => Effect.Effect<Option.Option<string>, PersistStorageError>
  readonly setItem: (key: string, value: string) => Effect.Effect<void, PersistStorageError>
  readonly removeItem: (key: string) => Effect.Effect<void, PersistStorageError>
}

function settleItem(item: string | null | PromiseLike<string | null>) {
  if (Predicate.isPromiseLike(item)) return Effect.tryPromise({ try: () => item, catch: storageError })
  return Effect.succeed(item)
}

function settleDone(result: unknown): Effect.Effect<void, PersistStorageError> {
  if (Predicate.isPromiseLike(result))
    return Effect.asVoid(Effect.tryPromise({ try: () => result, catch: storageError }))
  return Effect.void
}

// Platform storage can be sync or async; both become Effects that fail with PersistStorageError.
function effectStorage(storage: SyncStorage | AsyncStorage): EffectStorage {
  return {
    getItem: (key) =>
      Effect.try({ try: () => storage.getItem(key), catch: storageError }).pipe(
        Effect.flatMap(settleItem),
        Effect.map(Option.fromNullOr),
      ),
    setItem: (key, value) =>
      Effect.try({ try: () => storage.setItem(key, value), catch: storageError }).pipe(Effect.flatMap(settleDone)),
    removeItem: (key) =>
      Effect.try({ try: () => storage.removeItem(key), catch: storageError }).pipe(Effect.flatMap(settleDone)),
  }
}

function readCurrentAsync(input: ReadInput<EffectStorage>) {
  return Effect.gen(function* () {
    const raw = yield* input.storage.getItem(input.key)
    if (Option.isNone(raw)) return Option.none<Option.Option<string>>()
    const next = normalize(input.defaults, raw.value, input.migrate)
    if (Option.isNone(next)) yield* Effect.ignore(input.storage.removeItem(input.key))
    else if (raw.value !== next.value) yield* input.storage.setItem(input.key, next.value)
    return Option.some(next)
  })
}

function moveLegacyAsync(from: EffectStorage, fromKey: string, input: MigrateInput<EffectStorage>) {
  return Effect.gen(function* () {
    const raw = yield* from.getItem(fromKey)
    if (Option.isNone(raw)) return Option.none<string>()
    const next = normalize(input.defaults, raw.value, input.migrate)
    if (Option.isNone(next)) {
      yield* Effect.ignore(from.removeItem(fromKey))
      return next
    }
    yield* input.current.setItem(input.key, next.value)
    yield* from.removeItem(fromKey)
    return next
  })
}

function migrateLegacyAsync(input: MigrateInput<EffectStorage>) {
  return Effect.gen(function* () {
    for (const store of input.stores) {
      const moved = yield* moveLegacyAsync(store, input.key, input)
      if (Option.isSome(moved)) return moved
    }

    for (const key of input.keys) {
      const moved = yield* moveLegacyAsync(input.legacyStore, key, input)
      if (Option.isSome(moved)) return moved
    }

    return Option.none<string>()
  })
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `opencode.workspace.${head}.${sum}.dat`
}

function draftStorage(draftID: string) {
  const head = (draftID.slice(0, 12) || "draft").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(draftID) ?? "0"
  return `opencode.draft.${head}.${sum}.dat`
}

function windowStorage(windowID: string) {
  const safe = (windowID || "browser").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `${WINDOW_STORAGE}.${safe}.dat`
}

function legacyWorkspaceStorage(dir: string): string[] | undefined {
  const key = pathKey(dir)
  const storage = workspaceStorage(key)
  const drive = key.length >= 3 && key[1] === ":" && key[2] === "/"
  const candidates = drive
    ? [workspaceStorage(dir), workspaceStorage(key.replaceAll("/", "\\"))]
    : [workspaceStorage(dir)]
  const result = Arr.dedupe(candidates.filter((name) => name !== storage))

  if (result.length === 0) return undefined
  return result
}

function serverWorkspaceTarget(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
  if (scope !== ServerScope.local) return { storage: workspaceStorage(ScopedKey.from(scope, pathKey(dir))), key }
  return { storage: workspaceStorage(pathKey(dir)), legacyStorageNames: legacyWorkspaceStorage(dir), key, legacy }
}

function readLocal(scope: string, key: string): Option.Option<string> {
  const read = Result.try(() => localStorage.getItem(key))
  if (Result.isFailure(read)) fallbackSet(scope)
  return Option.flatMap(Result.getSuccess(read), Option.fromNullOr)
}

function writeLocal(key: string, value: string): boolean {
  return Result.try(() => localStorage).pipe(
    Result.flatMap((storage) => write(storage, key, value)),
    Result.getOrElse(() => false),
  )
}

function localStorageScoped(scope: string, name: (key: string) => string): SyncStorage {
  return {
    getItem: (key) => {
      const item = name(key)
      const cached = cacheGet(item)
      if (fallbackDisabled(scope)) return Option.getOrNull(cached)

      const stored = readLocal(scope, item)
      if (Option.isNone(stored)) return Option.getOrNull(cached)
      cacheSet(item, stored.value)
      return stored.value
    },
    setItem: (key, value) => {
      const item = name(key)
      if (fallbackDisabled(scope)) return
      if (writeLocal(item, value)) return
      fallbackSet(scope)
    },
    removeItem: (key) => {
      const item = name(key)
      cacheDelete(item)
      if (fallbackDisabled(scope)) return
      if (Result.isFailure(Result.try(() => localStorage.removeItem(item)))) fallbackSet(scope)
    },
  }
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  return localStorageScoped(`prefix:${prefix}`, (key) => `${prefix}:${key}`)
}

function localStorageDirect(): SyncStorage {
  return localStorageScoped("direct", (key) => key)
}

const DRAFT_PERSISTED_KEYS = ["prompt", "comments", "file-view", "layout"]

export function draftPersistedKeys() {
  return DRAFT_PERSISTED_KEYS
}

export const PersistTesting = {
  localStorageDirect,
  localStorageWithPrefix,
  migrateLegacy,
  normalize,
  resolveTarget,
  windowStorage,
  workspaceStorage,
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  window(key: string, legacy?: string[]): PersistTarget {
    return { scope: "window", key, legacy }
  },
  draft(draftID: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: draftStorage(draftID), key: `draft:${key}`, legacy }
  },
  serverGlobal(scope: ServerScopeValue, key: string, legacy?: string[]): PersistTarget {
    if (scope === ServerScope.local) return Persist.global(key, legacy)
    return { storage: GLOBAL_STORAGE, key: ScopedKey.from(scope, key) }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `workspace:${key}`, legacy)
  },
  serverWorkspace(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `workspace:${key}`, legacy)
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `session:${session}:${key}`, legacy)
  },
  serverSession(scope: ServerScopeValue, dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `session:${session}:${key}`, legacy)
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
  serverScoped(scope: ServerScopeValue, dir: string, session: string | undefined, key: string, legacy?: string[]) {
    if (session) return Persist.serverSession(scope, dir, session, key, legacy)
    return Persist.serverWorkspace(scope, dir, key, legacy)
  },
  prompt(target: PersistTarget): PersistTarget {
    return { ...target, draft: true }
  },
}

function resolveTarget(target: PersistTarget, platform: Platform): PersistTarget {
  if (target.scope !== "window") return target
  if (platform.platform === "desktop" && !platform.windowID) return { ...target, storage: GLOBAL_STORAGE }
  const windowID = platform.platform === "desktop" ? (platform.windowID ?? "browser") : "browser"
  return {
    ...target,
    storage: windowStorage(windowID),
  }
}

export function removePersisted(
  target: { draft?: boolean; storage?: string; legacyStorageNames?: string[]; key: string },
  platform?: Platform,
) {
  if (target.draft && platform?.draftStore) {
    void platform.draftStore.removeItem(`${target.storage ?? "default"}:${target.key}`)
  }
  const isDesktop = platform?.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    void platform.storage?.(target.storage)?.removeItem(target.key)
    for (const storage of target.legacyStorageNames ?? []) {
      void platform.storage?.(storage)?.removeItem(target.key)
    }
    return
  }

  if (!target.storage) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
  for (const storage of target.legacyStorageNames ?? []) {
    localStorageWithPrefix(storage).removeItem(target.key)
  }
}

// Web storage without a draft store: localStorage, read and written synchronously.
function syncPersistStorage(config: PersistTarget, defaults: unknown): SyncStorage {
  const current = config.storage ? localStorageWithPrefix(config.storage) : localStorageDirect()
  const legacyStore = localStorageDirect()
  const stores = (config.legacyStorageNames ?? []).map(localStorageWithPrefix)
  const keys = config.legacy ?? []

  return {
    getItem: (key) => {
      const value = readCurrent({ storage: current, key, defaults, migrate: config.migrate })
      const migrated = Option.getOrElse(value, () =>
        migrateLegacy({ current, legacyStore, stores, keys, key, defaults, migrate: config.migrate }),
      )
      return Option.getOrNull(migrated)
    },
    setItem: (key, value) => {
      current.setItem(key, value)
    },
    removeItem: (key) => {
      current.removeItem(key)
    },
  }
}

// Desktop storage or a draft store: the storage calls return promises.
function asyncPersistStorage(input: {
  config: PersistTarget
  defaults: unknown
  desktop: Option.Option<StorageFactory>
  draft: Option.Option<DraftStore>
}): AsyncStorage {
  const { config, defaults, desktop, draft } = input
  const open = (name: string | undefined) =>
    Option.match(desktop, {
      onSome: (factory) => factory(name),
      onNone: () => (name ? localStorageWithPrefix(name) : localStorageDirect()),
    })
  const openLegacy = (name: string) =>
    Option.match(desktop, {
      onSome: (factory) => factory(name),
      onNone: () => localStorageWithPrefix(name),
    })

  const current = Option.match(draft, {
    onSome: (store) => {
      const prefix = `${config.storage ?? "default"}:`
      return effectStorage({
        getItem: (key: string) => store.getItem(prefix + key),
        setItem: (key: string, value: string) => store.setItem(prefix + key, value),
        removeItem: (key: string) => store.removeItem(prefix + key),
      } satisfies AsyncStorage)
    },
    onNone: () => effectStorage(open(config.storage)),
  })
  const legacyStore = effectStorage(
    Option.match(desktop, {
      onSome: (factory) => (config.storage ? factory(LEGACY_STORAGE) : factory()),
      onNone: () => localStorageDirect(),
    }),
  )
  const oldCurrent = Option.map(draft, () => open(config.storage))
  const stores = [...Option.toArray(oldCurrent), ...(config.legacyStorageNames ?? []).map(openLegacy)].map(
    effectStorage,
  )
  const keys = config.legacy ?? []
  let draftLatest = Option.none<string>()

  return {
    getItem: (key) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const value = yield* readCurrentAsync({ storage: current, key, defaults, migrate: config.migrate })
          if (Option.isSome(value)) return Option.getOrNull(value.value)
          const migrated = yield* migrateLegacyAsync({
            current,
            legacyStore,
            stores,
            keys,
            key,
            defaults,
            migrate: config.migrate,
          })
          const latest = draftLatest
          if (Option.isNone(latest)) {
            if (Option.isNone(draft) || Option.isNone(migrated)) return Option.getOrNull(migrated)
            const stored = yield* current.getItem(key)
            return Option.getOrNull(Option.orElse(stored, () => migrated))
          }
          yield* current.setItem(key, latest.value)
          return latest.value
        }),
      ),
    setItem: (key, value) => {
      if (Option.isSome(draft)) draftLatest = Option.some(value)
      return Effect.runPromise(current.setItem(key, value))
    },
    removeItem: (key) => Effect.runPromise(current.removeItem(key)),
  }
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
  platformOverride?: Platform,
): PersistedWithReady<T> {
  const platform = platformOverride ?? usePlatform()
  const config = resolveTarget(typeof target === "string" ? { key: target } : target, platform)

  const defaults = Option.getOrUndefined(snapshot(store[0]))
  const desktop = Option.fromNullishOr(platform.storage).pipe(Option.filter(() => platform.platform === "desktop"))
  const draft = Option.fromNullishOr(platform.draftStore).pipe(Option.filter(() => config.draft === true))

  const storage =
    Option.isNone(desktop) && Option.isNone(draft)
      ? syncPersistStorage(config, defaults)
      : asyncPersistStorage({ config, defaults, desktop, draft })

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const initPromise = init instanceof Promise ? Option.some(init) : Option.none<Promise<string>>()
  const [ready] = createResource(
    () => init,
    (initValue) =>
      Effect.runPromise(
        initValue instanceof Promise
          ? Effect.as(
              Effect.promise(() => initValue),
              true,
            )
          : Effect.succeed(true),
      ),
    { initialValue: Option.isNone(initPromise) },
  )

  return [
    state,
    setState,
    init,
    Object.assign(() => !ready.loading && ready.latest, {
      promise: Option.getOrUndefined(initPromise),
    }),
  ]
}

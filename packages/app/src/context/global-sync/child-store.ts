import { createRoot, createSignal, getOwner, onCleanup, runWithOwner, type Owner } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import {
  DIR_IDLE_TTL_MS,
  MAX_DIR_STORES,
  type ChildOptions,
  type DirState,
  type IconCache,
  type MetaCache,
  type ProjectMeta,
  type State,
  type VcsCache,
} from "./types"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./eviction"
import { useQuery } from "@tanstack/solid-query"
import { QueryOptionsApi } from "../server-sync"
import { directoryKey, type DirectoryKey } from "./utils"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import type { ServerScope } from "@/utils/server-scope"
import { Data, DateTime, Effect, HashMap, MutableHashMap, MutableHashSet, Option } from "effect"

/**
 * Raised when ensureChild cannot build a directory store: a persisted cache or
 * the store root failed to initialize under the manager owner. The store
 * accessors are synchronous Solid APIs, so the error is thrown to the nearest
 * error boundary. The `message` is the translated text that the user sees.
 */
class ChildStoreError extends Data.TaggedError("ChildStoreError")<{
  readonly message: string
}> {}

const cacheView = <V>(caches: MutableHashMap.MutableHashMap<string, V>) => ({
  get: (key: string) => Option.getOrUndefined(MutableHashMap.get(caches, key)),
})

/** The directory query factories that a child store subscribes to. */
export type ChildQueryOptions = Pick<
  QueryOptionsApi,
  "path" | "mcp" | "mcpResources" | "lsp" | "providers" | "references"
>

export function createChildStoreManager(input: {
  owner: Owner
  scope: ServerScope
  persist: typeof persisted
  isBooting: (directory: string) => boolean
  isLoadingSessions: (directory: string) => boolean
  onBootstrap: (directory: string) => void
  onMcp: (directory: string, setStore: SetStoreFunction<State>) => void
  onDispose: (directory: string) => void
  translate: (key: string, vars?: Record<string, string | number>) => string
  queryOptions: ChildQueryOptions
  global: {
    provider: NormalizedProviderListResponse
  }
}) {
  const children: Record<string, [Store<State>, SetStoreFunction<State>]> = {}
  const vcsCache = MutableHashMap.empty<string, VcsCache>()
  const metaCache = MutableHashMap.empty<string, MetaCache>()
  const iconCache = MutableHashMap.empty<string, IconCache>()
  const lifecycle = new Map<string, DirState>()
  const pins = MutableHashMap.empty<string, number>()
  const ownerPins = new WeakMap<object, MutableHashSet.MutableHashSet<string>>()
  const disposers = MutableHashMap.empty<string, () => void>()
  const mcpDirectories = MutableHashSet.empty<string>()
  const mcpToggles = MutableHashMap.empty<string, (enabled: boolean) => void>()
  const activeDirectories = MutableHashSet.empty<string>()
  const activationToggles = MutableHashMap.empty<string, (enabled: boolean) => void>()
  const pinCount = (key: string) => Option.getOrElse(MutableHashMap.get(pins, key), () => 0)
  const toggle = (
    toggles: MutableHashMap.MutableHashMap<string, (enabled: boolean) => void>,
    key: string,
    enabled: boolean,
  ) => {
    const set = MutableHashMap.get(toggles, key)
    if (Option.isSome(set)) set.value(enabled)
  }

  const markKey = (key: DirectoryKey) => {
    if (!key) return
    lifecycle.set(key, { lastAccessAt: DateTime.toEpochMillis(DateTime.nowUnsafe()) })
    runEviction(key)
  }

  const mark = (directory: string) => {
    const key = directoryKey(directory)
    markKey(key)
  }

  const pin = (directory: string) => {
    const key = directoryKey(directory)
    if (!key) return
    MutableHashMap.set(pins, key, pinCount(key) + 1)
    markKey(key)
  }

  const unpin = (directory: string) => {
    const key = directoryKey(directory)
    if (!key) return
    const next = pinCount(key) - 1
    if (next > 0) {
      MutableHashMap.set(pins, key, next)
      return
    }
    MutableHashMap.remove(pins, key)
    runEviction()
  }

  const pinned = (directory: string) => pinCount(directoryKey(directory)) > 0

  const pinForOwner = (directory: string) => {
    const current = getOwner()
    if (!current) return
    if (current === input.owner) return
    const key = current as object
    const set = ownerPins.get(key)
    if (set && MutableHashSet.has(set, directory)) return
    if (set) MutableHashSet.add(set, directory)
    if (!set) ownerPins.set(key, MutableHashSet.make(directory))
    pin(directory)
    onCleanup(() => {
      const set = ownerPins.get(key)
      if (set) {
        MutableHashSet.remove(set, directory)
        if (MutableHashSet.size(set) === 0) ownerPins.delete(key)
      }
      unpin(directory)
    })
  }

  function disposeDirectory(directory: DirectoryKey) {
    const key = directory
    if (
      !canDisposeDirectory({
        directory: key,
        hasStore: !!children[key],
        pinned: pinned(key),
        booting: input.isBooting(key),
        loadingSessions: input.isLoadingSessions(key),
      })
    ) {
      return false
    }

    MutableHashMap.remove(vcsCache, key)
    MutableHashMap.remove(metaCache, key)
    MutableHashMap.remove(iconCache, key)
    lifecycle.delete(key)
    MutableHashSet.remove(mcpDirectories, key)
    MutableHashMap.remove(mcpToggles, key)
    MutableHashSet.remove(activeDirectories, key)
    MutableHashMap.remove(activationToggles, key)
    const dispose = MutableHashMap.get(disposers, key)
    if (Option.isSome(dispose)) {
      dispose.value()
      MutableHashMap.remove(disposers, key)
    }
    delete children[key]
    input.onDispose(key)
    return true
  }

  function runEviction(skip?: string) {
    const stores = Object.keys(children)
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: lifecycle,
      pins: new Set(stores.filter(pinned)),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    }).filter((directory) => directory !== skip)
    if (list.length === 0) return
    for (const directory of list) {
      if (!disposeDirectory(directoryKey(directory))) continue
    }
  }

  const required = <A>(value: A, messageKey: string) =>
    Option.getOrThrowWith(
      Option.fromNullishOr(value),
      () => new ChildStoreError({ message: input.translate(messageKey) }),
    )

  function ensureChild(directory: string) {
    const key = directoryKey(directory)
    if (!key) Effect.runFork(Effect.logError("No directory provided"))
    if (!children[key]) {
      const vcs = required(
        runWithOwner(input.owner, () =>
          input.persist(
            Persist.serverWorkspace(input.scope, directory, "vcs", ["vcs.v1"]),
            createStore({ value: undefined as VcsInfo | undefined }),
          ),
        ),
        "error.childStore.persistedCacheCreateFailed",
      )
      const vcsStore = vcs[0]
      MutableHashMap.set(vcsCache, key, { store: vcsStore, setStore: vcs[1], ready: vcs[3] })

      const meta = required(
        runWithOwner(input.owner, () =>
          input.persist(
            Persist.serverWorkspace(input.scope, directory, "project", ["project.v1"]),
            createStore({ value: undefined as ProjectMeta | undefined }),
          ),
        ),
        "error.childStore.persistedProjectMetadataCreateFailed",
      )
      MutableHashMap.set(metaCache, key, { store: meta[0], setStore: meta[1], ready: meta[3] })

      const icon = required(
        runWithOwner(input.owner, () =>
          input.persist(
            Persist.serverWorkspace(input.scope, directory, "icon", ["icon.v1"]),
            createStore({ value: undefined as string | undefined }),
          ),
        ),
        "error.childStore.persistedProjectIconCreateFailed",
      )
      MutableHashMap.set(iconCache, key, { store: icon[0], setStore: icon[1], ready: icon[3] })

      const init = () =>
        createRoot((dispose) => {
          const initialMeta = meta[0].value
          const initialIcon = icon[0].value
          const [mcpEnabled, setMcpEnabled] = createSignal(false)
          const [instanceQueriesEnabled, setInstanceQueriesEnabled] = createSignal(false)

          const pathQuery = useQuery(() => ({ ...input.queryOptions.path(key), enabled: instanceQueriesEnabled() }))
          const mcpQuery = useQuery(() => ({ ...input.queryOptions.mcp(key), enabled: mcpEnabled() }))
          const mcpResourceQuery = useQuery(() => ({ ...input.queryOptions.mcpResources(key), enabled: mcpEnabled() }))
          const lspQuery = useQuery(() => ({ ...input.queryOptions.lsp(key), enabled: instanceQueriesEnabled() }))
          const providerQuery = useQuery(() => ({
            ...input.queryOptions.providers(key),
            enabled: instanceQueriesEnabled(),
          }))
          const referenceQuery = useQuery(() => ({
            ...input.queryOptions.references(key),
            enabled: instanceQueriesEnabled(),
          }))

          const child = createStore<State>({
            project: "",
            projectMeta: initialMeta,
            icon: initialIcon,
            get provider_ready() {
              return instanceQueriesEnabled() && !providerQuery.isLoading
            },
            get provider(): NormalizedProviderListResponse {
              const EMPTY: NormalizedProviderListResponse = { all: HashMap.empty(), connected: [], default: {} }
              if (providerQuery.isLoading) return EMPTY
              const data = providerQuery.data
              if (data && HashMap.isEmpty(data.all) && !HashMap.isEmpty(input.global.provider.all))
                return input.global.provider
              return data ?? EMPTY
            },
            config: {},
            get path() {
              const EMPTY = { state: "", config: "", worktree: "", directory, home: "" }
              if (pathQuery.isLoading) return EMPTY
              return pathQuery.data ?? EMPTY
            },
            status: "loading" as const,
            agent: [],
            command: [],
            get reference() {
              return referenceQuery.isLoading ? [] : (referenceQuery.data ?? [])
            },
            session: [],
            sessionTotal: 0,
            session_status: {},
            session_working(id: string) {
              const type = this.session_status[id]?.type
              return (type ?? "idle") !== "idle"
            },
            session_diff: {},
            todo: {},
            permission: {},
            question: {},
            get mcp_ready() {
              return !mcpQuery.isLoading
            },
            get mcp() {
              return mcpQuery.isLoading ? {} : (mcpQuery.data ?? {})
            },
            get mcp_resource() {
              return mcpResourceQuery.isLoading ? {} : (mcpResourceQuery.data ?? {})
            },
            get lsp_ready() {
              return instanceQueriesEnabled() && !lspQuery.isLoading
            },
            get lsp() {
              return lspQuery.isLoading ? [] : (lspQuery.data ?? [])
            },
            vcs: vcsStore.value,
            limit: 5,
            message: {},
            session_message: {},
            part: {},
            part_text_accum_delta: {},
          })
          children[key] = child
          MutableHashMap.set(disposers, key, dispose)
          MutableHashMap.set(mcpToggles, key, setMcpEnabled)
          MutableHashMap.set(activationToggles, key, setInstanceQueriesEnabled)

          const onPersistedInit = (init: Promise<string> | string | null, run: () => void) => {
            if (!(init instanceof Promise)) return
            void init.then(() => {
              if (children[key] !== child) return
              run()
            })
          }

          onPersistedInit(vcs[2], () => {
            const cached = vcsStore.value
            if (!cached?.branch) return
            child[1]("vcs", (value) => value ?? cached)
          })

          onPersistedInit(meta[2], () => {
            if (child[0].projectMeta !== initialMeta) return
            child[1]("projectMeta", meta[0].value)
          })

          onPersistedInit(icon[2], () => {
            if (child[0].icon !== initialIcon) return
            child[1]("icon", icon[0].value)
          })
        })

      runWithOwner(input.owner, init)
    }
    markKey(key)
    return required(children[key], "error.childStore.storeCreateFailed")
  }

  function child(directory: string, options: ChildOptions = {}) {
    const key = directoryKey(directory)
    const childStore = ensureChild(directory)
    pinForOwner(key)
    if (options.mcp) enableMcp(directory, key, childStore)
    const shouldBootstrap = options.bootstrap ?? true
    if (shouldBootstrap) activate(key)
    if (shouldBootstrap && childStore[0].status === "loading") {
      input.onBootstrap(directory)
    }
    return childStore
  }

  function peek(directory: string, options: ChildOptions = {}) {
    const key = directoryKey(directory)
    const childStore = ensureChild(directory)
    if (options.mcp) enableMcp(directory, key, childStore)
    const shouldBootstrap = options.bootstrap ?? true
    if (shouldBootstrap) activate(key)
    if (shouldBootstrap && childStore[0].status === "loading") {
      input.onBootstrap(directory)
    }
    return childStore
  }

  function enableMcp(directory: string, key: DirectoryKey, childStore: [Store<State>, SetStoreFunction<State>]) {
    if (MutableHashSet.has(mcpDirectories, key)) return
    MutableHashSet.add(mcpDirectories, key)
    toggle(mcpToggles, key, true)
    if (childStore[0].status !== "loading") input.onMcp(directory, childStore[1])
  }

  // Passive Home/project metadata reads must not initialize the directory.
  // A real directory access enables these queries once for the store lifetime.
  // TODO(v2): After Home switches to v2.project.list and root-filtered,
  // updated-time v2.session.list, remove any Home-only passive child creation.
  function activate(key: DirectoryKey) {
    if (MutableHashSet.has(activeDirectories, key)) return
    MutableHashSet.add(activeDirectories, key)
    toggle(activationToggles, key, true)
  }

  function disableMcp(directory: string) {
    const key = directoryKey(directory)
    if (!MutableHashSet.has(mcpDirectories, key)) return
    MutableHashSet.remove(mcpDirectories, key)
    toggle(mcpToggles, key, false)
  }

  function projectMeta(directory: string, patch: ProjectMeta) {
    const key = directoryKey(directory)
    const [store, setStore] = ensureChild(directory)
    const cached = MutableHashMap.get(metaCache, key)
    if (Option.isNone(cached)) return
    const previous = store.projectMeta ?? {}
    const icon = patch.icon ? { ...previous.icon, ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...previous.commands, ...patch.commands } : previous.commands
    const next = {
      ...previous,
      ...patch,
      icon,
      commands,
    }
    cached.value.setStore("value", next)
    setStore("projectMeta", next)
  }

  function projectIcon(directory: string, value: string | undefined) {
    const key = directoryKey(directory)
    const [store, setStore] = ensureChild(directory)
    const cached = MutableHashMap.get(iconCache, key)
    if (Option.isNone(cached)) return
    if (store.icon === value) return
    cached.value.setStore("value", value)
    setStore("icon", value)
  }

  return {
    children,
    ensureChild,
    child,
    peek,
    projectMeta,
    projectIcon,
    mark,
    pin,
    unpin,
    pinned,
    mcp: (directory: string) => MutableHashSet.has(mcpDirectories, directoryKey(directory)),
    active: (directory: string) => MutableHashSet.has(activeDirectories, directoryKey(directory)),
    disableMcp,
    disposeDirectory,
    runEviction,
    vcsCache: cacheView(vcsCache),
    metaCache: cacheView(metaCache),
    iconCache: cacheView(iconCache),
  }
}

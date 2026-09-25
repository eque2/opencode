import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadPathQueryFor,
  loadProjectsQuery,
  loadProvidersQuery,
  loadProvidersQueryFor,
  loadReferencesQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { estimateRootSessionTotal, loadRootSessions, loadRootSessionsV1 } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import type { ServerScope } from "@/utils/server-scope"
import { createHomeSessionIndexCache } from "./global-sync/home-session-index"
import { persisted } from "@/utils/persist"
import type { ServerApi } from "@/utils/server"
import type {
  McpListInput,
  McpListOutput,
  McpResource,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  McpServer,
  SessionActiveOutput,
} from "@opencode-ai/client/promise"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession, type ServerSession } from "./server-session"
import { Cause, Clock, Data, DateTime, Effect, HashMap, MutableHashMap, Option } from "effect"
import { createFiberSlot } from "@/utils/fiber-slot"

/** Raised when the server sync context is created outside a Solid owner, which it needs for its child stores. */
class ServerSyncOwnerError extends Data.TaggedError("ServerSyncOwnerError")<{ readonly message: string }> {}

/** Raised when the ServerSync context has no server to sync with. The message is the translated text. */
class NoServerAvailableError extends Data.TaggedError("NoServerAvailableError")<{ readonly message: string }> {}

/** A server request from server sync that failed; `cause` is the value the request rejected with. */
class ServerSyncRequestError extends Data.TaggedError("ServerSyncRequestError")<{ readonly cause: unknown }> {}

/** Runs one Promise-returning request and maps its rejection to a ServerSyncRequestError. */
function request<A>(run: () => PromiseLike<A>) {
  return Effect.tryPromise({ try: () => run(), catch: (cause) => new ServerSyncRequestError({ cause }) })
}

/** Gives a request program back to a Promise API. The Promise rejects with the raw request error, as before. */
function runRequest<A>(program: Effect.Effect<A, { readonly cause: unknown }>): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.mapError((error) => error.cause)))
}

/** The value the old Promise chain rejected with: the request's own error, or the defect of a thrown bug. */
const rejection = (cause: Cause.Cause<{ readonly cause: unknown }>): unknown =>
  Option.match(Cause.findErrorOption(cause), { onNone: () => Cause.squash(cause), onSome: (error) => error.cause })

/** Whether the server speaks the legacy v1 protocol. An absent protocol counts as not v1. */
const isLegacyProtocol = (protocol: Promise<"v1" | "v2"> | undefined) =>
  Option.match(Option.fromNullishOr(protocol), {
    onNone: () => Effect.succeed(false),
    onSome: (pending) => request(() => pending).pipe(Effect.map((value) => value === "v1")),
  })

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

type McpListApi = {
  readonly list: (input?: McpListInput) => Promise<McpListOutput>
}

type McpResourceApi = {
  readonly resource: {
    readonly catalog: (input?: McpResourceCatalogInput) => Promise<McpResourceCatalogOutput>
  }
}

type ApiQueryOptions<T, K extends readonly unknown[]> = SolidQueryOptions<T, Error, T, K> & {
  initialData?: undefined
  queryKey: K
}

type SessionActiveApi = {
  readonly active: () => Promise<SessionActiveOutput>
}

export const loadMcpQuery = (
  scope: ServerScope,
  directory: string,
  api: McpListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
): ApiQueryOptions<Record<string, McpServer["status"]>, readonly [ServerScope, string, "mcp"]> =>
  queryOptions<
    Record<string, McpServer["status"]>,
    Error,
    Record<string, McpServer["status"]>,
    readonly [ServerScope, string, "mcp"]
  >({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: () =>
      runRequest(
        Effect.gen(function* () {
          if ((yield* isLegacyProtocol(protocol)) && legacy) {
            const result = yield* request(() => legacy.mcp.status())
            return result.data ?? {}
          }
          const result = yield* request(() => api.list({ location: { directory } }))
          return Object.fromEntries(result.data.map((server) => [server.name, server.status]))
        }),
      ),
  })

export const loadMcpResourcesQuery = (
  scope: ServerScope,
  directory: string,
  api: McpResourceApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
): ApiQueryOptions<Record<string, McpResource>, readonly [ServerScope, string, "mcpResources"]> =>
  queryOptions<
    Record<string, McpResource>,
    Error,
    Record<string, McpResource>,
    readonly [ServerScope, string, "mcpResources"]
  >({
    queryKey: [scope, directory, "mcpResources"] as const,
    queryFn: () =>
      runRequest(
        Effect.gen(function* () {
          if ((yield* isLegacyProtocol(protocol)) && legacy) {
            const result = yield* request(() => legacy.experimental.resource.list())
            return Object.fromEntries(
              Object.entries(result.data ?? {}).map(([key, resource]) => [
                key,
                { ...resource, server: resource.client },
              ]),
            )
          }
          const result = yield* request(() => api.resource.catalog({ location: { directory } }))
          return Object.fromEntries(
            result.data.resources.map((resource) => [`${resource.server}:${resource.uri}`, resource]),
          )
        }),
      ),
    placeholderData: {},
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

export const loadActiveSessionsQuery = (
  scope: ServerScope,
  api: SessionActiveApi,
): ApiQueryOptions<SessionActiveOutput, readonly [ServerScope, "activeSessions"]> =>
  queryOptions<SessionActiveOutput, Error, SessionActiveOutput, readonly [ServerScope, "activeSessions"]>({
    queryKey: [scope, "activeSessions"] as const,
    queryFn: () => api.active(),
    enabled: true,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

export function seedActiveSessionStatuses(
  session: Pick<ServerSession, "data" | "set">,
  active: SessionActiveOutput | Record<string, SessionStatus>,
) {
  for (const sessionID of Object.keys(active)) {
    if (session.data.session_status[sessionID] !== undefined) continue
    const status = active[sessionID]
    session.set("session_status", sessionID, status?.type === "running" ? { type: "busy" } : status)
  }
}

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  serverAPI: ServerApi,
  sdkFor: (dir: PathKey) => OpencodeClient,
  protocol: Promise<"v1" | "v2">,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK(), protocol),
    projects: () => loadProjectsQuery(scope, serverAPI.project),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, serverAPI, directory ? sdkFor(directory) : serverSDK(), protocol),
    /** The server-wide provider catalog, the same query as `providers(null)`. */
    serverProviders: () => loadProvidersQueryFor(scope, Option.none(), serverAPI, serverSDK(), protocol),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory ? sdkFor(directory) : serverSDK(), protocol),
    /** The server-wide path, the same query as `path(null)`. */
    serverPath: () => loadPathQueryFor(scope, Option.none(), serverSDK(), protocol),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, serverAPI.agent, sdkFor(directory), protocol),
    references: (directory: PathKey) =>
      loadReferencesQuery(scope, directory, serverAPI.reference, sdkFor(directory), protocol),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, serverAPI.mcp, sdkFor(directory), protocol),
    mcpResources: (directory: PathKey) =>
      loadMcpResourcesQuery(scope, directory, serverAPI.mcp, sdkFor(directory), protocol),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  // The context is built synchronously while Solid renders, so a missing owner is thrown, not returned as an Effect.
  const owner = Option.getOrThrowWith(
    Option.fromNullishOr(getOwner()),
    () => new ServerSyncOwnerError({ message: "ServerSync must be created within owner" }),
  )

  const sdkCache = MutableHashMap.empty<string, OpencodeClient>()
  const booting = MutableHashMap.empty<string, Promise<void>>()
  const sessionLoads = MutableHashMap.empty<string, Promise<void>>()
  const sessionMeta = MutableHashMap.empty<string, { limit: number }>()

  /** The session limit that a directory keeps after its last session load, if it has one. */
  const retainedLimitOf = (key: string) => Option.map(MutableHashMap.get(sessionMeta, key), (meta) => meta.limit)

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    return Option.getOrElse(MutableHashMap.get(sdkCache, key), () => {
      const sdk = serverSDK.createClient({
        directory,
        throwOnError: true,
      })
      MutableHashMap.set(sdkCache, key, sdk)
      return sdk
    })
  }

  const session = createServerSession(serverSDK.client, serverSDK.api.session, serverSDK.api.message, {
    protocol: serverSDK.protocol,
  })

  /** Starts a lookup of each session without waiting for it. A failed lookup is ignored, as before. */
  const resolveInBackground = (sessionIDs: ReadonlyArray<string>) =>
    Effect.forEach(
      sessionIDs,
      (sessionID) =>
        Effect.forkDetach(request(() => session.resolve(sessionID)).pipe(Effect.ignore), { startImmediately: true }),
      { discard: true },
    )
  const queryOptionsApi = makeQueryOptionsApi(
    serverSDK.scope,
    () => serverSDK.client,
    serverSDK.api,
    sdkFor,
    serverSDK.protocol,
  )

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.serverProviders(), queryOptionsApi.serverPath()],
  }))
  const activeSessionsQuery = useQuery(() =>
    loadActiveSessionsQuery(serverSDK.scope, {
      active: () =>
        runRequest(
          Effect.gen(function* () {
            if (yield* isLegacyProtocol(serverSDK.protocol)) {
              const statuses = (yield* request(() => serverSDK.client.session.status())).data ?? {}
              seedActiveSessionStatuses(session, statuses)
              yield* resolveInBackground(Object.keys(statuses))
              return Object.fromEntries(
                Object.entries(statuses).flatMap(([sessionID, status]) =>
                  status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
                ),
              )
            }
            const active = yield* request(() => serverSDK.api.session.active())
            seedActiveSessionStatuses(session, active)
            yield* resolveInBackground(Object.keys(active))
            return active
          }),
        ),
    }),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY: NormalizedProviderListResponse = { all: HashMap.empty(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      if (updateConfigMutation.isPending) return "pending"
      return undefined
    },
  })

  const queryClient = useQueryClient()
  const homeSessions = createHomeSessionIndexCache(queryClient, ServerConnection.key(serverSDK.server))
  const refreshProviders = () =>
    queryClient.refetchQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })

  let bootedAt = 0
  let bootingRoot = false
  // The owner's cleanup interrupts a pending event-stream start, which also cancels its frame request.
  const eventStart = createFiberSlot()

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: (): Promise<number> =>
      runRequest(
        Effect.gen(function* () {
          yield* request(() =>
            bootstrapGlobal({
              serverSDK: serverSDK.client,
              serverAPI: serverSDK.api,
              protocol: serverSDK.protocol,
              scope: serverSDK.scope,
              requestFailedTitle: language.t("common.requestFailed"),
              translate: language.t,
              formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
              setGlobalStore,
              queryClient,
            }),
          )
          bootedAt = yield* Clock.currentTimeMillis
          return bootedAt
        }),
      ),
  }))

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => MutableHashMap.has(booting, directory),
    isLoadingSessions: (directory) => MutableHashMap.has(sessionLoads, directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      Effect.runFork(
        request(() => loadCommands(directory, serverSDK.api.command, sdkFor(directory), serverSDK.protocol)).pipe(
          Effect.flatMap((commands) => Effect.sync(() => setStore("command", commands))),
          Effect.catch((error) =>
            Effect.sync(() =>
              showToast({
                variant: "error",
                title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
                description: formatServerError(error.cause, language.t),
              }),
            ),
          ),
        ),
      )
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      MutableHashMap.remove(sessionMeta, key)
      MutableHashMap.remove(sdkCache, key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  function loadSessions(directory: string, options?: { limit?: number }): Promise<void> {
    const key = directoryKey(directory)
    const pending = MutableHashMap.get(sessionLoads, key)
    if (Option.isSome(pending)) {
      const inFlight = pending.value
      return runRequest(request(() => inFlight).pipe(Effect.andThen(request(() => loadSessions(directory, options)))))
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = retainedLimitOf(key)
    const retainedLimit = Math.max(
      store.limit,
      options?.limit ?? 0,
      Option.getOrElse(meta, () => 0),
    )
    if (Option.exists(meta, (limit) => limit >= retainedLimit)) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return Effect.runPromise(Effect.void)
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    // The query data records whether the page loaded; tanstack query does not accept undefined data.
    const loadPage = Effect.gen(function* () {
      const x = (yield* isLegacyProtocol(serverSDK.protocol))
        ? yield* loadRootSessionsV1({ client: sdkFor(directory), directory, limit })
        : yield* loadRootSessions({ api: serverSDK.api.session, directory, limit })
      const nonArchived = (x.data ?? [])
        .filter((s) => !!s?.id)
        .filter((s) => !s.time?.archived)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const keep = Math.max(
        store.limit,
        options?.limit ?? 0,
        Option.getOrElse(retainedLimitOf(key), () => 0),
      )
      const childSessions = store.session.filter((s) => !!s.parentID)
      const next = trimSessions([...nonArchived, ...childSessions], {
        limit: keep,
        permission: session.data.permission,
      })
      batch(() => {
        next.forEach(session.remember)
        setStore(
          "sessionTotal",
          estimateRootSessionTotal({
            count: nonArchived.length,
            limit: x.limit,
            limited: x.limited,
          }),
        )
        setStore("session", reconcile(next, { key: "id" }))
      })
      MutableHashMap.set(sessionMeta, key, { limit: keep })
      return true
    }).pipe(
      // Any failure of the page load, a thrown bug included, ends in the toast, as the old .catch did.
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = rejection(cause)
          yield* Effect.logError("Failed to load sessions", error)
          const project = getFilename(directory)
          showToast({
            variant: "error",
            title: language.t("toast.session.listFailed.title", { project }),
            description: formatServerError(error, language.t),
          })
          return false
        }),
      ),
    )

    const loading = runRequest(
      request(() =>
        queryClient.fetchQuery({ ...queryOptionsApi.sessions(key), queryFn: () => Effect.runPromise(loadPage) }),
      ).pipe(
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            MutableHashMap.remove(sessionLoads, key)
            children.unpin(key)
          }),
        ),
      ),
    )
    MutableHashMap.set(sessionLoads, key, loading)
    return loading
  }

  function bootstrapInstance(directory: string): Promise<void> {
    const key = directoryKey(directory)
    if (!key) return Effect.runPromise(Effect.void)
    const pending = MutableHashMap.get(booting, key)
    if (Option.isSome(pending)) return pending.value

    children.pin(key)
    const booted = runRequest(
      Effect.gen(function* () {
        // Yield first, as the old Promise.resolve().then did, so this call records the boot
        // before ensureChild can ask for another one.
        yield* Effect.yieldNow
        const child = children.ensureChild(directory)
        const cache = children.vcsCache.get(key)
        if (!cache) return
        const sdk = sdkFor(directory)
        yield* request(() =>
          bootstrapDirectory({
            directory,
            scope: serverSDK.scope,
            mcp: children.mcp(key),
            global: {
              config: globalStore.config,
              path: globalStore.path,
              project: globalStore.project,
              provider: globalStore.provider,
            },
            sdk,
            api: serverSDK.api,
            store: child[0],
            setStore: child[1],
            vcsCache: cache,
            loadSessions,
            translate: language.t,
            queryClient,
            session,
            protocol: serverSDK.protocol,
          }),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            MutableHashMap.remove(booting, key)
            children.unpin(key)
          }),
        ),
      ),
    )
    MutableHashMap.set(booting, key, booted)
    return booted
  }

  const indexSession = (info: Parameters<typeof session.remember>[0]) => {
    const key = directoryKey(info.directory)
    const existing = children.children[key]
    if (!existing) return
    applyDirectoryEvent({
      event: { type: "session.created", properties: { info } },
      directory: key,
      store: existing[0],
      setStore: existing[1],
      push: queue.push,
      retainedLimit: Option.getOrUndefined(retainedLimitOf(key)),
      sessionContent: false,
      permission: session.data.permission,
      loadLsp() {},
    })
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const eventType: string = event.type
    const recent = bootingRoot || DateTime.toEpochMillis(DateTime.nowUnsafe()) - bootedAt < 1500

    if (event.current) session.applyV2(event.current)
    session.apply(event)
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
      homeSessions.apply(event)
    }
    homeSessions.refresh(event.type)
    if (eventType === "integration.connection.updated") void refreshProviders()

    if (directory === "global") {
      if (eventType === "server.connected" && activeSessionsQuery.data === undefined && !activeSessionsQuery.isFetching)
        void activeSessionsQuery.refetch()
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (
        eventType === "config.updated" ||
        eventType === "catalog.updated" ||
        eventType === "agent.updated" ||
        eventType === "project.directories.updated"
      )
        bootstrap.refetch()
      if (eventType === "server.connected" || eventType === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          if (!children.active(directory)) continue
          queue.push(directory)
        }
      }
      return
    }

    if (event.current?.type === "session.moved") {
      const info = session.get(event.current.data.sessionID)
      if (info) indexSession(info)
    }
    if (event.current?.type === "session.forked") {
      const sessionID = event.current.data.sessionID
      Effect.runFork(
        request(() => session.resolve(sessionID, { force: true })).pipe(
          Effect.flatMap((info) => Effect.sync(() => indexSession(info))),
          Effect.ignore,
        ),
      )
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    if (
      event.current?.type === "session.moved" ||
      // event.current?.type === "session.archived" ||
      event.current?.type === "session.forked" ||
      eventType === "command.updated" ||
      eventType === "config.updated" ||
      eventType === "agent.updated"
    )
      queue.push(key)
    if (eventType === "mcp.status.changed") void queryClient.invalidateQueries(queryOptionsApi.mcp(key))
    if (eventType === "mcp.resources.changed") void queryClient.invalidateQueries(queryOptionsApi.mcpResources(key))
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: (directory) => {
        if (children.active(directory)) queue.push(directory)
      },
      retainedLimit: Option.getOrUndefined(retainedLimitOf(key)),
      sessionContent: false,
      permission: session.data.permission,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
      loadReferences: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.references(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    // Start the event stream after the next frame (when the platform has frames) and one timer turn.
    // The stream handles its own errors, and nothing waits for it, so `void` discards its promise.
    eventStart.run(
      (typeof requestAnimationFrame === "function" ? nextFrame : Effect.void).pipe(
        Effect.andThen(Effect.sleep("0 millis")),
        Effect.andThen(
          Effect.sync(() => {
            void serverSDK.event.start()
          }),
        ),
      ),
    )
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config1: config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: queryOptionsApi.serverProviders().queryKey })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  return {
    data: globalStore,
    set: setGlobalStore,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    refreshProviders,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    session,
    homeSessions,
    mcp: {
      toggle: (directory: string, name: string): Promise<void> => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name]?.status
        if (!status) return Effect.runPromise(Effect.void)
        const api = serverSDK.api.mcp
        return runRequest(
          request(() =>
            toggleMcp({
              status,
              connect: () =>
                runRequest(
                  Effect.gen(function* () {
                    if (yield* isLegacyProtocol(serverSDK.protocol)) {
                      yield* request(() => sdk.mcp.connect({ name }))
                      return
                    }
                    yield* request(() => api.connect({ server: name, location: { directory: key } }))
                  }),
                ),
              disconnect: () =>
                runRequest(
                  Effect.gen(function* () {
                    if (yield* isLegacyProtocol(serverSDK.protocol)) {
                      yield* request(() => sdk.mcp.disconnect({ name }))
                      return
                    }
                    yield* request(() => api.disconnect({ server: name, location: { directory: key } }))
                  }),
                ),
              authenticate: () => runRequest(request(() => sdk.mcp.auth.authenticate({ name })).pipe(Effect.asVoid)),
              refresh: () =>
                runRequest(
                  Effect.gen(function* () {
                    yield* request(() => queryClient.refetchQueries(queryOptionsApi.mcp(key)))
                    yield* request(() => queryClient.refetchQueries(queryOptionsApi.mcpResources(key)))
                  }),
                ),
            }),
          ),
        )
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      // The memo must return a ServerSync synchronously, so a missing server is thrown for the error boundary.
      const conn = Option.getOrThrowWith(
        Option.fromNullishOr(props.server?.() ?? server.current),
        () => new NoServerAvailableError({ message: language.t("error.serverSDK.noServerAvailable") }),
      )
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}

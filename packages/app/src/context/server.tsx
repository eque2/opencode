import { createSimpleContext } from "@opencode-ai/ui/context"
import { absurd, Brand, MutableHashMap, MutableHashSet, Option, Predicate } from "effect"
import { type Accessor, batch, createMemo } from "solid-js"
import { createStore, produce, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { ServerScope } from "@/utils/server-scope"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type StoredRecord = { readonly [key: PropertyKey]: unknown }
type ServerProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
  recentlyClosed: Record<string, string[]>
}
// The store retains more history than is displayed. Consumers filter recently closed entries
// against the live project list (dropping deleted projects) and then cap the visible count via
// RECENTLY_CLOSED_DISPLAY_LIMIT. Retaining extra history ensures entries that are temporarily
// filtered out do not evict still-visible ones from the persisted store.
const RECENTLY_CLOSED_HISTORY_LIMIT = 16
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
  return undefined
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!Predicate.isObject(value)) return value
  // A missing or malformed bucket record reads as an empty record, which has no canonical bucket.
  const projects: StoredRecord = Predicate.isObject(value.projects) ? value.projects : {}
  const lastProject: StoredRecord = Predicate.isObject(value.lastProject) ? value.lastProject : {}
  const previousProjects = projects[canonicalLocalServer]
  const previousLastProject = lastProject[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string") return value

  const next = { ...value }
  if (Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = MutableHashSet.fromIterable(
      local.flatMap((project) =>
        Predicate.isObject(project) && typeof project.worktree === "string" ? [project.worktree] : [],
      ),
    )
    const migrated = previousProjects.filter((project) => {
      if (!Predicate.isObject(project) || typeof project.worktree !== "string") return true
      if (MutableHashSet.has(worktrees, project.worktree)) return false
      MutableHashSet.add(worktrees, project.worktree)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  return next
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  // T may carry more keys than ServerProjectState. Each write edits the
  // ServerProjectState part of the draft in place, so it needs no path types from T.
  const update = (edit: (draft: ServerProjectState) => void) => input.setStore(produce<T>((draft) => edit(draft)))
  const current = () => input.store.projects[input.scope()] ?? []
  const currentClosed = () => input.store.recentlyClosed?.[input.scope()] ?? []
  const remove = (directory: string) => {
    const scope = input.scope()
    const next = current().filter((project) => project.worktree !== directory)
    update((draft) => {
      draft.projects[scope] = next
    })
  }
  return {
    list: current,
    recentlyClosed: currentClosed,
    remove,
    open(directory: string) {
      const scope = input.scope()
      const key = pathKey(directory)
      const closed = currentClosed()
      if (closed.some((worktree) => pathKey(worktree) === key)) {
        const next = closed.filter((worktree) => pathKey(worktree) !== key)
        update((draft) => {
          draft.recentlyClosed[scope] = next
        })
      }
      if (current().some((project) => project.worktree === directory)) return
      const next = [{ worktree: directory, expanded: true }, ...current()]
      update((draft) => {
        draft.projects[scope] = next
      })
    },
    // User-initiated close: removes the project and records it in recently closed.
    // Internal, non-user removals (e.g. sandbox/worktree normalization) should use remove().
    close(directory: string) {
      remove(directory)
      const scope = input.scope()
      const key = pathKey(directory)
      const closed = [directory, ...currentClosed().filter((worktree) => pathKey(worktree) !== key)].slice(
        0,
        RECENTLY_CLOSED_HISTORY_LIMIT,
      )
      update((draft) => {
        draft.recentlyClosed[scope] = closed
      })
    },
    expand(directory: string) {
      const scope = input.scope()
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1)
        update((draft) => {
          draft.projects[scope][index].expanded = true
        })
    },
    collapse(directory: string) {
      const scope = input.scope()
      const index = current().findIndex((project) => project.worktree === directory)
      if (index !== -1)
        update((draft) => {
          draft.projects[scope][index].expanded = false
        })
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => project.worktree === directory)
      if (fromIndex === -1 || fromIndex === toIndex) return
      const scope = input.scope()
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      update((draft) => {
        draft.projects[scope] = next
      })
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      const scope = input.scope()
      update((draft) => {
        draft.lastProject[scope] = directory
      })
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  // MutableHashMap keeps string keys in insertion order, so the list order does not change.
  const deduped = MutableHashMap.fromIterable<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const value of input.stored) {
    const conn: ServerConnection.Http =
      typeof value === "string"
        ? {
            type: "http" as const,
            http: { url: value },
          }
        : "http" in value
          ? value
          : { type: "http", http: value }
    const key = ServerConnection.key(conn)

    const existing = MutableHashMap.get(deduped, key)
    if (Option.isSome(existing))
      MutableHashMap.set(deduped, key, {
        ...existing.value,
        ...conn,
        http: { ...existing.value.http, ...conn.http },
      })
    else MutableHashMap.set(deduped, key, conn)
  }

  return Array.from(MutableHashMap.values(deduped))
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
    return absurd(conn)
  }

  export type Key = string & Brand.Brand<"Key">
  export const Key = { make: Brand.nominal<Key>() }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) => migrateCanonicalLocalServerState(value, props.canonicalLocalServer),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        recentlyClosed: {} as Record<string, string[]>,
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return undefined
      const conn: ServerConnection.Http = { ...input, http: { ...input.http, url: url_ } }
      delete conn.authToken
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
          // The store merges conn into the stored entry, which keeps keys that conn omits.
          // The saved connection never keeps a startup auth token, so remove the key.
          setStore(
            "list",
            existing,
            produce((entry) => {
              if (typeof entry !== "string" && "authToken" in entry) delete entry.authToken
            }),
          )
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
    }

    const isReady = Object.assign(
      createMemo(() => ready() && !!state.active),
      { promise: ready.promise },
    )

    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const projects = createServerProjects({ scope, store, setStore })
    const projectStores = MutableHashMap.empty<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = MutableHashMap.get(projectStores, key)
      if (Option.isSome(existing)) return existing.value
      const next = createServerProjects({ scope: () => scope(key), store, setStore })
      MutableHashMap.set(projectStores, key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})

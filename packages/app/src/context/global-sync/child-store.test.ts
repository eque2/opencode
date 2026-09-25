import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import type { LspStatus, Path, ReferenceInfo } from "@opencode-ai/sdk/v2/client"
import { queryOptions } from "@tanstack/solid-query"
import type { State } from "./types"
import type { ChildQueryOptions } from "./child-store"
import { ServerScope } from "@/utils/server-scope"
import { Chunk, Effect, HashMap, Option } from "effect"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
type QueryAccessor = () => { queryKey?: readonly unknown[]; enabled?: boolean }
let querySingles = Chunk.empty<QueryAccessor>()
// A synchronous persisted store with nothing saved: no stored raw value and no
// pending load, given back in the `string | null` and `Promise | undefined`
// shapes that persisted() returns.
const persist: typeof import("@/utils/persist").persisted = (_target, store) => {
  const stored = Option.none<string>()
  const pending = Option.none<Promise<string>>()
  return [
    store[0],
    store[1],
    Option.getOrNull(stored),
    Object.assign(() => true, { promise: Option.getOrUndefined(pending) }),
  ]
}

const provider: NormalizedProviderListResponse = { all: HashMap.empty(), connected: [], default: {} }

// A directory store as the eviction test needs it: only its presence in
// manager.children matters, so the fields hold plain empty values.
const child = () =>
  createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: {},
    icon: "",
    provider_ready: false,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working: () => false,
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: false,
    mcp: {},
    mcp_resource: {},
    lsp_ready: false,
    lsp: [],
    vcs: {},
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })

// The query factories that child stores subscribe to, keyed like the real
// loaders ([scope, directory, kind]). useQuery is mocked below, so the query
// functions never run.
const queryOptionsApi: ChildQueryOptions = {
  providers: (directory) =>
    queryOptions({
      queryKey: [ServerScope.local, directory, "providers"],
      queryFn: () => Effect.runPromise(Effect.succeed(provider)),
    }),
  path: (directory) =>
    queryOptions<Path>({
      queryKey: [ServerScope.local, directory, "path"],
      queryFn: () =>
        Effect.runPromise(
          Effect.succeed({
            state: "",
            config: "",
            worktree: "",
            directory: directory ?? "",
            home: "",
          }),
        ),
    }),
  mcp: (directory) => ({
    queryKey: [ServerScope.local, directory, "mcp"],
    queryFn: () => Effect.runPromise(Effect.succeed({})),
  }),
  mcpResources: (directory) => ({
    queryKey: [ServerScope.local, directory, "mcpResources"],
    queryFn: () => Effect.runPromise(Effect.succeed({})),
  }),
  lsp: (directory: string) =>
    queryOptions({
      queryKey: [ServerScope.local, directory, "lsp"] as const,
      queryFn: () => Effect.runPromise(Effect.succeed<LspStatus[]>([])),
    }),
  references: (directory) =>
    queryOptions<ReferenceInfo[]>({
      queryKey: [ServerScope.local, directory, "references"],
      queryFn: () => Effect.runPromise(Effect.succeed([])),
    }),
}

// The mocked query records each options accessor; tests find a query by the
// last queryKey element.
const queryKind = (options: QueryAccessor) => options().queryKey?.at(-1)

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(() => {
  mock.module("@tanstack/solid-query", () => ({
    queryOptions,
    useQuery: (options: QueryAccessor) => {
      querySingles = Chunk.append(querySingles, options)
      return {
        get isLoading() {
          return queryKind(options) === "path"
        },
        get data() {
          if (queryKind(options) === "path") throw new Error("pending path data read")
          if (queryKind(options) === "mcp" && options().enabled) return { demo: { status: "disabled" } }
          if (queryKind(options) === "lsp") return []
          if (queryKind(options) === "providers") return provider
          return undefined
        },
      }
    },
  }))

  return Effect.runPromise(
    Effect.promise(() => import("./child-store")).pipe(
      Effect.map((module) => {
        createChildStoreManager = module.createChildStoreManager
      }),
    ),
  )
})

describe("createChildStoreManager", () => {
  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      scope: ServerScope.local,
      persist,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onMcp() {},
      onDispose() {},
      translate: (key) => key,
      queryOptions: queryOptionsApi,
      global: { provider },
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("starts new child stores as loading and bootstraps them on first access", () => {
    let bootstraps = Chunk.empty<string>()
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps = Chunk.append(bootstraps, directory)
        },
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project")

      expect(store.status).toBe("loading")
      expect(store.limit).toBe(5)
      expect(Chunk.toReadonlyArray(bootstraps)).toEqual(["/project"])
    } finally {
      dispose()
    }
  })

  test("provides the requested directory while the path query is pending", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.path.directory).toBe("/project")
      expect(store.path.worktree).toBe("")
    } finally {
      dispose()
    }
  })

  test("enables MCP only when requested for the directory", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = Chunk.size(querySingles)
    let mcpLoads = Chunk.empty<string>()

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onMcp(directory) {
          mcpLoads = Chunk.append(mcpLoads, directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store, setStore] = manager.child("/project", { bootstrap: false })
      expect(Chunk.size(querySingles) - offset).toBe(6)
      const query = Chunk.toReadonlyArray(querySingles)[offset + 1]
      const resourceQuery = Chunk.toReadonlyArray(querySingles)[offset + 2]
      if (!query) throw new Error("query required")
      if (!resourceQuery) throw new Error("resource query required")
      expect(query().enabled).toBe(false)
      expect(resourceQuery().enabled).toBe(false)

      setStore("status", "complete")
      manager.child("/project", { bootstrap: false, mcp: true })
      expect(query().enabled).toBe(true)
      expect(resourceQuery().enabled).toBe(true)
      expect(store.mcp).toEqual({ demo: { status: "disabled" } })
      expect(Chunk.toReadonlyArray(mcpLoads)).toEqual(["/project"])

      manager.disableMcp("/project")
      expect(query().enabled).toBe(false)
      expect(manager.mcp("/project")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("keeps non-bootstrapping children passive until a real directory access", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = Chunk.size(querySingles)
    let bootstraps = Chunk.empty<string>()

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps = Chunk.append(bootstraps, directory)
        },
        onMcp() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store] = manager.child("/project", { bootstrap: false })
      const queries = Chunk.toReadonlyArray(Chunk.drop(querySingles, offset))

      expect(queries).toHaveLength(6)
      expect(queries[0]?.().enabled).toBe(false)
      expect(queries[3]?.().enabled).toBe(false)
      expect(queries[4]?.().enabled).toBe(false)
      expect(queries[5]?.().enabled).toBe(false)
      expect(store.path.directory).toBe("/project")
      expect(store.provider_ready).toBe(false)
      expect(store.lsp_ready).toBe(false)
      expect(Chunk.toReadonlyArray(bootstraps)).toEqual([])

      manager.child("/project")
      expect(queries[0]?.().enabled).toBe(true)
      expect(queries[3]?.().enabled).toBe(true)
      expect(queries[4]?.().enabled).toBe(true)
      expect(queries[5]?.().enabled).toBe(true)
      expect(Chunk.toReadonlyArray(bootstraps)).toEqual(["/project"])

      manager.child("/project", { bootstrap: false })
      expect(queries[0]?.().enabled).toBe(true)
    } finally {
      dispose()
    }
  })
})

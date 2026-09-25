import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import { Array as Arr, Data, Effect, HashMap, Option } from "effect"
import type { Config } from "@opencode-ai/sdk/v2/client"
import type { ModelInfo } from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadProvidersQueryFor,
  loadReferencesQuery,
} from "./bootstrap"
import type { State } from "./types"
import { ServerScope } from "@/utils/server-scope"
import { createApiForServer, createSdkForServer } from "@/utils/server"
import { ServerConnection } from "@/context/server"

const provider = { all: HashMap.empty(), connected: [], default: {} } satisfies NormalizedProviderListResponse

/** A request that the fake server has no route for, or that a test forbids. */
class UnexpectedRequest extends Data.TaggedError("UnexpectedRequest")<{ readonly message: string }> {}

/** Answers one `METHOD /path` request with a JSON body. */
type Route = () => Effect.Effect<unknown, UnexpectedRequest>

/** Real legacy and current clients whose fetch answers from `routes` and rejects every other request. */
function serve(routes: Readonly<Record<string, Route>>) {
  const fetcher = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      const key = `${request.method} ${new URL(request.url).pathname}`
      const route = Option.fromNullishOr(routes[key])
      const body: Effect.Effect<unknown, UnexpectedRequest> = Option.isSome(route)
        ? route.value()
        : Effect.fail(new UnexpectedRequest({ message: `unexpected request ${key}` }))
      return Effect.runPromise(Effect.map(body, (value) => Response.json(value)))
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://opencode.test" }
  return {
    sdk: createSdkForServer({ server, fetch: fetcher, throwOnError: true }),
    api: createApiForServer({ server, fetch: fetcher }),
  }
}

/** A route that answers with `body`. */
const reply =
  (body: unknown): Route =>
  () =>
    Effect.succeed(body)

/** A fake API call that resolves with `value`. */
const resolved = <A>(value: A) => Effect.runPromise(Effect.succeed(value))

/** The location block that every current endpoint returns. */
const location = (directory: string) => ({ directory, project: { id: "project", directory } })

/** The model default reply for a catalog whose default model is `defaultModel`; the wire format sends none as null. */
const modelDefault = (directory: string, defaultModel: Option.Option<ModelInfo>) => ({
  location: location(directory),
  data: Option.getOrNull(defaultModel),
})

const currentRoutes = {
  "GET /api/agent": reply({ location: {}, data: [] }),
  "GET /api/provider": reply({ location: {}, data: [] }),
  "GET /api/model": reply({ location: {}, data: [] }),
  "GET /api/model/default": reply(modelDefault("/project", Option.none())),
  "GET /api/permission/request": reply({ location: {}, data: [] }),
  "GET /api/project": reply([]),
  "GET /api/project/current": reply({ id: "project", directory: "/project" }),
  "GET /api/question/request": reply({ location: {}, data: [] }),
  "GET /api/reference": reply({ location: {}, data: [] }),
}

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("uses legacy MCP endpoints while refreshing a v1 directory", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let legacyConfigReads: string[] = []
        let mcpReads: string[] = []
        const [store, setStore] = directoryState()
        const { sdk, api } = serve({
          ...currentRoutes,
          "GET /agent": reply([{ name: "build", mode: "primary" }]),
          "GET /config": () =>
            Effect.sync(() => {
              legacyConfigReads = Arr.append(legacyConfigReads, "directory")
              return {}
            }),
          "GET /session/status": reply({}),
          "GET /vcs": reply({}),
          "GET /command": () =>
            Effect.sync(() => {
              mcpReads = Arr.append(mcpReads, "command")
              return []
            }),
          "GET /permission": reply([]),
          "GET /question": reply([]),
          "GET /mcp": () =>
            Effect.sync(() => {
              mcpReads = Arr.append(mcpReads, "status")
              return {}
            }),
          "GET /experimental/resource": () =>
            Effect.sync(() => {
              mcpReads = Arr.append(mcpReads, "resource")
              return {}
            }),
          "GET /provider": reply({ all: [], connected: [], default: {} }),
        })

        yield* Effect.promise(() =>
          bootstrapDirectory({
            directory: "/project",
            scope: ServerScope.local,
            mcp: true,
            global: {
              config: {} satisfies Config,
              path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
              project: [{ id: "project", worktree: "/project", time: { created: 1, updated: 1 }, sandboxes: [] }],
              provider,
            },
            sdk,
            api,
            store,
            setStore,
            vcsCache: { setStore() {} },
            loadSessions() {},
            translate: (key) => key,
            queryClient: new QueryClient(),
            protocol: resolved("v1"),
          }),
        )

        expect(store.status).toBe("partial")

        yield* Effect.sleep("80 millis")

        expect(store.status).toBe("complete")
        expect(legacyConfigReads).toEqual(["directory"])
        expect(mcpReads.sort()).toEqual(["command", "resource", "status"])
      }),
    ))

  test("skips legacy config while refreshing a v2 directory", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const [store, setStore] = directoryState()
        const { sdk, api } = serve({
          ...currentRoutes,
          "GET /config": () =>
            Effect.fail(new UnexpectedRequest({ message: "legacy directory config should not be called" })),
        })

        yield* Effect.promise(() =>
          bootstrapDirectory({
            directory: "/project",
            scope: ServerScope.local,
            mcp: false,
            global: {
              config: {} satisfies Config,
              path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
              project: [{ id: "project", worktree: "/project", time: { created: 1, updated: 1 }, sandboxes: [] }],
              provider,
            },
            sdk,
            api,
            store,
            setStore,
            vcsCache: { setStore() {} },
            loadSessions() {},
            translate: (key) => key,
            queryClient: new QueryClient(),
            protocol: resolved("v2"),
          }),
        )

        expect(store.status).toBe("partial")

        yield* Effect.sleep("80 millis")

        expect(store.status).toBe("complete")
      }),
    ))
})

describe("config queries", () => {
  test("skips legacy global config for v2 servers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { sdk } = serve({
          "GET /global/config": () =>
            Effect.fail(new UnexpectedRequest({ message: "legacy global config should not be called" })),
        })

        const result = yield* Effect.promise(() =>
          new QueryClient().fetchQuery(loadGlobalConfigQuery(ServerScope.local, sdk, resolved("v2"))),
        )

        expect(result).toEqual({})
      }),
    ))

  test("loads legacy global config for v1 servers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: string[] = []
        const config = { shell: "zsh" } satisfies Config
        const { sdk } = serve({
          "GET /global/config": () =>
            Effect.sync(() => {
              calls = Arr.append(calls, "global")
              return config
            }),
        })

        const result = yield* Effect.promise(() =>
          new QueryClient().fetchQuery(loadGlobalConfigQuery(ServerScope.local, sdk, resolved("v1"))),
        )

        expect(result).toEqual(config)
        expect(calls).toEqual(["global"])
      }),
    ))
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const { sdk: client, api } = serve({})
    const remote = ServerScope.fromServerKey(ServerConnection.Key.make("https://debian.example"))

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    const globalProviders = [...loadProvidersQueryFor(remote, Option.none(), api).queryKey]
    expect(globalProviders).toHaveLength(3)
    expect(globalProviders[0]).toBe("https://debian.example")
    expect(globalProviders[1]).toBeNull()
    expect(globalProviders[2]).toBe("providers")
  })

  test("loads the current provider and model catalog", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: unknown[] = []
        const api: Parameters<typeof loadProvidersQuery>[2] = {
          provider: {
            list: (input: unknown) => {
              calls = Arr.append(calls, ["provider", input])
              return resolved({
                location: location("/repo"),
                data: [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }],
              })
            },
          },
          model: {
            list: (input: unknown) => {
              calls = Arr.append(calls, ["model", input])
              return resolved({ location: location("/repo"), data: [] })
            },
            default: (input: unknown) => {
              calls = Arr.append(calls, ["default", input])
              return resolved(modelDefault("/repo", Option.none()))
            },
          },
        }

        const result = yield* Effect.promise(() =>
          new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api)),
        )

        expect(calls).toEqual([
          ["provider", { location: { directory: "/repo" } }],
          ["model", { location: { directory: "/repo" } }],
          ["default", { location: { directory: "/repo" } }],
        ])
        expect(result.connected).toEqual(["openai"])
      }),
    ))

  test("loads agents from the current location-scoped endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: unknown[] = []
        const api: Parameters<typeof loadAgentsQuery>[2] = {
          list: (input: unknown) => {
            calls = Arr.append(calls, input)
            return resolved({ location: location("/repo"), data: [] })
          },
        }

        const result = yield* Effect.promise(() =>
          new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api)),
        )

        expect(calls).toEqual([{ location: { directory: "/repo" } }])
        expect(result).toEqual([])
      }),
    ))

  test("loads commands from the current location-scoped endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: unknown[] = []
        const api: Parameters<typeof loadCommands>[1] = {
          list: (input: unknown) => {
            calls = Arr.append(calls, input)
            return resolved({
              location: location("/repo"),
              data: [{ name: "review", template: "Review files" /* source: "command" as const */ }],
            })
          },
        }

        const result = yield* Effect.promise(() => loadCommands("/repo", api))

        expect(calls).toEqual([{ location: { directory: "/repo" } }])
        expect(result).toEqual([{ name: "review", template: "Review files" /* source: "command" */ }])
      }),
    ))

  test("loads projects from the current endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const api: Parameters<typeof loadProjectsQuery>[1] = {
          list: () =>
            resolved([
              { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
              { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
            ]),
        }

        const result = yield* Effect.promise(() =>
          new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api)),
        )

        expect(result.map((project) => project.id)).toEqual(["a", "b"])
      }),
    ))

  test("loads references from the current location-scoped endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: unknown[] = []
        const api: Parameters<typeof loadReferencesQuery>[2] = {
          list: (input: unknown) => {
            calls = Arr.append(calls, input)
            return resolved({
              location: location("/repo"),
              data: [
                { name: "AGENTS.md", path: "/repo/AGENTS.md", source: { type: "local", path: "/repo/AGENTS.md" } },
              ],
            })
          },
        }

        const result = yield* Effect.promise(() =>
          new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api)),
        )

        expect(calls).toEqual([{ location: { directory: "/repo" } }])
        expect(result).toHaveLength(1)
      }),
    ))
})

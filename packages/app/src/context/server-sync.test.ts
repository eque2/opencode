import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  McpListInput,
  McpListOutput,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  SessionActiveOutput,
  SessionApi,
  SessionInfo,
  SessionListInput,
} from "@opencode-ai/client/promise"
import { QueryClient } from "@tanstack/solid-query"
import { Data, Effect, Option } from "effect"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessions } from "./global-sync/session-load"
import { loadActiveSessionsQuery, loadMcpQuery, loadMcpResourcesQuery, seedActiveSessionStatuses } from "./server-sync"
import { ServerScope } from "@/utils/server-scope"
import { createServerSession } from "./server-session"

/** The failure a stub session API rejects with. */
class ListFailedError extends Data.TaggedError("ListFailedError")<{ readonly message: string }> {}

describe("MCP queries", () => {
  test("loads current servers for the requested location", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: ReadonlyArray<unknown> = []
        const queryClient = new QueryClient()
        const result = yield* Effect.promise(() =>
          queryClient.fetchQuery(
            loadMcpQuery(ServerScope.local, "/project", {
              list: (input: McpListInput = {}) => {
                calls = [...calls, input]
                return Effect.runPromise(
                  Effect.succeed<McpListOutput>({
                    location: { directory: "/project", project: { id: "project", directory: "/project" } },
                    data: [
                      { name: "docs", status: { status: "connected" } },
                      { name: "search", status: { status: "pending" } },
                    ],
                  }),
                )
              },
            }),
          ),
        )

        expect(calls).toEqual([{ location: { directory: "/project" } }])
        expect(result).toEqual({ docs: { status: "connected" }, search: { status: "pending" } })
      }),
    ))

  test("loads and keys the current resource catalog", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: ReadonlyArray<unknown> = []
        const queryClient = new QueryClient()
        const result = yield* Effect.promise(() =>
          queryClient.fetchQuery(
            loadMcpResourcesQuery(ServerScope.local, "/project", {
              resource: {
                catalog: (input: McpResourceCatalogInput = {}) => {
                  calls = [...calls, input]
                  return Effect.runPromise(
                    Effect.succeed<McpResourceCatalogOutput>({
                      location: { directory: "/project", project: { id: "project", directory: "/project" } },
                      data: {
                        resources: [{ server: "docs", name: "Guide", uri: "docs://guide" }],
                        templates: [],
                      },
                    }),
                  )
                },
              },
            }),
          ),
        )

        expect(calls).toEqual([{ location: { directory: "/project" } }])
        expect(result).toEqual({ "docs:docs://guide": { server: "docs", name: "Guide", uri: "docs://guide" } })
      }),
    ))
})

describe("active session query", () => {
  test("loads active sessions immediately and once per server cache", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0
        const queryClient = new QueryClient()
        const options = loadActiveSessionsQuery(ServerScope.local, {
          active: () => {
            calls++
            return Effect.runPromise(Effect.succeed<SessionActiveOutput>({ ses_running: { type: "running" } }))
          },
        })

        expect(yield* Effect.promise(() => queryClient.fetchQuery(options))).toEqual({
          ses_running: { type: "running" },
        })
        expect(yield* Effect.promise(() => queryClient.fetchQuery(options))).toEqual({
          ses_running: { type: "running" },
        })
        expect(calls).toBe(1)
        expect(options.enabled).toBe(true)
        expect([...options.queryKey]).toEqual([ServerScope.local, "activeSessions"])
      }),
    ))

  test("does not overwrite statuses already written by events", () => {
    const session = createServerSession(createOpencodeClient())
    session.set("session_status", "ses_retry", { type: "retry", attempt: 2, message: "retrying", next: 10 })

    seedActiveSessionStatuses(session, {
      ses_running: { type: "running" },
      ses_retry: { type: "running" },
    })

    expect(session.data.session_status.ses_running).toEqual({ type: "busy" })
    expect(session.data.session_status.ses_retry).toEqual({
      type: "retry",
      attempt: 2,
      message: "retrying",
      next: 10,
    })
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessions", () => {
  test("loads and normalizes a limited page of root sessions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls: ReadonlyArray<SessionListInput> = []

        const result = yield* loadRootSessions({
          api: {
            list: (query = {}) => {
              calls = [...calls, query]
              return Effect.runPromise(Effect.succeed({ data: [sessionInfo("session-1")], cursor: {} }))
            },
          } satisfies Pick<SessionApi, "list">,
          directory: "dir",
          limit: 10,
        })

        expect(result.data).toEqual([
          expect.objectContaining({ id: "session-1", directory: "dir", slug: "session-1", version: "" }),
        ])
        expect(result.limited).toBe(true)
        // The root-session filter reaches the API as parentID null.
        expect(calls).toEqual([
          { directory: "dir", parentID: Option.getOrNull(Option.none()), limit: 10, order: "desc" },
        ])
      }),
    ))

  test("propagates list failures", () => {
    expect(
      Effect.runPromise(
        loadRootSessions({
          api: {
            list: () => Effect.runPromise(Effect.fail(new ListFailedError({ message: "failed" }))),
          } satisfies Pick<SessionApi, "list">,
          directory: "dir",
          limit: 25,
        }).pipe(Effect.mapError((error) => error.cause)),
      ),
    ).rejects.toThrow("failed")
  })
})

function sessionInfo(id: string) {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "dir" },
  } as SessionInfo
}

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})

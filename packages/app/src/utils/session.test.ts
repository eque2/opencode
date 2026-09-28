import { describe, expect, test } from "bun:test"
import type { SessionApi, SessionInfo, SessionListInput } from "@opencode-ai/client/promise"
import { Chunk, Effect, HashMap, Option } from "effect"
import { listAllSessions, normalizeSessionInfo, type RawSessionInfo } from "./session"

describe("normalizeSessionInfo", () => {
  test("adapts a current session to the app session shape", () => {
    const result = normalizeSessionInfo({
      id: "session-1",
      projectID: "project-1",
      agent: "build",
      model: { id: "gpt-5", providerID: "openai", variant: "high" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      title: "New session",
      location: { directory: "/repo/worktree", workspaceID: "workspace-1" },
      subpath: "worktree",
      revert: { messageID: "message-1", partID: "part-1", snapshot: "snapshot", files: [] },
    } as SessionInfo)

    expect(result).toEqual({
      id: "session-1",
      slug: "session-1",
      projectID: "project-1",
      workspaceID: "workspace-1",
      directory: "/repo/worktree",
      path: "worktree",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      title: "New session",
      agent: "build",
      model: { id: "gpt-5", providerID: "openai", variant: "high" },
      version: "",
      time: { created: 1, updated: 1 },
      revert: { messageID: "message-1", partID: "part-1", snapshot: "snapshot" },
    })
  })

  test("supplies timestamped titles for untitled current sessions", () => {
    const root = currentSession("session-1")
    const child = currentSession("session-2", "session-1")

    expect(normalizeSessionInfo(root).title).toBe("New session - 1970-01-01T00:00:00.000Z")
    expect(normalizeSessionInfo(child).title).toBe("Child session - 1970-01-01T00:00:00.000Z")
  })
})

describe("listAllSessions", () => {
  test("loads every page in server order and retains the query", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = Chunk.empty<SessionListInput>()
        const pages = HashMap.make(
          [
            Option.none<string>(),
            { data: [sessionInfo("session-3"), sessionInfo("session-2")], cursor: { next: "next" } },
          ],
          [Option.some("next"), { data: [sessionInfo("session-1", true)], cursor: {} }],
        )
        const api = {
          list: (query = {}) => {
            calls = Chunk.append(calls, query)
            return Effect.runPromise(
              Effect.succeed(
                Option.getOrElse(HashMap.get(pages, Option.fromNullishOr(query.cursor)), () => ({
                  data: [],
                  cursor: {},
                })),
              ),
            )
          },
        } satisfies Pick<SessionApi, "list">

        const result = yield* listAllSessions(api, { directory: "/repo", order: "desc" })

        expect(result.map((session) => session.id)).toEqual(["session-3", "session-2", "session-1"])
        expect(result[2]?.time.archived).toBe(2)
        expect(Chunk.toReadonlyArray(calls)).toEqual([
          { directory: "/repo", order: "desc", limit: 100 },
          { directory: "/repo", order: "desc", limit: 100, cursor: "next" },
        ])
      }),
    ))

  test("requests the terminal empty page when the server returns a next cursor", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let cursors = Chunk.empty<Option.Option<string>>()
        const api = {
          list: (query = {}) => {
            cursors = Chunk.append(cursors, Option.fromNullishOr(query.cursor))
            if (query.cursor) return Effect.runPromise(Effect.succeed({ data: [], cursor: { next: "unused" } }))
            return Effect.runPromise(Effect.succeed({ data: [sessionInfo("session-1")], cursor: { next: "terminal" } }))
          },
        } satisfies Pick<SessionApi, "list">

        const result = yield* listAllSessions(api, { directory: "/repo", limit: 25 })

        expect(result.map((session) => session.id)).toEqual(["session-1"])
        expect(Chunk.toReadonlyArray(cursors)).toEqual([Option.none(), Option.some("terminal")])
      }),
    ))
})

function sessionInfo(id: string, archived = false): SessionInfo {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1, ...(archived ? { archived: 2 } : {}) },
    title: id,
    location: { directory: "/repo" },
  }
}

function currentSession(id: string, parentID?: string): RawSessionInfo {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/repo" },
  }
}

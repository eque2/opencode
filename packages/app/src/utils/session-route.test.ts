import { describe, expect, test } from "bun:test"
import { Data, Effect, Option } from "effect"
import { ServerConnection } from "@/context/server"
import {
  legacySessionHref,
  legacySessionServer,
  requireServerKey,
  rootSession,
  SessionParentCycleError,
  sessionHref,
} from "./session-route"

class MissingSessionError extends Data.TaggedError("Test.MissingSessionError")<{ readonly message: string }> {}

describe("session routes", () => {
  test("uses the unique persisted server for a legacy session route", () => {
    expect(
      legacySessionServer(
        [{ type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" }],
        "session-1",
        ServerConnection.Key.make("server-a"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("prefers the active server when a legacy session ID is ambiguous", () => {
    expect(
      legacySessionServer(
        [
          { type: "session", server: ServerConnection.Key.make("server-a"), sessionId: "session-1" },
          { type: "session", server: ServerConnection.Key.make("server-b"), sessionId: "session-1" },
        ],
        "session-1",
        ServerConnection.Key.make("server-b"),
      ),
    ).toBe(ServerConnection.Key.make("server-b"))
  })

  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("builds the legacy directory-keyed route", () => {
    expect(legacySessionHref("/Users/example/project", "session-1")).toBe(
      "/L1VzZXJzL2V4YW1wbGUvcHJvamVjdA/session/session-1",
    )
  })

  test("resolves the root session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions: Record<string, { id: string; parentID?: string }> = {
          child: { id: "child", parentID: "parent" },
          parent: { id: "parent", parentID: "root" },
          root: { id: "root" },
        }
        const get = (id: string) =>
          Option.match(Option.fromNullishOr(sessions[id]), {
            onNone: () => Effect.fail(new MissingSessionError({ message: `Missing session: ${id}` })),
            onSome: Effect.succeed,
          })

        expect(yield* rootSession(sessions.child, get)).toBe(sessions.root)
      }),
    ))

  test("rejects a parent cycle", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions: Record<string, { id: string; parentID?: string }> = {
          child: { id: "child", parentID: "parent" },
          parent: { id: "parent", parentID: "child" },
        }
        const get = (id: string) =>
          Option.match(Option.fromNullishOr(sessions[id]), {
            onNone: () => Effect.fail(new MissingSessionError({ message: `Missing session: ${id}` })),
            onSome: Effect.succeed,
          })

        const error = yield* Effect.flip(rootSession(sessions.child, get))
        expect(error).toBeInstanceOf(SessionParentCycleError)
        expect(error.message).toBe("Session parent cycle: child")
      }),
    ))
})

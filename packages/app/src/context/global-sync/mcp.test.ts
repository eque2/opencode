import { describe, expect, test } from "bun:test"
import { toggleMcp } from "./mcp"
import { Chunk, Effect } from "effect"

describe("toggleMcp", () => {
  test("runs the status action before refreshing the owning query", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = Chunk.empty<string>()
        const record = (name: string) =>
          Effect.sync(() => {
            calls = Chunk.append(calls, name)
          })
        const input = (status: "connected" | "needs_auth" | "disabled") => ({
          status,
          connect: record("connect"),
          disconnect: record("disconnect"),
          authenticate: record("authenticate"),
          refresh: record("refresh"),
        })

        yield* toggleMcp(input("connected"))
        expect(Chunk.toReadonlyArray(calls)).toEqual(["disconnect", "refresh"])

        calls = Chunk.empty()
        yield* toggleMcp(input("needs_auth"))
        expect(Chunk.toReadonlyArray(calls)).toEqual(["authenticate", "refresh"])

        calls = Chunk.empty()
        yield* toggleMcp(input("disabled"))
        expect(Chunk.toReadonlyArray(calls)).toEqual(["connect", "refresh"])
      }),
    ))

  test("does not toggle a server while its connection is pending", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = Chunk.empty<string>()
        const record = (name: string) =>
          Effect.sync(() => {
            calls = Chunk.append(calls, name)
          })
        yield* toggleMcp({
          status: "pending",
          connect: record("connect"),
          disconnect: record("disconnect"),
          authenticate: record("authenticate"),
          refresh: record("refresh"),
        })
        expect(Chunk.toReadonlyArray(calls)).toEqual([])
      }),
    ))
})

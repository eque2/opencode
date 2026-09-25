import { describe, expect, test } from "bun:test"
import { toggleMcp } from "./mcp"
import { Chunk } from "effect"

describe("toggleMcp", () => {
  test("runs the status action before refreshing the owning query", async () => {
    let calls = Chunk.empty<string>()
    const input = (status: "connected" | "needs_auth" | "disabled") => ({
      status,
      connect: async () => {
        calls = Chunk.append(calls, "connect")
      },
      disconnect: async () => {
        calls = Chunk.append(calls, "disconnect")
      },
      authenticate: async () => {
        calls = Chunk.append(calls, "authenticate")
      },
      refresh: async () => {
        calls = Chunk.append(calls, "refresh")
      },
    })

    await toggleMcp(input("connected"))
    expect(Chunk.toReadonlyArray(calls)).toEqual(["disconnect", "refresh"])

    calls = Chunk.empty()
    await toggleMcp(input("needs_auth"))
    expect(Chunk.toReadonlyArray(calls)).toEqual(["authenticate", "refresh"])

    calls = Chunk.empty()
    await toggleMcp(input("disabled"))
    expect(Chunk.toReadonlyArray(calls)).toEqual(["connect", "refresh"])
  })

  test("does not toggle a server while its connection is pending", async () => {
    let calls = Chunk.empty<string>()
    await toggleMcp({
      status: "pending",
      connect: async () => {
        calls = Chunk.append(calls, "connect")
      },
      disconnect: async () => {
        calls = Chunk.append(calls, "disconnect")
      },
      authenticate: async () => {
        calls = Chunk.append(calls, "authenticate")
      },
      refresh: async () => {
        calls = Chunk.append(calls, "refresh")
      },
    })
    expect(Chunk.toReadonlyArray(calls)).toEqual([])
  })
})

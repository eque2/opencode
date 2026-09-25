import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"
import { Chunk } from "effect"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    let calls = Chunk.empty<string>()
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls = Chunk.append(calls, directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(Chunk.toReadonlyArray(calls)).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    let calls = Chunk.empty<string>()
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls = Chunk.append(calls, directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(Chunk.toReadonlyArray(calls)).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })
})

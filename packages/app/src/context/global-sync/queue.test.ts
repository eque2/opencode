import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"
import { Chunk, Effect } from "effect"

const tick = Effect.sleep("10 millis")

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = Chunk.empty<string>()
        const queue = createRefreshQueue({
          paused: () => false,
          key: directoryKey,
          bootstrap: () => Effect.runPromise(Effect.void),
          bootstrapInstance: (directory) => {
            calls = Chunk.append(calls, directory)
          },
        })

        queue.push("C:\\tmp\\demo")
        queue.clear("C:/tmp/demo")

        yield* tick

        expect(Chunk.toReadonlyArray(calls)).toEqual([])
        queue.dispose()
      }),
    ))

  test("passes the original directory to bootstrapInstance", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = Chunk.empty<string>()
        const queue = createRefreshQueue({
          paused: () => false,
          key: directoryKey,
          bootstrap: () => Effect.runPromise(Effect.void),
          bootstrapInstance: (directory) => {
            calls = Chunk.append(calls, directory)
          },
        })

        queue.push("C:\\tmp\\demo")

        yield* tick

        expect(Chunk.toReadonlyArray(calls)).toEqual(["C:\\tmp\\demo"])
        queue.dispose()
      }),
    ))
})

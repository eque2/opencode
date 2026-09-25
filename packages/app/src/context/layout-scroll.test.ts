import { describe, expect, test, vi } from "bun:test"
import { Chunk, Effect } from "effect"
import { createScrollPersistence } from "./layout-scroll"

describe("createScrollPersistence", () => {
  test("debounces persisted scroll writes", () =>
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.sync(() => vi.useFakeTimers()),
        () =>
          Effect.sync(() => {
            const snapshot = {
              session: {
                review: { x: 0, y: 0 },
              },
            } as Record<string, Record<string, { x: number; y: number }>>
            let writes = Chunk.empty<Record<string, { x: number; y: number }>>()
            const scroll = createScrollPersistence({
              debounceMs: 10,
              getSnapshot: (sessionKey) => snapshot[sessionKey],
              onFlush: (sessionKey, next) => {
                snapshot[sessionKey] = next
                writes = Chunk.append(writes, next)
              },
            })

            for (const i of Array.from({ length: 30 }, (_, n) => n + 1)) {
              scroll.setScroll("session", "review", { x: 0, y: i })
            }

            vi.advanceTimersByTime(9)
            expect(Chunk.toReadonlyArray(writes)).toHaveLength(0)

            vi.advanceTimersByTime(1)

            expect(Chunk.toReadonlyArray(writes)).toHaveLength(1)
            expect(Chunk.toReadonlyArray(writes)[0]?.review).toEqual({ x: 0, y: 30 })

            scroll.setScroll("session", "review", { x: 0, y: 30 })
            vi.advanceTimersByTime(20)

            expect(Chunk.toReadonlyArray(writes)).toHaveLength(1)
            scroll.dispose()
          }),
        () => Effect.sync(() => vi.useRealTimers()),
      ),
    ))

  test("reseeds empty cache after persisted snapshot loads", () => {
    const snapshot = {
      session: {},
    } as Record<string, Record<string, { x: number; y: number }>>

    const scroll = createScrollPersistence({
      getSnapshot: (sessionKey) => snapshot[sessionKey],
      onFlush: () => {},
    })

    expect(scroll.scroll("session", "review")).toBeUndefined()

    snapshot.session = {
      review: { x: 12, y: 34 },
    }

    expect(scroll.scroll("session", "review")).toEqual({ x: 12, y: 34 })
    scroll.dispose()
  })
})

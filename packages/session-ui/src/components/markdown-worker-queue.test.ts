import { expect, test } from "bun:test"
import { Array, Deferred, Effect, Exit } from "effect"
import { createLatestWorkerQueue } from "./markdown-worker-queue"

test("keeps only the latest queued request for each key", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let processed: ReadonlyArray<number> = []
      let superseded: ReadonlyArray<number> = []
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const queue = createLatestWorkerQueue<{ id: number; key: string }>({
        run: (request) =>
          Effect.gen(function* () {
            processed = Array.append(processed, request.id)
            if (request.id !== 1) return
            yield* Deferred.done(started, Exit.void)
            yield* Deferred.await(release)
          }),
        supersede: (request) => {
          superseded = Array.append(superseded, request.id)
        },
        dispose: () => {},
      })

      queue.highlight({ id: 1, key: "code" })
      yield* Deferred.await(started)
      queue.highlight({ id: 2, key: "code" })
      queue.highlight({ id: 3, key: "code" })
      queue.highlight({ id: 4, key: "code" })

      expect(queue.pending()).toBe(1)
      expect(superseded).toEqual([2, 3])
      yield* Deferred.done(release, Exit.void)
      yield* queue.idle
      expect(processed).toEqual([1, 4])
    }),
  ))

test("serializes disposal before a later request for the same key", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let events: ReadonlyArray<string> = []
      const queue = createLatestWorkerQueue<{ id: number; key: string }>({
        run: (request) =>
          Effect.sync(() => {
            events = Array.append(events, `highlight:${request.id}`)
          }),
        supersede: (request) => {
          events = Array.append(events, `supersede:${request.id}`)
        },
        dispose: (key) => {
          events = Array.append(events, `dispose:${key}`)
        },
      })

      queue.highlight({ id: 1, key: "code" })
      queue.dispose("code")
      queue.highlight({ id: 2, key: "code" })
      yield* queue.idle

      expect(events).toEqual(["supersede:1", "dispose:code", "highlight:2"])
    }),
  ))

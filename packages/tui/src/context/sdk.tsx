import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Data, DateTime, Duration, Effect, Fiber, MutableHashSet, Option, Stream } from "effect"
import { useTuiFlags } from "./runtime"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

/** The global event stream could not be opened or read. The reconnect loop stops on it, as before. */
class EventStreamError extends Data.TaggedError("SDK.EventStreamError")<{ readonly cause: unknown }> {}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const flags = useTuiFlags()
    const abort = new AbortController()
    // Aborts the open event stream request when the provider is cleaned up.
    const sse = new AbortController()

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const handlers = MutableHashSet.empty<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        MutableHashSet.add(handlers, handler)
        return () => {
          MutableHashSet.remove(handlers, handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let flushTimer: Option.Option<Fiber.Fiber<void>> = Option.none()
    let loop: Option.Option<Fiber.Fiber<void>> = Option.none()
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    // A defect in a background fiber is logged, as an exception in a timer callback reached the console.
    const runInBackground = (effect: Effect.Effect<void>) =>
      Effect.runFork(effect.pipe(Effect.tapDefect((defect) => Effect.logError(defect))))

    const interrupt = (fiber: Option.Option<Fiber.Fiber<void>>) => {
      if (Option.isSome(fiber)) Effect.runFork(Fiber.interrupt(fiber.value))
    }

    const cancelFlushTimer = () => {
      interrupt(flushTimer)
      flushTimer = Option.none()
    }

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      flushTimer = Option.none()
      last = DateTime.toEpochMillis(DateTime.nowUnsafe())
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = DateTime.toEpochMillis(DateTime.nowUnsafe()) - last

      if (Option.isSome(flushTimer)) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        flushTimer = Option.some(runInBackground(Effect.sleep("16 millis").pipe(Effect.andThen(Effect.sync(flush)))))
        return
      }
      flush()
    }

    const stopped = () => abort.signal.aborted || sse.signal.aborted

    // Start syncing workspaces. Call it after the event subscription is open. A failure is ignored, as before.
    const startWorkspaceSync = Effect.tryPromise(() => sdk.sync.start()).pipe(Effect.ignore)

    // Open the global event stream once and deliver its events until it ends.
    const listen = Effect.gen(function* () {
      const events = yield* Effect.tryPromise({
        try: () =>
          sdk.global.event({
            signal: sse.signal,
            sseMaxRetryAttempts: 0,
          }),
        catch: (cause) => new EventStreamError({ cause }),
      })

      if (flags.OPENCODE_EXPERIMENTAL_WORKSPACES) yield* startWorkspaceSync

      yield* Stream.fromAsyncIterable(events.stream, (cause) => new EventStreamError({ cause })).pipe(
        Stream.takeWhile(() => !sse.signal.aborted),
        Stream.runForEach((event) => Effect.sync(() => handleEvent(event))),
      )

      cancelFlushTimer()
      if (queue.length > 0) flush()
    })

    // Reconnect after each stream end with exponential backoff. A stream error ends the loop.
    const reconnect = Effect.gen(function* () {
      let attempt = 0
      while (!stopped()) {
        yield* listen
        attempt += 1
        if (stopped()) return
        yield* Effect.sleep(Duration.millis(Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)))
      }
    })

    // Keep the host event subscription open until cleanup interrupts the fiber.
    const subscribe = (events: EventSource) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.promise(() => events.subscribe(handleEvent)),
          (unsubscribe) => Effect.sync(unsubscribe),
        )
        if (flags.OPENCODE_EXPERIMENTAL_WORKSPACES) yield* startWorkspaceSync
        return yield* Effect.never
      }).pipe(Effect.scoped)

    onMount(() => {
      loop = Option.some(runInBackground(props.events ? subscribe(props.events) : reconnect.pipe(Effect.ignore)))
    })

    onCleanup(() => {
      abort.abort()
      sse.abort()
      interrupt(loop)
      cancelFlushTimer()
      MutableHashSet.clear(handlers)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      url: props.url,
    }
  },
})

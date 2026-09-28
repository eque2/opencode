import path from "path"
import { writeHeapSnapshot } from "node:v8"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { DateTime, Duration, Effect, Ref } from "effect"
import { Global } from "@opencode-ai/core/global"

const LIMIT = 2 * 1024 * 1024 * 1024

let started = false

/**
 * Starts a detached monitor that checks RSS once a minute. It writes one heap snapshot each time
 * RSS climbs above LIMIT, and it re-arms when RSS falls back below LIMIT. A second call is a no-op.
 */
export const start = Effect.fn("Heap.start")(function* () {
  if (!(yield* FlagConfig.OPENCODE_AUTO_HEAP_SNAPSHOT)) return
  if (started) return
  started = true

  const armed = yield* Ref.make(true)
  yield* check(armed).pipe(Effect.delay(Duration.minutes(1)), Effect.forever, Effect.forkDetach)
})

const check = Effect.fnUntraced(function* (armed: Ref.Ref<boolean>) {
  if (process.memoryUsage().rss <= LIMIT) {
    yield* Ref.set(armed, true)
    return
  }
  if (!(yield* Ref.getAndSet(armed, false))) return

  const now = yield* DateTime.now
  const file = path.join(
    Global.Path.log,
    `heap-${process.pid}-${DateTime.formatIso(now).replace(/[:.]/g, "")}.heapsnapshot`,
  )
  // A failed snapshot must not stop the monitor.
  yield* Effect.try(() => writeHeapSnapshot(file)).pipe(Effect.ignore)
})

export * as Heap from "./heap"

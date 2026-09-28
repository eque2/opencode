import { Data, Effect, MutableHashMap } from "effect"
import { makeFiberSlot } from "@/utils/fiber-slot"

type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

/** A refresh step that failed; `cause` is the value its bootstrap call threw or rejected with. */
class RefreshQueueError extends Data.TaggedError("App.RefreshQueueError")<{ readonly cause: unknown }> {}

/** Runs one bootstrap call, which can return a Promise or finish synchronously. */
const attempt = (run: () => Promise<void> | void) =>
  Effect.try({ try: run, catch: (cause) => new RefreshQueueError({ cause }) }).pipe(
    Effect.flatMap((result) =>
      result instanceof Promise
        ? Effect.tryPromise({ try: () => result, catch: (cause) => new RefreshQueueError({ cause }) })
        : Effect.void,
    ),
  )

/** Lets the event loop turn once, as a setTimeout(0) did. It delays a drain start and separates refresh steps. */
const tick = Effect.sleep("0 millis")

export function createRefreshQueue(input: QueueInput) {
  const queued = MutableHashMap.empty<string, string>()
  let root = false
  let running = false
  // The pending drain start. `scheduled` is true from schedule() until the timer fiber starts the drain.
  const timer = makeFiberSlot()
  let scheduled = false

  const key = input.key ?? ((directory: string) => directory)

  const take = (count: number) => {
    const picked = [...queued].slice(0, count)
    for (const [id] of picked) MutableHashMap.remove(queued, id)
    return picked.map(([, directory]) => directory)
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    // The drain runs in its own fiber, so dispose() stops only a drain that has not started yet.
    timer.run(
      tick.pipe(
        Effect.andThen(
          Effect.sync(() => {
            scheduled = false
          }),
        ),
        Effect.andThen(Effect.forkDetach(drain.pipe(Effect.tapCause((cause) => Effect.logError(cause))))),
      ),
    )
  }

  const push = (directory: string) => {
    if (!directory) return
    MutableHashMap.set(queued, key(directory), directory)
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (input.paused()) return
    schedule()
  }

  // One drain runs at a time. It refreshes the root first, then up to two directories per step,
  // and stops when the queue is empty or paused. A failed step ends this drain; the finalizer
  // schedules the next drain for the work that remains, unless the queue is paused.
  const drain: Effect.Effect<void, RefreshQueueError> = Effect.suspend(() => {
    if (running) return Effect.void
    running = true
    return Effect.gen(function* () {
      while (true) {
        if (input.paused()) return
        if (root) {
          root = false
          yield* attempt(() => input.bootstrap())
          yield* tick
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        yield* Effect.forEach(dirs, (dir) => attempt(() => input.bootstrapInstance(dir)), {
          concurrency: "unbounded",
          discard: true,
        })
        yield* tick
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          running = false
          if (input.paused()) return
          if (root || !MutableHashMap.isEmpty(queued)) schedule()
        }),
      ),
    )
  })

  return {
    push,
    refresh,
    clear(directory: string) {
      MutableHashMap.remove(queued, key(directory))
    },
    dispose() {
      if (!scheduled) return
      timer.interrupt()
      scheduled = false
    },
  }
}

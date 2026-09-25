import { Effect, Fiber, MutableHashMap, Option, Scheduler } from "effect"

export function createLatestWorkerQueue<T extends { key: string }>(input: {
  run: (request: T) => Effect.Effect<void>
  supersede: (request: T) => void
  dispose: (key: string) => void
}) {
  type Slot = { readonly type: "highlight"; readonly key: string; request: Option.Option<T> }
  type Job = Slot | { readonly type: "dispose"; readonly key: string }
  let jobs: ReadonlyArray<Job> = []
  const slots = MutableHashMap.empty<string, Slot>()
  let running: Option.Option<Fiber.Fiber<void>> = Option.none()
  // The drain yields on microtasks, as the old Promise chain did, so requests from the same turn
  // coalesce before the first job starts.
  const scheduler = new Scheduler.MixedScheduler("sync")

  // Takes the first job. The drain calls it only while a job is queued.
  const next = Effect.suspend(() => {
    const [job, ...rest] = jobs
    jobs = rest
    if (job.type === "dispose") return Effect.sync(() => input.dispose(job.key))
    if (Option.exists(MutableHashMap.get(slots, job.key), (slot) => slot === job)) MutableHashMap.remove(slots, job.key)
    const request = job.request
    job.request = Option.none()
    if (Option.isNone(request)) return Effect.void
    // A failed job must not stop the jobs behind it.
    return input.run(request.value).pipe(Effect.catchCause((cause) => Effect.logError(cause)))
  })

  const drain = Effect.whileLoop({
    while: () => jobs.length > 0,
    body: () => next,
    step: () => {},
  })

  const schedule = () => {
    if (Option.isSome(running)) return
    running = Option.some(
      Effect.runFork(
        Effect.yieldNow.pipe(
          Effect.andThen(drain),
          Effect.ensuring(
            Effect.sync(() => {
              running = Option.none()
            }),
          ),
        ),
        { scheduler },
      ),
    )
  }

  const idle: Effect.Effect<void> = Effect.suspend(() =>
    Option.match(running, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.await(fiber).pipe(Effect.andThen(idle)),
    }),
  )

  return {
    highlight(request: T) {
      const slot = MutableHashMap.get(slots, request.key)
      if (Option.isSome(slot)) {
        if (Option.isSome(slot.value.request)) input.supersede(slot.value.request.value)
        slot.value.request = Option.some(request)
        return
      }
      const created: Slot = { type: "highlight", key: request.key, request: Option.some(request) }
      MutableHashMap.set(slots, request.key, created)
      jobs = [...jobs, created]
      schedule()
    },
    dispose(key: string) {
      const slot = MutableHashMap.get(slots, key)
      if (Option.isSome(slot)) {
        if (Option.isSome(slot.value.request)) input.supersede(slot.value.request.value)
        slot.value.request = Option.none()
        MutableHashMap.remove(slots, key)
      }
      jobs = [...jobs, { type: "dispose", key }]
      schedule()
    },
    pending: () => MutableHashMap.size(slots),
    /** Waits until the queue has run every job, including jobs added while it waits. */
    idle,
  }
}

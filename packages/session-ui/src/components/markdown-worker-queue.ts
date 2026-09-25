import { MutableHashMap, Option } from "effect"

export function createLatestWorkerQueue<T extends { key: string }>(input: {
  run: (request: T) => Promise<void>
  supersede: (request: T) => void
  dispose: (key: string) => void
}) {
  type Slot = { type: "highlight"; key: string; request: Option.Option<T> }
  const jobs: Array<Slot | { type: "dispose"; key: string }> = []
  const slots = MutableHashMap.empty<string, Slot>()
  let running: Option.Option<Promise<void>> = Option.none()
  let cursor = 0

  const schedule = () => {
    if (Option.isSome(running)) return
    running = Option.some(
      Promise.resolve()
        .then(async () => {
          while (cursor < jobs.length) {
            const job = jobs[cursor++]!
            if (job.type === "dispose") {
              input.dispose(job.key)
              continue
            }
            if (Option.exists(MutableHashMap.get(slots, job.key), (slot) => slot === job))
              MutableHashMap.remove(slots, job.key)
            const request = job.request
            job.request = Option.none()
            if (Option.isSome(request)) await input.run(request.value)
          }
        })
        .finally(() => {
          jobs.splice(0, cursor)
          cursor = 0
          running = Option.none()
          if (jobs.length > 0) schedule()
        }),
    )
  }

  return {
    highlight(request: T) {
      const slot = MutableHashMap.get(slots, request.key)
      if (Option.isSome(slot)) {
        if (Option.isSome(slot.value.request)) input.supersede(slot.value.request.value)
        slot.value.request = Option.some(request)
        return
      }
      const next: Slot = { type: "highlight", key: request.key, request: Option.some(request) }
      MutableHashMap.set(slots, request.key, next)
      jobs.push(next)
      schedule()
    },
    dispose(key: string) {
      const slot = MutableHashMap.get(slots, key)
      if (Option.isSome(slot)) {
        if (Option.isSome(slot.value.request)) input.supersede(slot.value.request.value)
        slot.value.request = Option.none()
        MutableHashMap.remove(slots, key)
      }
      jobs.push({ type: "dispose", key })
      schedule()
    },
    pending: () => MutableHashMap.size(slots),
    async idle() {
      while (Option.isSome(running)) await running.value
    },
  }
}

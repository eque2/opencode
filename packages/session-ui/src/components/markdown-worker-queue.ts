import { Option } from "effect"

export function createLatestWorkerQueue<T extends { key: string }>(input: {
  run: (request: T) => Promise<void>
  supersede: (request: T) => void
  dispose: (key: string) => void
}) {
  type Slot = { type: "highlight"; key: string; request: Option.Option<T> }
  const jobs: Array<Slot | { type: "dispose"; key: string }> = []
  const slots = new Map<string, Slot>()
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
            if (slots.get(job.key) === job) slots.delete(job.key)
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
      const slot = slots.get(request.key)
      if (slot) {
        if (Option.isSome(slot.request)) input.supersede(slot.request.value)
        slot.request = Option.some(request)
        return
      }
      const next: Slot = { type: "highlight", key: request.key, request: Option.some(request) }
      slots.set(request.key, next)
      jobs.push(next)
      schedule()
    },
    dispose(key: string) {
      const slot = slots.get(key)
      if (slot && Option.isSome(slot.request)) input.supersede(slot.request.value)
      if (slot) {
        slot.request = Option.none()
        slots.delete(key)
      }
      jobs.push({ type: "dispose", key })
      schedule()
    },
    pending: () => slots.size,
    async idle() {
      while (Option.isSome(running)) await running.value
    },
  }
}

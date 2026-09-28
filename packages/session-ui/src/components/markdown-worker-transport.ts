import { MutableHashMap, Option } from "effect"

export function createWorkerTransport<T extends { id: number; key: string }>(input: {
  post: (request: T) => void
  supersede: (request: T) => void
}) {
  const active = MutableHashMap.empty<string, T>()
  const queued = MutableHashMap.empty<string, T>()

  return {
    send(request: T) {
      if (!MutableHashMap.has(active, request.key)) {
        MutableHashMap.set(active, request.key, request)
        input.post(request)
        return
      }
      const previous = MutableHashMap.get(queued, request.key)
      if (Option.isSome(previous)) input.supersede(previous.value)
      MutableHashMap.set(queued, request.key, request)
    },
    complete(key: string, id: number) {
      if (!Option.exists(MutableHashMap.get(active, key), (request) => request.id === id)) return
      MutableHashMap.remove(active, key)
      const next = MutableHashMap.get(queued, key)
      if (Option.isNone(next)) return
      MutableHashMap.remove(queued, key)
      MutableHashMap.set(active, key, next.value)
      input.post(next.value)
    },
    dispose(key: string) {
      MutableHashMap.remove(active, key)
      const request = MutableHashMap.get(queued, key)
      if (Option.isSome(request)) input.supersede(request.value)
      MutableHashMap.remove(queued, key)
    },
    reset() {
      for (const request of MutableHashMap.values(queued)) input.supersede(request)
      MutableHashMap.clear(queued)
      MutableHashMap.clear(active)
    },
    queued: () => MutableHashMap.size(queued),
  }
}

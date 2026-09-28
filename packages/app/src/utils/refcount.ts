import { MutableHashMap, Option } from "effect"
import { onCleanup } from "solid-js"

export function createRefCountMap<T>(
  create: (key: string) => T,
  remove?: (key: string) => void,
  identity: (key: string) => string = (key) => key,
) {
  const items = MutableHashMap.empty<string, T>()
  const refCounts = MutableHashMap.empty<string, number>()
  const refCount = (id: string) => Option.getOrElse(MutableHashMap.get(refCounts, id), () => 0)

  return (key: string) => {
    const id = identity(key)
    onCleanup(() => {
      const next = refCount(id) - 1
      MutableHashMap.set(refCounts, id, next)
      if (next === 0) {
        remove?.(id)
        MutableHashMap.remove(items, id)
        MutableHashMap.remove(refCounts, id)
      }
    })

    const cached = MutableHashMap.get(items, id)
    if (Option.isSome(cached)) {
      MutableHashMap.set(refCounts, id, refCount(id) + 1)
      return cached.value
    }
    const item = create(key)
    MutableHashMap.set(items, id, item)
    MutableHashMap.set(refCounts, id, 1)
    return item
  }
}

import { MutableHashMap, Option } from "effect"

type ScopedCacheOptions<T> = {
  maxEntries?: number
  ttlMs?: number
  dispose?: (value: T, key: string) => void
  now?: () => number
}

type Entry<T> = {
  value: T
  touchedAt: number
}

export function createScopedCache<T>(createValue: (key: string) => T, options: ScopedCacheOptions<T> = {}) {
  // MutableHashMap keeps insertion order for string keys, which the LRU prune relies on.
  const store = MutableHashMap.empty<string, Entry<T>>()
  const now = options.now ?? Date.now

  const dispose = (key: string, entry: Entry<T>) => {
    options.dispose?.(entry.value, key)
  }

  const expired = (entry: Entry<T>) => {
    if (options.ttlMs === undefined) return false
    return now() - entry.touchedAt >= options.ttlMs
  }

  const sweep = () => {
    if (options.ttlMs === undefined) return
    for (const [key, entry] of store) {
      if (!expired(entry)) continue
      MutableHashMap.remove(store, key)
      dispose(key, entry)
    }
  }

  const touch = (key: string, entry: Entry<T>) => {
    entry.touchedAt = now()
    MutableHashMap.remove(store, key)
    MutableHashMap.set(store, key, entry)
  }

  const prune = () => {
    if (options.maxEntries === undefined) return
    while (MutableHashMap.size(store) > options.maxEntries) {
      const [key] = MutableHashMap.keys(store)
      if (!key) return
      const entry = MutableHashMap.get(store, key)
      MutableHashMap.remove(store, key)
      if (Option.isNone(entry)) continue
      dispose(key, entry.value)
    }
  }

  const remove = (key: string) => {
    const entry = MutableHashMap.get(store, key)
    if (Option.isNone(entry)) return
    MutableHashMap.remove(store, key)
    dispose(key, entry.value)
    return entry.value.value
  }

  const peek = (key: string) => {
    sweep()
    const entry = MutableHashMap.get(store, key)
    if (Option.isNone(entry)) return
    if (!expired(entry.value)) return entry.value.value
    MutableHashMap.remove(store, key)
    dispose(key, entry.value)
  }

  const get = (key: string) => {
    sweep()
    const entry = MutableHashMap.get(store, key)
    if (Option.isSome(entry) && !expired(entry.value)) {
      touch(key, entry.value)
      return entry.value.value
    }
    if (Option.isSome(entry)) {
      MutableHashMap.remove(store, key)
      dispose(key, entry.value)
    }

    const created = {
      value: createValue(key),
      touchedAt: now(),
    }
    MutableHashMap.set(store, key, created)
    prune()
    return created.value
  }

  const clear = () => {
    for (const [key, entry] of store) {
      dispose(key, entry)
    }
    MutableHashMap.clear(store)
  }

  return {
    get,
    peek,
    delete: remove,
    clear,
  }
}

import { Array as Arr, MutableHashMap, Option } from "effect"
import type { Accessor } from "solid-js"

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: MutableHashMap.MutableHashMap<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = Arr.dedupe([...input.view, ...input.tabs])
  if (keys.length <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return Option.getOrElse(MutableHashMap.get(input.used, key), () => 0)
  }

  return keys.sort((a, b) => score(b) - score(a)).slice(input.max)
}

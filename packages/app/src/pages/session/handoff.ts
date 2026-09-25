import { MutableHashMap, Option } from "effect"
import type { SelectedLineRange } from "@/context/file"

type HandoffSession = {
  prompt: string
  files: Record<string, SelectedLineRange | null>
}

const MAX = 40

// Small LRU stores. MutableHashMap iterates string keys in insertion order, so the first key is the oldest.
const store = {
  session: MutableHashMap.empty<string, HandoffSession>(),
  terminal: MutableHashMap.empty<string, string[]>(),
}

const touch = <V>(map: MutableHashMap.MutableHashMap<string, V>, key: string, value: V) => {
  MutableHashMap.remove(map, key)
  MutableHashMap.set(map, key, value)
  for (const first of MutableHashMap.keys(map)) {
    if (MutableHashMap.size(map) <= MAX) return
    MutableHashMap.remove(map, first)
  }
}

export const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
  const prev = Option.getOrElse(MutableHashMap.get(store.session, key), () => ({ prompt: "", files: {} }))
  touch(store.session, key, { ...prev, ...patch })
}

// The handoff readers in the session and terminal panels read absence as undefined.
export const getSessionHandoff = (key: string) => Option.getOrUndefined(MutableHashMap.get(store.session, key))

export const setTerminalHandoff = (key: string, value: string[]) => {
  touch(store.terminal, key, value)
}

export const getTerminalHandoff = (key: string) => Option.getOrUndefined(MutableHashMap.get(store.terminal, key))

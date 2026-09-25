import { Duration, Effect, MutableHashMap, MutableHashSet, Option } from "effect"
import { createStore, produce } from "solid-js/store"
import { makeFiberSlot, type FiberSlot } from "@/utils/fiber-slot"

export type SessionScroll = {
  x: number
  y: number
}

type ScrollMap = Record<string, SessionScroll>

type Options = {
  debounceMs?: number
  getSnapshot: (sessionKey: string) => ScrollMap | undefined
  onFlush: (sessionKey: string, scroll: ScrollMap) => void
}

export function createScrollPersistence(opts: Options) {
  const wait = opts.debounceMs ?? 200
  const [cache, setCache] = createStore<Record<string, ScrollMap>>({})
  const dirty = MutableHashSet.empty<string>()
  // One debounce timer per session. Interrupting a timer's fiber cancels its pending write.
  const timers = MutableHashMap.empty<string, FiberSlot>()

  function clone(input?: ScrollMap) {
    const out: ScrollMap = {}
    if (!input) return out

    for (const key of Object.keys(input)) {
      const pos = input[key]
      if (!pos) continue
      out[key] = { x: pos.x, y: pos.y }
    }

    return out
  }

  function seed(sessionKey: string) {
    const next = clone(opts.getSnapshot(sessionKey))
    const current = cache[sessionKey]
    if (!current) {
      setCache(sessionKey, next)
      return
    }

    if (Object.keys(current).length > 0) return
    if (Object.keys(next).length === 0) return
    setCache(sessionKey, next)
  }

  function scroll(sessionKey: string, tab: string) {
    seed(sessionKey)
    return cache[sessionKey]?.[tab] ?? opts.getSnapshot(sessionKey)?.[tab]
  }

  function cancel(sessionKey: string) {
    const timer = MutableHashMap.get(timers, sessionKey)
    if (Option.isSome(timer)) timer.value.interrupt()
    MutableHashMap.remove(timers, sessionKey)
  }

  function schedule(sessionKey: string) {
    const timer = Option.getOrElse(MutableHashMap.get(timers, sessionKey), makeFiberSlot)
    MutableHashMap.set(timers, sessionKey, timer)
    // run() interrupts the pending write first, so each change restarts the delay.
    timer.run(
      Effect.sleep(Duration.millis(wait)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            MutableHashMap.remove(timers, sessionKey)
            write(sessionKey)
          }),
        ),
      ),
    )
  }

  function setScroll(sessionKey: string, tab: string, pos: SessionScroll) {
    seed(sessionKey)

    const prev = cache[sessionKey]?.[tab]
    if (prev?.x === pos.x && prev?.y === pos.y) return

    setCache(sessionKey, tab, { x: pos.x, y: pos.y })
    MutableHashSet.add(dirty, sessionKey)
    schedule(sessionKey)
  }

  function write(sessionKey: string) {
    if (!MutableHashSet.has(dirty, sessionKey)) return
    MutableHashSet.remove(dirty, sessionKey)

    opts.onFlush(sessionKey, clone(cache[sessionKey]))
  }

  function flush(sessionKey: string) {
    cancel(sessionKey)
    write(sessionKey)
  }

  function flushAll() {
    const keys = Array.from(dirty)
    if (keys.length === 0) return

    for (const key of keys) {
      flush(key)
    }
  }

  function drop(keys: string[]) {
    if (keys.length === 0) return

    for (const key of keys) {
      cancel(key)
      MutableHashSet.remove(dirty, key)
    }

    setCache(
      produce((draft) => {
        for (const key of keys) {
          delete draft[key]
        }
      }),
    )
  }

  function dispose() {
    drop(Array.from(MutableHashMap.keys(timers)))
  }

  return {
    cache,
    drop,
    flush,
    flushAll,
    scroll,
    seed,
    setScroll,
    dispose,
  }
}

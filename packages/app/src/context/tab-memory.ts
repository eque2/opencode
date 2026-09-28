import { Array as Arr, MutableHashMap, Option } from "effect"
import { createRoot, type Owner } from "solid-js"

type Entry<A> = {
  value: A
  dispose: VoidFunction
}

/**
 * Holds values of type `A` for open tabs, keyed by tab key and by name.
 *
 * Each value lives in its own reactive root under `owner`. `remove` disposes
 * the roots of one tab, and `dispose` disposes every root.
 */
export function createTabMemory<A>(owner: Owner | null) {
  const entries = MutableHashMap.empty<string, MutableHashMap.MutableHashMap<string, Entry<A>>>()

  const remove = (key: string) => {
    const state = MutableHashMap.get(entries, key)
    if (Option.isNone(state)) return
    for (const entry of MutableHashMap.values(state.value)) entry.dispose()
    MutableHashMap.remove(entries, key)
  }

  const tabState = (key: string) => {
    const existing = MutableHashMap.get(entries, key)
    if (Option.isSome(existing)) return existing.value
    const created = MutableHashMap.empty<string, Entry<A>>()
    MutableHashMap.set(entries, key, created)
    return created
  }

  return {
    get: (key: string, name: string): Option.Option<A> =>
      MutableHashMap.get(entries, key).pipe(
        Option.flatMap((state) => MutableHashMap.get(state, name)),
        Option.map((entry) => entry.value),
      ),
    ensure: (key: string, name: string, init: () => A): A => {
      const state = tabState(key)
      const existing = MutableHashMap.get(state, name)
      if (Option.isSome(existing)) return existing.value.value
      const entry = createRoot((dispose) => ({ value: init(), dispose }), owner)
      MutableHashMap.set(state, name, entry)
      return entry.value
    },
    remove,
    dispose: () => {
      for (const key of Arr.fromIterable(MutableHashMap.keys(entries))) remove(key)
    },
  }
}

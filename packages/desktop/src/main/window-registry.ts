import { MutableHashMap, Option } from "effect"

// Tracks open windows and the persisted window id list used to restore
// windows (and their per-window persisted state) across app launches.
export function createWindowRegistry<W>(persistence: {
  read: () => unknown
  write: (ids: string[]) => void
  cleanup: (id: string) => void
}) {
  const windows = MutableHashMap.empty<string, W>()
  let quitting = false
  let lastFocusedID = Option.none<string>()

  const persisted = () => {
    const value = persistence.read()
    if (!Array.isArray(value)) return []
    return value.filter((id): id is string => typeof id === "string" && id.length > 0)
  }

  return {
    persisted,
    setQuitting(value = true) {
      quitting = value
    },
    register(id: string, window: W) {
      MutableHashMap.set(windows, id, window)
      const ids = persisted()
      if (!ids.includes(id)) persistence.write([...ids, id])
    },
    focused(id: string) {
      lastFocusedID = Option.some(id)
    },
    lastFocused() {
      return Option.flatMap(lastFocusedID, (id) => MutableHashMap.get(windows, id))
    },
    closed(id: string) {
      MutableHashMap.remove(windows, id)
      // The persisted list keeps registration order, so the fallback is the
      // oldest window that is still open.
      if (Option.contains(lastFocusedID, id))
        lastFocusedID = Option.fromNullishOr(persisted().find((item) => MutableHashMap.has(windows, item)))
      // Only a deliberate close (app keeps running with other windows open)
      // forgets a window. Closing the last window quits the app and fires
      // `closed` before `before-quit`, so treat it as a quit and keep the id
      // for restore on next launch.
      if (quitting || MutableHashMap.size(windows) === 0) return
      persistence.write(persisted().filter((item) => item !== id))
      persistence.cleanup(id)
    },
  }
}

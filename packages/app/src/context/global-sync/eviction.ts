import { MutableHashMap, Option } from "effect"
import type { DisposeCheck, EvictPlan } from "./types"

export function pickDirectoriesToEvict(input: EvictPlan) {
  const lastAccessAt = (dir: string) =>
    MutableHashMap.get(input.state, dir).pipe(
      Option.map((state) => state.lastAccessAt),
      Option.getOrElse(() => 0),
    )
  const overflow = Math.max(0, input.stores.length - input.max)
  let pendingOverflow = overflow
  const sorted = input.stores
    .filter((dir) => !input.pins.has(dir))
    .slice()
    .sort((a, b) => lastAccessAt(a) - lastAccessAt(b))
  const output: string[] = []
  for (const dir of sorted) {
    const last = lastAccessAt(dir)
    const idle = input.now - last >= input.ttl
    if (!idle && pendingOverflow <= 0) continue
    output.push(dir)
    if (pendingOverflow > 0) pendingOverflow -= 1
  }
  return output
}

export function canDisposeDirectory(input: DisposeCheck) {
  if (!input.directory) return false
  if (!input.hasStore) return false
  if (input.pinned) return false
  if (input.booting) return false
  if (input.loadingSessions) return false
  return true
}

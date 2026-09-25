import { HashSet } from "effect"

export function adjacentTabKey(order: string[], current: string | undefined, offset: -1 | 1) {
  if (!current || order.length === 0) return
  const index = order.indexOf(current)
  if (index === -1) return
  return order[(index + offset + order.length) % order.length]
}

export function mergeVisibleTabOrder(all: string[], current: string[], next: string[]) {
  const visible = HashSet.fromIterable(current)
  const reordered = next.values()
  return all.map((key) => (HashSet.has(visible, key) ? (reordered.next().value ?? key) : key))
}

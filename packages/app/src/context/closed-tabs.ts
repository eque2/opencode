import { Data, HashSet } from "effect"
import type { SessionTab, Tab } from "./tabs"

export type ClosedTab = {
  tab: SessionTab
  index: number
}

const CLOSED_TAB_LIMIT = 25

// Only session tabs are recorded; closing a draft tab deletes its persisted
// state, so a reopened draft would come back empty anyway.
export function pushClosedTab(stack: ClosedTab[], tab: Tab, index: number): ClosedTab[] {
  if (tab.type !== "session") return stack
  return [...stack, { tab: { ...tab }, index }].slice(-CLOSED_TAB_LIMIT)
}

// Pops the most recently closed tab that is not open again,
// discarding stale entries along the way.
export function takeClosedTab(stack: ClosedTab[], tabs: Tab[]): { entry?: ClosedTab; stack: ClosedTab[] } {
  const remaining = [...stack]
  while (remaining.length) {
    const entry = remaining.pop()
    if (entry && !isOpen(tabs, entry.tab)) return { entry, stack: remaining }
  }
  return { stack: remaining }
}

export function removeClosedTabs(stack: ClosedTab[], server: SessionTab["server"], sessionIDs: string[]) {
  const removed = HashSet.fromIterable(sessionIDs)
  return stack.filter((entry) => entry.tab.server !== server || !HashSet.has(removed, entry.tab.sessionId))
}

/**
 * Where the view goes after a tab closes.
 *
 * - `Stay`: the closed tab was not the active view, so nothing navigates.
 * - `Home`: the closed tab was the last one, so the view goes home.
 * - `Select`: the view moves to the neighbouring tab.
 */
export type CloseNavigation = Data.TaggedEnum<{
  Stay: {}
  Home: {}
  Select: { readonly tab: Tab }
}>
export const CloseNavigation = Data.taggedEnum<CloseNavigation>()

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean): CloseNavigation {
  if (!active) return CloseNavigation.Stay()
  const tab = tabs[index + 1] ?? tabs[index - 1]
  return tab ? CloseNavigation.Select({ tab }) : CloseNavigation.Home()
}

function isOpen(tabs: Tab[], tab: SessionTab) {
  return tabs.some((item) => item.type === "session" && item.server === tab.server && item.sessionId === tab.sessionId)
}

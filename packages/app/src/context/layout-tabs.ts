import { Predicate } from "effect"

export const SESSION_OPEN_FILE_TAB = "open-file"

export type SessionTabs = {
  active?: string
  all: string[]
}

export type SessionTabState = {
  tabs: SessionTabs
  preview?: string
}

// The preview tab: the stored one, else the open-file tab when it is open.
const sessionTabPreview = (current: SessionTabState) => {
  if (Predicate.isNotNullish(current.preview)) return current.preview
  if (current.tabs.all.includes(SESSION_OPEN_FILE_TAB)) return SESSION_OPEN_FILE_TAB
  return undefined
}

export function previewSessionTab(current: SessionTabState, tab: string): SessionTabState {
  const preview = sessionTabPreview(current)
  const previewIndex = preview ? current.tabs.all.indexOf(preview) : -1
  const existingIndex = current.tabs.all.indexOf(tab)

  if (existingIndex !== -1) {
    if (previewIndex === -1 || preview === tab) {
      return { tabs: { all: current.tabs.all, active: tab }, ...(preview === tab ? { preview: tab } : {}) }
    }
    return {
      tabs: { all: current.tabs.all.filter((item) => item !== preview), active: tab },
    }
  }

  if (previewIndex === -1) {
    return { tabs: { all: [...current.tabs.all, tab], active: tab }, preview: tab }
  }

  return {
    tabs: {
      all: current.tabs.all.map((item, index) => (index === previewIndex ? tab : item)),
      active: tab,
    },
    preview: tab,
  }
}

export function openSessionTab(current: SessionTabState, tab: string): SessionTabState {
  const preview = sessionTabPreview(current)
  if (tab === "review") {
    return {
      tabs: { all: current.tabs.all.filter((item) => item !== tab), active: tab },
      preview,
    }
  }

  if (tab === "context") {
    return {
      tabs: { all: [tab, ...current.tabs.all.filter((item) => item !== tab)], active: tab },
      preview,
    }
  }

  const previewIndex = preview ? current.tabs.all.indexOf(preview) : -1
  const existingIndex = current.tabs.all.indexOf(tab)
  if (existingIndex !== -1) {
    if (previewIndex === -1 || preview === tab) {
      return { tabs: { all: current.tabs.all, active: tab } }
    }
    return {
      tabs: { all: current.tabs.all.filter((item) => item !== preview), active: tab },
    }
  }

  if (previewIndex === -1) {
    return { tabs: { all: [...current.tabs.all, tab], active: tab } }
  }

  return {
    tabs: {
      all: current.tabs.all.map((item, index) => (index === previewIndex ? tab : item)),
      active: tab,
    },
  }
}

export function closeSessionTab(current: SessionTabState, tab: string): SessionTabState {
  if (tab === "review") {
    if (current.tabs.active !== tab) return current
    return {
      tabs: { all: current.tabs.all, active: current.tabs.all[0] },
      preview: current.preview,
    }
  }

  const all = current.tabs.all.filter((item) => item !== tab)
  // Closing the preview tab clears the preview.
  const preview = current.preview === tab ? {} : { preview: current.preview }
  if (current.tabs.active !== tab) return { tabs: { ...current.tabs, all }, ...preview }

  const index = current.tabs.all.indexOf(tab)
  return {
    tabs: {
      all,
      active: current.tabs.all[index - 1] ?? current.tabs.all[index + 1] ?? all[0],
    },
    ...preview,
  }
}

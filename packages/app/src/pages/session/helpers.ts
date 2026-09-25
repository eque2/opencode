import { batch, createMemo, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { same } from "@/utils/same"
import { createFiberSlot } from "@/utils/fiber-slot"
import { SESSION_OPEN_FILE_TAB } from "@/context/layout-tabs"
import type { SelectedLineRange } from "@/context/file"

export { SESSION_OPEN_FILE_TAB } from "@/context/layout-tabs"

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
  fileBrowser?: Accessor<boolean>
}

const SelectionSide = Schema.Literals(["additions", "deletions"])

const SelectedLineRangeSchema = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  side: Schema.optional(SelectionSide),
  endSide: Schema.optional(SelectionSide),
}).annotate({
  identifier: "SessionHelpers.SelectedLineRange",
})

const isSelectedLineRange = Schema.is(SelectedLineRangeSchema)

/**
 * Reads a selected line range from a file view value.
 *
 * The file context returns stored selections as `unknown`. This returns None
 * when the value is absent or is not a line range.
 */
export const readSelectedLineRange = (value: unknown): Option.Option<SelectedLineRange> =>
  isSelectedLineRange(value) ? Option.some(value) : Option.none()

export const getSessionKey = (dir: string | undefined, id: string | undefined) => `${dir ?? ""}${id ? `/${id}` : ""}`

export function shouldShowFileTree(input: { visible: boolean; opened: boolean }) {
  return input.opened && input.visible
}

export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const fileBrowser = input.fileBrowser ?? (() => false)
  const contextOpen = createMemo(() => input.tabs().active() === "context" || input.tabs().all().includes("context"))
  const openFileOpen = createMemo(
    () =>
      fileBrowser() &&
      (input.tabs().active() === SESSION_OPEN_FILE_TAB || input.tabs().all().includes(SESSION_OPEN_FILE_TAB)),
  )
  const panelTabs = createMemo(
    () =>
      Arr.dedupe(
        input
          .tabs()
          .all()
          .flatMap((tab) => {
            if (tab === "context" || tab === "review") return []
            if (tab === SESSION_OPEN_FILE_TAB && !fileBrowser()) return []
            return [input.pathFromTab(tab) ? input.normalizeTab(tab) : tab]
          }),
      ),
    emptyTabs,
    { equals: same },
  )
  const openedTabs = createMemo(() => panelTabs().filter((tab) => tab !== SESSION_OPEN_FILE_TAB), emptyTabs, {
    equals: same,
  })
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "context") return active
    if (active === SESSION_OPEN_FILE_TAB && openFileOpen()) return active
    if (active === "review" && review()) return active
    if (active && input.pathFromTab(active)) return input.normalizeTab(active)

    const first = openedTabs()[0]
    if (first) return first
    if (contextOpen()) return "context"
    if (review() && hasReview()) return "review"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return undefined
    return active
  })
  const closableTab = createMemo(() => {
    const active = activeTab()
    if (active === "context") return active
    if (active === SESSION_OPEN_FILE_TAB && openFileOpen()) return active
    if (!openedTabs().includes(active)) return undefined
    return active
  })

  return {
    contextOpen,
    openFileOpen,
    panelTabs,
    openedTabs,
    activeTab,
    activeFileTab,
    closableTab,
  }
}

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) void maybePromise.then(open)
      else open()
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  openReviewPanel: () => void
  setActive: (tab: string) => void
}) => {
  return (value: string) => {
    const next = input.normalizeTab(value)
    input.openTab(next)

    const path = input.pathFromTab(next)
    if (!path) return

    input.loadFile(path)
    input.openReviewPanel()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  // The pending delayed stop. The slot interrupts it when the owner cleans up.
  const settle = createFiberSlot()

  const stop = () => {
    settle.interrupt()
    setState("active", false)
  }

  const start = () => {
    settle.interrupt()
    setState("active", true)
  }

  onMount(() => {
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      settle.run(Effect.sleep("120 millis").pipe(Effect.andThen(Effect.sync(() => setState("active", false)))))
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>

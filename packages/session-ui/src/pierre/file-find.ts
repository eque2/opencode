import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { Array as Arr, Option } from "effect"

export type FindHost = {
  element: () => HTMLElement | undefined
  open: () => void
  close: () => void
  next: (dir: 1 | -1) => void
  isOpen: () => boolean
}

// Registered find hosts in mount order. Each host is a distinct object, so membership is by reference.
let hosts: ReadonlyArray<FindHost> = []
// target: the host that Cmd/Ctrl+F opens when focus is outside every host. current: the host whose find bar is open.
let target: Option.Option<FindHost> = Option.none()
let current: Option.Option<FindHost> = Option.none()
let installed = false

function isEditable(node: unknown): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (node.closest("[data-prevent-autofocus]")) return true
  if (node.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName)
}

function hostForNode(node: unknown): Option.Option<FindHost> {
  if (!(node instanceof Node)) return Option.none()
  return Arr.findFirst(hosts, (host) => {
    const el = host.element()
    return !!el && el.isConnected && el.contains(node)
  })
}

function installShortcuts() {
  if (installed) return
  if (typeof window === "undefined") return
  installed = true

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) return
      if (isEditable(event.target)) return

      const mod = event.metaKey || event.ctrlKey
      if (!mod) return

      const key = event.key.toLowerCase()
      if (key === "g") {
        const host = current
        if (Option.isNone(host) || !host.value.isOpen()) return
        event.preventDefault()
        event.stopPropagation()
        host.value.next(event.shiftKey ? -1 : 1)
        return
      }

      if (key !== "f") return

      const active = current
      if (Option.isSome(active) && active.value.isOpen()) {
        event.preventDefault()
        event.stopPropagation()
        active.value.open()
        return
      }

      const host = hostForNode(document.activeElement).pipe(
        Option.orElse(() => hostForNode(event.target)),
        Option.orElse(() => target),
        Option.orElse(() => Arr.head(hosts)),
      )
      if (Option.isNone(host)) return

      event.preventDefault()
      event.stopPropagation()
      host.value.open()
    },
    { capture: true },
  )
}

// The CSS Custom Highlight API is missing on the server and in older engines, so detect it before use.
function highlightRegistry(): Option.Option<HighlightRegistry> {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return Option.none()
  return Option.fromNullishOr(CSS.highlights)
}

function clearHighlightFind() {
  const api = highlightRegistry()
  if (Option.isNone(api)) return
  api.value.delete("opencode-find")
  api.value.delete("opencode-find-current")
}

function supportsHighlights() {
  return typeof Highlight === "function" && Option.isSome(highlightRegistry())
}

function scrollParent(el: HTMLElement): Option.Option<HTMLElement> {
  let parent = el.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    if (style.overflowY === "auto" || style.overflowY === "scroll") return Option.some(parent)
    parent = parent.parentElement
  }
  return Option.none()
}

function* textNodes(root: HTMLElement): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node instanceof Text) yield node
    node = walker.nextNode()
  }
}

// Yields each offset of needle in hay. The search resumes `step` characters after a match, so matches never overlap.
function* matchOffsets(hay: string, needle: string, step: number): Generator<number> {
  let at = hay.indexOf(needle)
  while (at !== -1) {
    yield at
    at = hay.indexOf(needle, at + step)
  }
}

type CreateFileFindOptions = {
  wrapper: () => HTMLElement | undefined
  overlay: () => HTMLDivElement | undefined
  getRoot: () => Option.Option<ShadowRoot>
}

export function createFileFind(opts: CreateFileFindOptions) {
  let input: HTMLInputElement | undefined
  let overlayFrame: Option.Option<number> = Option.none()
  let mode: "highlights" | "overlay" = "overlay"
  let hits: Range[] = []
  const [overlayScroll, setOverlayScroll] = createSignal<HTMLElement[]>([])

  const [state, setState] = createStore({
    open: false,
    query: "",
    index: 0,
    count: 0,
    pos: { top: 8, right: 8 },
  })
  const open = () => state.open
  const query = () => state.query
  const index = () => state.index
  const count = () => state.count
  const pos = () => state.pos

  const clearOverlayScroll = () => {
    setOverlayScroll([])
  }

  const clearOverlay = () => {
    const el = opts.overlay()
    if (!el) return
    if (Option.isSome(overlayFrame)) {
      cancelAnimationFrame(overlayFrame.value)
      overlayFrame = Option.none()
    }
    el.innerHTML = ""
  }

  const renderOverlay = () => {
    if (mode !== "overlay") {
      clearOverlay()
      return
    }

    const wrapper = opts.wrapper()
    const overlay = opts.overlay()
    if (!wrapper || !overlay) return

    clearOverlay()
    if (hits.length === 0) return

    const base = wrapper.getBoundingClientRect()
    const currentIndex = index()
    const frag = document.createDocumentFragment()

    for (let i = 0; i < hits.length; i++) {
      const range = hits[i]
      const active = i === currentIndex
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height) continue

        const mark = document.createElement("div")
        mark.style.position = "absolute"
        mark.style.left = `${Math.round(rect.left - base.left)}px`
        mark.style.top = `${Math.round(rect.top - base.top)}px`
        mark.style.width = `${Math.round(rect.width)}px`
        mark.style.height = `${Math.round(rect.height)}px`
        mark.style.borderRadius = "2px"
        mark.style.backgroundColor = active ? "var(--surface-warning-strong)" : "var(--surface-warning-base)"
        mark.style.opacity = active ? "0.55" : "0.35"
        if (active) mark.style.boxShadow = "inset 0 0 0 1px var(--border-warning-base)"
        frag.appendChild(mark)
      }
    }

    overlay.appendChild(frag)
  }

  function scheduleOverlay() {
    if (mode !== "overlay") return
    if (!open()) return
    if (Option.isSome(overlayFrame)) return

    overlayFrame = Option.some(
      requestAnimationFrame(() => {
        overlayFrame = Option.none()
        renderOverlay()
      }),
    )
  }

  const syncOverlayScroll = () => {
    if (mode !== "overlay") return
    const next = Option.match(opts.getRoot(), {
      onNone: (): HTMLElement[] => [],
      onSome: (root) =>
        Array.from(root.querySelectorAll("[data-code]")).filter(
          (node): node is HTMLElement => node instanceof HTMLElement,
        ),
    })
    const current = overlayScroll()
    if (next.length === current.length && next.every((el, i) => el === current[i])) return

    clearOverlayScroll()
    setOverlayScroll(next)
  }

  const clearFind = () => {
    clearHighlightFind()
    clearOverlay()
    clearOverlayScroll()
    hits = []
    setState("count", 0)
    setState("index", 0)
  }

  const positionBar = () => {
    if (typeof window === "undefined") return
    const wrapper = opts.wrapper()
    if (!wrapper) return

    const root = Option.getOrElse(scrollParent(wrapper), () => wrapper)
    const rect = root.getBoundingClientRect()
    const title = parseFloat(getComputedStyle(root).getPropertyValue("--session-title-height"))
    const header = Number.isNaN(title) ? 0 : title

    setState("pos", {
      top: Math.round(rect.top) + header - 4,
      right: Math.round(window.innerWidth - rect.right) + 8,
    })
  }

  const scan = (root: ShadowRoot, value: string): Range[] => {
    const needle = value.toLowerCase()
    const cols = Array.from(root.querySelectorAll("[data-content] [data-line], [data-column-content]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    )

    return cols.flatMap((col) => {
      const text = col.textContent
      if (!text) return []

      const hay = text.toLowerCase()
      const starts = Array.from(matchOffsets(hay, needle, value.length))
      if (starts.length === 0) return []

      const nodes = Array.from(textNodes(col))
      if (nodes.length === 0) return []
      // ends[i] is the text offset just after nodes[i].
      const ends = Arr.scan(nodes, 0, (pos, node) => pos + node.data.length).slice(1)

      const locate = (offset: number) => {
        let lo = 0
        let hi = ends.length - 1
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (ends[mid] >= offset) hi = mid
          else lo = mid + 1
        }
        const prev = lo === 0 ? 0 : ends[lo - 1]
        return { node: nodes[lo], offset: offset - prev }
      }

      return starts.map((at) => {
        const start = locate(at)
        const end = locate(at + value.length)
        const range = document.createRange()
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        return range
      })
    })
  }

  const scrollToRange = (range: Range) => {
    const start = range.startContainer
    const el = start instanceof Element ? start : start.parentElement
    el?.scrollIntoView({ block: "center", inline: "center" })
  }

  const setHighlights = (ranges: Range[], currentIndex: number) => {
    const registry = highlightRegistry()
    if (Option.isNone(registry) || typeof Highlight !== "function") return false
    const api = registry.value

    api.delete("opencode-find")
    api.delete("opencode-find-current")

    const active = ranges[currentIndex]
    if (active) api.set("opencode-find-current", new Highlight(active))

    const rest = ranges.filter((_, i) => i !== currentIndex)
    if (rest.length > 0) api.set("opencode-find", new Highlight(...rest))
    return true
  }

  const apply = (args?: { reset?: boolean; scroll?: boolean }) => {
    if (!open()) return

    const value = query().trim()
    if (!value) {
      clearFind()
      return
    }

    const root = opts.getRoot()
    if (Option.isNone(root)) return

    mode = supportsHighlights() ? "highlights" : "overlay"

    const ranges = scan(root.value, value)
    const total = ranges.length
    const desired = args?.reset ? 0 : index()
    const currentIndex = total ? Math.min(desired, total - 1) : 0

    hits = ranges
    setState("count", total)
    setState("index", currentIndex)

    const active = ranges[currentIndex]
    if (mode === "highlights") {
      clearOverlay()
      clearOverlayScroll()
      if (!setHighlights(ranges, currentIndex)) {
        mode = "overlay"
        clearHighlightFind()
        syncOverlayScroll()
        scheduleOverlay()
      }
      if (args?.scroll && active) scrollToRange(active)
      return
    }

    clearHighlightFind()
    syncOverlayScroll()
    if (args?.scroll && active) scrollToRange(active)
    scheduleOverlay()
  }

  const close = () => {
    setState("open", false)
    setState("query", "")
    clearFind()
    if (isThisHost(current)) current = Option.none()
  }

  const focus = () => {
    const previous = current
    if (Option.isSome(previous) && previous.value !== host) previous.value.close()
    current = Option.some(host)
    target = Option.some(host)
    if (!open()) setState("open", true)
    requestAnimationFrame(() => {
      apply({ scroll: true })
      input?.focus()
      input?.select()
    })
  }

  const next = (dir: 1 | -1) => {
    if (!open()) return
    const total = count()
    if (total <= 0) return

    const currentIndex = (index() + dir + total) % total
    setState("index", currentIndex)

    const active = hits[currentIndex]
    if (!active) return

    if (mode === "highlights") {
      if (!setHighlights(hits, currentIndex)) {
        mode = "overlay"
        apply({ reset: true, scroll: true })
        return
      }
      scrollToRange(active)
      return
    }

    clearHighlightFind()
    syncOverlayScroll()
    scrollToRange(active)
    scheduleOverlay()
  }

  const host: FindHost = {
    element: opts.wrapper,
    isOpen: () => open(),
    next,
    open: focus,
    close,
  }

  const isThisHost = (slot: Option.Option<FindHost>) => Option.exists(slot, (item) => item === host)

  createEffect(() => {
    for (const el of overlayScroll()) makeEventListener(el, "scroll", scheduleOverlay, { passive: true })
  })

  onMount(() => {
    mode = supportsHighlights() ? "highlights" : "overlay"
    installShortcuts()
    hosts = Arr.append(hosts, host)
    if (Option.isNone(target)) target = Option.some(host)

    onCleanup(() => {
      hosts = hosts.filter((item) => item !== host)
      if (isThisHost(current)) {
        current = Option.none()
        clearHighlightFind()
      }
      if (isThisHost(target)) target = Option.none()
    })
  })

  createEffect(() => {
    if (!open()) return

    const update = () => positionBar()
    requestAnimationFrame(update)
    makeEventListener(window, "resize", update, { passive: true })

    const wrapper = opts.wrapper()
    if (!wrapper) return
    const root = Option.getOrElse(scrollParent(wrapper), () => wrapper)
    createResizeObserver(root, update)
  })

  onCleanup(() => {
    clearOverlayScroll()
    clearOverlay()
    if (isThisHost(current)) {
      current = Option.none()
      clearHighlightFind()
    }
  })

  return {
    open,
    query,
    count,
    index,
    pos,
    setInput: (el: HTMLInputElement) => {
      input = el
    },
    setQuery: (value: string) => {
      setState("query", value)
      setState("index", 0)
      apply({ reset: true, scroll: true })
    },
    focus,
    close,
    next,
    refresh: (args?: { reset?: boolean; scroll?: boolean }) => apply(args),
    onPointerDown: () => {
      target = Option.some(host)
      opts.wrapper()?.focus({ preventScroll: true })
    },
    onFocus: () => {
      target = Option.some(host)
    },
    onInputKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      if (event.key !== "Enter") return
      event.preventDefault()
      next(event.shiftKey ? -1 : 1)
    },
  }
}

import { type VirtualFileMetrics, Virtualizer } from "@pierre/diffs"
import { Option } from "effect"

type Target = {
  key: Document | HTMLElement
  root: Document | HTMLElement
  content: Option.Option<HTMLElement>
}

type Entry = {
  virtualizer: Virtualizer
  refs: number
}

export type VirtualizerLease = {
  virtualizer: Virtualizer
  release: () => void
}

const cache = new WeakMap<Document | HTMLElement, Entry>()

export const virtualMetrics: Partial<VirtualFileMetrics> = {
  lineHeight: 24,
  hunkSeparatorHeight: 24,
  spacing: 0,
}

function scrollable(value: string) {
  return value === "auto" || value === "scroll" || value === "overlay"
}

function scrollRoot(container: HTMLElement): Option.Option<HTMLElement> {
  let node = container.parentElement
  while (node) {
    const style = getComputedStyle(node)
    if (scrollable(style.overflowY)) return Option.some(node)
    node = node.parentElement
  }
  return Option.none()
}

function htmlElement(node: Element | null): Option.Option<HTMLElement> {
  return node instanceof HTMLElement ? Option.some(node) : Option.none()
}

function target(container: HTMLElement): Option.Option<Target> {
  if (typeof document === "undefined") return Option.none()

  const review = container.closest("[data-component='session-review']")
  if (review instanceof HTMLElement) {
    return Option.some({
      key: review,
      root: Option.getOrElse(scrollRoot(container), () => review),
      content: htmlElement(review.querySelector("[data-slot='session-review-container']")),
    })
  }

  const root = scrollRoot(container)
  if (Option.isSome(root)) {
    return Option.some({
      key: root.value,
      root: root.value,
      content: htmlElement(root.value.querySelector("[role='log']")),
    })
  }

  return Option.some({
    key: document,
    root: document,
    content: Option.none(),
  })
}

export function acquireVirtualizer(container: HTMLElement): Option.Option<VirtualizerLease> {
  const resolved = target(container)
  if (Option.isNone(resolved)) return Option.none()
  const { key, root, content } = resolved.value

  let entry = cache.get(key)
  if (!entry) {
    const virtualizer = new Virtualizer()
    // Virtualizer.setup takes an optional content container, so an absent one crosses as undefined.
    virtualizer.setup(root, Option.getOrUndefined(content))
    entry = {
      virtualizer,
      refs: 0,
    }
    cache.set(key, entry)
  }

  entry.refs += 1
  let done = false

  return Option.some({
    virtualizer: entry.virtualizer,
    release() {
      if (done) return
      done = true

      const current = cache.get(key)
      if (!current) return

      current.refs -= 1
      if (current.refs > 0) return

      current.virtualizer.cleanUp()
      cache.delete(key)
    },
  })
}

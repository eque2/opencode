import { Option } from "effect"

type ReadyWatcher = {
  observer?: MutationObserver
  token: number
}

export function createReadyWatcher(): ReadyWatcher {
  return { token: 0 }
}

export function clearReadyWatcher(state: ReadyWatcher) {
  state.observer?.disconnect()
  state.observer = undefined
}

export function getViewerHost(container: HTMLElement | undefined): Option.Option<HTMLElement> {
  if (!container) return Option.none()
  const host = container.querySelector("diffs-container")
  return host instanceof HTMLElement ? Option.some(host) : Option.none()
}

export function getViewerRoot(container: HTMLElement | undefined): Option.Option<ShadowRoot> {
  return Option.flatMap(getViewerHost(container), (host) => Option.fromNullOr(host.shadowRoot))
}

export function applyViewerScheme(host: Option.Option<HTMLElement>) {
  if (Option.isNone(host)) return
  if (typeof document === "undefined") return

  const scheme = document.documentElement.dataset.colorScheme
  if (scheme === "dark" || scheme === "light") {
    host.value.dataset.colorScheme = scheme
    return
  }

  host.value.removeAttribute("data-color-scheme")
}

export function observeViewerScheme(getHost: () => Option.Option<HTMLElement>) {
  if (typeof document === "undefined") return () => {}

  applyViewerScheme(getHost())
  if (typeof MutationObserver === "undefined") return () => {}

  const root = document.documentElement
  const monitor = new MutationObserver(() => applyViewerScheme(getHost()))
  monitor.observe(root, { attributes: true, attributeFilter: ["data-color-scheme"] })
  return () => monitor.disconnect()
}

export function notifyShadowReady(opts: {
  state: ReadyWatcher
  container: HTMLElement
  getRoot: () => Option.Option<ShadowRoot>
  isReady: (root: ShadowRoot) => boolean
  onReady: () => void
  settleFrames?: number
}) {
  clearReadyWatcher(opts.state)
  opts.state.token += 1

  const token = opts.state.token
  const settle = Math.max(0, opts.settleFrames ?? 0)

  const runReady = () => {
    const step = (left: number) => {
      if (token !== opts.state.token) return
      if (left <= 0) {
        opts.onReady()
        return
      }
      requestAnimationFrame(() => step(left - 1))
    }

    requestAnimationFrame(() => step(settle))
  }

  const observeRoot = (root: ShadowRoot) => {
    if (opts.isReady(root)) {
      runReady()
      return
    }

    if (typeof MutationObserver === "undefined") return

    clearReadyWatcher(opts.state)
    opts.state.observer = new MutationObserver(() => {
      if (token !== opts.state.token) return
      if (!opts.isReady(root)) return

      clearReadyWatcher(opts.state)
      runReady()
    })
    opts.state.observer.observe(root, { childList: true, subtree: true })
  }

  const root = opts.getRoot()
  if (Option.isNone(root)) {
    if (typeof MutationObserver === "undefined") return

    opts.state.observer = new MutationObserver(() => {
      if (token !== opts.state.token) return

      const next = opts.getRoot()
      if (Option.isNone(next)) return

      observeRoot(next.value)
    })
    opts.state.observer.observe(opts.container, { childList: true, subtree: true })
    return
  }

  observeRoot(root.value)
}

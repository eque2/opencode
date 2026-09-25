import { sampledChecksum } from "@opencode-ai/core/util/encode"
import {
  areFilesEqual,
  areOptionsEqual,
  DEFAULT_VIRTUAL_FILE_METRICS,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  File as PierreFile,
  type FileDiffOptions,
  FileDiff,
  type FileOptions,
  type LineAnnotation,
  type SelectedLineRange,
  type VirtualFileMetrics,
  VirtualizedFile,
  VirtualizedFileDiff,
  Virtualizer,
} from "@pierre/diffs"
import { type PreloadFileDiffResult, type PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { type WorkerPoolManager } from "@pierre/diffs/worker"
import { createMediaQuery } from "@solid-primitives/media"
import { makeEventListener } from "@solid-primitives/event-listener"
import { ComponentProps, createEffect, createMemo, createSignal, onCleanup, onMount, Show, splitProps } from "solid-js"
import { Equivalence, Option } from "effect"
import { createDefaultOptions, styleVariables } from "../pierre"
import { markCommentedDiffLines, markCommentedFileLines } from "../pierre/commented-lines"
import { DiffSelectionFix, fixDiffSelection, findDiffSide, type DiffSelectionSide } from "../pierre/diff-selection"
import { createFileFind } from "../pierre/file-find"
import {
  applyViewerScheme,
  clearReadyWatcher,
  createReadyWatcher,
  getViewerHost,
  getViewerRoot,
  notifyShadowReady,
  observeViewerScheme,
} from "../pierre/file-runtime"
import {
  findCodeSelectionSide,
  findDiffLineNumber,
  findElement,
  findFileLineNumber,
  parseLineNumber,
  readShadowLineSelection,
} from "../pierre/file-selection"
import { createLineNumberSelectionBridge, restoreShadowTextSelection } from "../pierre/selection-bridge"
import { acquireVirtualizer, type VirtualizerLease, virtualMetrics } from "../pierre/virtualizer"
import { getWorkerPool } from "../pierre/worker"
import { FileMedia, type FileMediaOptions } from "./file-media"
import { FileSearchBar } from "./file-search"

const VIRTUALIZE_BYTES = 500_000

// A diff instance keeps the virtualizer and worker pool it was built with, so a different object means a new instance.
const sameVirtualizer = Option.makeEquivalence(Equivalence.strictEqual<Virtualizer>())
const sameWorkerPool = Option.makeEquivalence(Equivalence.strictEqual<WorkerPoolManager>())

const codeMetrics = {
  ...DEFAULT_VIRTUAL_FILE_METRICS,
  lineHeight: 24,
  spacing: 0,
} satisfies Partial<VirtualFileMetrics>

type SharedProps<T> = {
  annotations?: LineAnnotation<T>[] | DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
  media?: FileMediaOptions
  search?: FileSearchControl
}

export type FileSearchHandle = {
  focus: () => void
}

export type FileSearchControl = {
  register: (handle: FileSearchHandle | null) => void
}

export type TextFileProps<T = {}> = FileOptions<T> &
  SharedProps<T> & {
    mode: "text"
    file: FileContents
    annotations?: LineAnnotation<T>[]
    preloadedDiff?: PreloadMultiFileDiffResult<T>
  }

type DiffPreload<T> = PreloadMultiFileDiffResult<T> | PreloadFileDiffResult<T>

type DiffBaseProps<T> = FileDiffOptions<T> &
  SharedProps<T> & {
    mode: "diff"
    annotations?: DiffLineAnnotation<T>[]
    preloadedDiff?: DiffPreload<T>
    virtualize?: boolean
  }

type DiffPairProps<T> = DiffBaseProps<T> & {
  before: FileContents
  after: FileContents
  fileDiff?: undefined
}

type DiffPatchProps<T> = DiffBaseProps<T> & {
  fileDiff: FileDiffMetadata
  before?: undefined
  after?: undefined
}

export type DiffFileProps<T = {}> = DiffPairProps<T> | DiffPatchProps<T>

export type FileProps<T = {}> = TextFileProps<T> | DiffFileProps<T>

const sharedKeys = [
  "mode",
  "media",
  "class",
  "classList",
  "annotations",
  "selectedLines",
  "commentedLines",
  "search",
  "onLineSelected",
  "onLineSelectionEnd",
  "onLineNumberSelectionEnd",
  "onRendered",
  "preloadedDiff",
] as const

const textKeys = ["file", ...sharedKeys] as const
const diffKeys = ["fileDiff", "before", "after", "virtualize", ...sharedKeys] as const

// ---------------------------------------------------------------------------
// Shared viewer hook
// ---------------------------------------------------------------------------

type MouseHit = {
  line: Option.Option<number>
  numberColumn: boolean
  side: Option.Option<DiffSelectionSide>
}

type ViewerConfig = {
  enableLineSelection: () => boolean
  selectedLines: () => SelectedLineRange | null | undefined
  commentedLines: () => SelectedLineRange[]
  onLineSelectionEnd: (range: SelectedLineRange | null) => void

  // mode-specific callbacks
  lineFromMouseEvent: (event: MouseEvent) => MouseHit
  setSelectedLines: (range: SelectedLineRange | null, preserve?: { root: ShadowRoot; text: Range }) => void
  updateSelection: (preserveTextSelection: boolean) => void
  buildDragSelection: () => Option.Option<SelectedLineRange>
  buildClickSelection: () => Option.Option<SelectedLineRange>
  onDragStart: (hit: MouseHit) => void
  onDragMove: (hit: MouseHit) => void
  onDragReset: () => void
  markCommented: (root: ShadowRoot, ranges: SelectedLineRange[]) => void
}

function sameSelection(current: Option.Option<SelectedLineRange>, next: SelectedLineRange) {
  return Option.exists(
    current,
    (range) =>
      range.start === next.start &&
      range.end === next.end &&
      range.side === next.side &&
      (range.endSide ?? range.side) === (next.endSide ?? next.side),
  )
}

function useFileViewer(config: ViewerConfig) {
  let wrapper!: HTMLDivElement
  let container!: HTMLDivElement
  let overlay!: HTMLDivElement
  let selectionFrame: Option.Option<number> = Option.none()
  let dragFrame: Option.Option<number> = Option.none()
  let dragStart: Option.Option<number> = Option.none()
  let dragEnd: Option.Option<number> = Option.none()
  let dragMoved = false
  let lastSelection: SelectedLineRange | null = null
  let pendingSelectionEnd = false

  const ready = createReadyWatcher()
  const bridge = createLineNumberSelectionBridge()
  const [rendered, setRendered] = createSignal(0)

  const getRoot = () => getViewerRoot(container)
  const getHost = () => getViewerHost(container)

  const find = createFileFind({
    wrapper: () => wrapper,
    overlay: () => overlay,
    getRoot,
  })

  // -- selection scheduling --

  const scheduleSelectionUpdate = () => {
    if (Option.isSome(selectionFrame)) return
    selectionFrame = Option.some(
      requestAnimationFrame(() => {
        selectionFrame = Option.none()
        const finishing = pendingSelectionEnd
        config.updateSelection(finishing)
        if (!pendingSelectionEnd) return
        pendingSelectionEnd = false
        config.onLineSelectionEnd(lastSelection)
      }),
    )
  }

  const scheduleDragUpdate = () => {
    if (Option.isSome(dragFrame)) return
    dragFrame = Option.some(
      requestAnimationFrame(() => {
        dragFrame = Option.none()
        const selected = config.buildDragSelection()
        if (Option.isSome(selected)) config.setSelectedLines(selected.value)
      }),
    )
  }

  // -- mouse handlers --

  const handleMouseDown = (event: MouseEvent) => {
    if (!config.enableLineSelection()) return
    if (event.button !== 0) return

    const hit = config.lineFromMouseEvent(event)
    if (hit.numberColumn) {
      bridge.begin(true, hit.line)
      return
    }
    if (Option.isNone(hit.line)) return

    bridge.begin(false, hit.line)
    dragStart = hit.line
    dragEnd = hit.line
    dragMoved = false
    config.onDragStart(hit)
  }

  const handleMouseMove = (event: MouseEvent) => {
    if (!config.enableLineSelection()) return

    const hit = config.lineFromMouseEvent(event)
    if (bridge.track(event.buttons, hit.line)) return
    if (Option.isNone(dragStart)) return

    if ((event.buttons & 1) === 0) {
      dragStart = Option.none()
      dragEnd = Option.none()
      dragMoved = false
      config.onDragReset()
      bridge.finish()
      return
    }

    if (Option.isNone(hit.line)) return
    dragEnd = hit.line
    dragMoved = true
    config.onDragMove(hit)
    scheduleDragUpdate()
  }

  const handleMouseUp = () => {
    if (!config.enableLineSelection()) return
    if (bridge.finish() === "numbers") return
    if (Option.isNone(dragStart)) return

    if (!dragMoved) {
      pendingSelectionEnd = false
      const selected = config.buildClickSelection()
      if (Option.isNone(selected)) {
        config.onLineSelectionEnd(lastSelection)
      } else {
        // A click on the line that is already selected clears the selection.
        const next = sameSelection(Option.fromNullOr(lastSelection), selected.value) ? null : selected.value
        config.setSelectedLines(next)
        config.onLineSelectionEnd(next)
      }
      dragStart = Option.none()
      dragEnd = Option.none()
      dragMoved = false
      config.onDragReset()
      return
    }

    pendingSelectionEnd = true
    scheduleDragUpdate()
    scheduleSelectionUpdate()

    dragStart = Option.none()
    dragEnd = Option.none()
    dragMoved = false
    config.onDragReset()
  }

  const handleSelectionChange = () => {
    if (!config.enableLineSelection()) return
    if (Option.isNone(dragStart)) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    scheduleSelectionUpdate()
  }

  // -- shared effects --

  onMount(() => {
    onCleanup(observeViewerScheme(getHost))
  })

  createEffect(() => {
    rendered()
    const ranges = config.commentedLines()
    const found = getRoot()
    if (Option.isNone(found)) return
    const root = found.value
    if (ranges.length === 0) {
      config.markCommented(root, ranges)
      return
    }

    let frame: Option.Option<number> = Option.none()
    const mark = () => {
      if (Option.isSome(frame)) cancelAnimationFrame(frame.value)
      frame = Option.some(
        requestAnimationFrame(() => {
          frame = Option.none()
          config.markCommented(root, ranges)
        }),
      )
    }
    const observer = new MutationObserver(mark)

    observer.observe(root, { childList: true, subtree: true })
    mark()

    onCleanup(() => {
      observer.disconnect()
      if (Option.isSome(frame)) cancelAnimationFrame(frame.value)
    })
  })

  createEffect(() => {
    config.setSelectedLines(config.selectedLines() ?? null)
  })

  createEffect(() => {
    if (!config.enableLineSelection()) return

    makeEventListener(container, "mousedown", handleMouseDown)
    makeEventListener(container, "mousemove", handleMouseMove)
    makeEventListener(window, "mouseup", handleMouseUp)
    makeEventListener(document, "selectionchange", handleSelectionChange)
  })

  onCleanup(() => {
    clearReadyWatcher(ready)

    if (Option.isSome(selectionFrame)) cancelAnimationFrame(selectionFrame.value)
    if (Option.isSome(dragFrame)) cancelAnimationFrame(dragFrame.value)

    selectionFrame = Option.none()
    dragFrame = Option.none()
    dragStart = Option.none()
    dragEnd = Option.none()
    dragMoved = false
    bridge.reset()
    lastSelection = null
    pendingSelectionEnd = false
  })

  return {
    get wrapper() {
      return wrapper
    },
    set wrapper(v: HTMLDivElement) {
      wrapper = v
    },
    get container() {
      return container
    },
    set container(v: HTMLDivElement) {
      container = v
    },
    get overlay() {
      return overlay
    },
    set overlay(v: HTMLDivElement) {
      overlay = v
    },
    get dragStart() {
      return dragStart
    },
    get dragEnd() {
      return dragEnd
    },
    get lastSelection() {
      return lastSelection
    },
    set lastSelection(v: SelectedLineRange | null) {
      lastSelection = v
    },
    ready,
    bridge,
    rendered,
    setRendered,
    getRoot,
    getHost,
    find,
    scheduleSelectionUpdate,
  }
}

type Viewer = ReturnType<typeof useFileViewer>

type ModeAdapter = Omit<ViewerConfig, "enableLineSelection" | "selectedLines" | "commentedLines" | "onLineSelectionEnd">

type ModeConfig = {
  enableLineSelection: () => boolean
  selectedLines: () => SelectedLineRange | null | undefined
  commentedLines: () => SelectedLineRange[] | undefined
  onLineSelectionEnd: (range: SelectedLineRange | null) => void
}

type RenderTarget = {
  cleanUp: () => void
}

type AnnotationTarget<A> = {
  setLineAnnotations: (annotations: A[]) => void
  rerender: () => void
}

/** The live FileDiff and the inputs it was built from. */
type DiffInstance<T> = {
  diff: FileDiff<T>
  virtualizer: Option.Option<Virtualizer>
  workerPool: Option.Option<WorkerPoolManager>
  hunkSeparators: FileDiffOptions<T>["hunkSeparators"]
  fileDiff: Option.Option<FileDiffMetadata>
  before: Option.Option<FileContents>
  after: Option.Option<FileContents>
}

function sameFile(current: Option.Option<FileContents>, next: Option.Option<FileContents>) {
  return Option.isSome(current) && Option.isSome(next) && areFilesEqual(current.value, next.value)
}

type VirtualStrategy = {
  get: () => Option.Option<Virtualizer>
  cleanup: () => void
}

function useModeViewer(config: ModeConfig, adapter: ModeAdapter) {
  return useFileViewer({
    enableLineSelection: config.enableLineSelection,
    selectedLines: config.selectedLines,
    commentedLines: () => config.commentedLines() ?? [],
    onLineSelectionEnd: config.onLineSelectionEnd,
    ...adapter,
  })
}

function useSearchHandle(opts: {
  search: () => FileSearchControl | undefined
  find: ReturnType<typeof createFileFind>
}) {
  createEffect(() => {
    const search = opts.search()
    if (!search) return

    const handle = {
      focus: () => opts.find.focus(),
    } satisfies FileSearchHandle

    search.register(handle)
    onCleanup(() => search.register(null))
  })
}

function createLineCallbacks(opts: {
  viewer: Viewer
  normalize?: (range: Option.Option<SelectedLineRange>) => DiffSelectionFix
  onLineSelected?: (range: SelectedLineRange | null) => void
  onLineSelectionEnd?: (range: SelectedLineRange | null) => void
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
}) {
  const select = (range: SelectedLineRange | null) => {
    if (!opts.normalize) return range
    const fixed = opts.normalize(Option.fromNullOr(range))
    // A pending fix means the rows are not rendered yet, so the range stays as pierre reported it.
    if (fixed._tag === "Pending") return range
    return Option.getOrNull(fixed.range)
  }

  return {
    onLineSelected: (range: SelectedLineRange | null) => {
      const next = select(range)
      opts.viewer.lastSelection = next
      opts.onLineSelected?.(next)
    },
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      const next = select(range)
      opts.viewer.lastSelection = next
      opts.onLineSelectionEnd?.(next)
      if (!opts.viewer.bridge.consume(next)) return
      requestAnimationFrame(() => opts.onLineNumberSelectionEnd?.(next))
    },
  }
}

function useAnnotationRerender<A>(opts: {
  viewer: Viewer
  current: () => Option.Option<AnnotationTarget<A>>
  annotations: () => A[]
}) {
  const applied = new WeakSet<AnnotationTarget<A>>()
  createEffect(() => {
    opts.viewer.rendered()
    const current = opts.current()
    if (Option.isNone(current)) return
    const active = current.value
    const annotations = opts.annotations()
    // renderViewer always draws with empty annotations, so skip the extra rerender
    // when this instance has nothing applied and nothing to apply.
    if (annotations.length === 0 && !applied.has(active)) return
    if (annotations.length === 0) applied.delete(active)
    else applied.add(active)
    active.setLineAnnotations(annotations)
    active.rerender()
    requestAnimationFrame(() => opts.viewer.find.refresh({ reset: true }))
  })
}

function notifyRendered(opts: {
  viewer: Viewer
  isReady: (root: ShadowRoot) => boolean
  settleFrames?: number
  onReady: () => void
}) {
  notifyShadowReady({
    state: opts.viewer.ready,
    container: opts.viewer.container,
    getRoot: opts.viewer.getRoot,
    isReady: opts.isReady,
    settleFrames: opts.settleFrames,
    onReady: opts.onReady,
  })
}

function renderViewer<I extends RenderTarget>(opts: {
  viewer: Viewer
  current: Option.Option<I>
  reset?: boolean
  create: () => I
  update?: (value: I) => void
  assign: (value: I) => void
  draw: (value: I) => void
  onReady: () => void
}) {
  clearReadyWatcher(opts.viewer.ready)
  // A reset cleans up the current instance, and a new one takes its place.
  if (opts.reset === true && Option.isSome(opts.current)) opts.current.value.cleanUp()
  const kept = opts.reset === true ? Option.none<I>() : opts.current
  const next = Option.match(kept, {
    onNone: () => {
      const created = opts.create()
      opts.viewer.container.innerHTML = ""
      opts.assign(created)
      return created
    },
    onSome: (value) => {
      opts.update?.(value)
      return value
    },
  })

  opts.draw(next)

  applyViewerScheme(opts.viewer.getHost())
  opts.viewer.setRendered((value) => value + 1)
  opts.onReady()
}

function preserve(viewer: Viewer) {
  const parent = scrollParent(viewer.wrapper)
  if (Option.isNone(parent)) return () => {}
  const root = parent.value

  const high = viewer.container.getBoundingClientRect().height
  if (!high) return () => {}

  const top = viewer.wrapper.getBoundingClientRect().top - root.getBoundingClientRect().top
  const prev = viewer.container.style.minHeight
  viewer.container.style.minHeight = `${Math.ceil(high)}px`

  let done = false
  return () => {
    if (done) return
    done = true
    viewer.container.style.minHeight = prev

    const next = viewer.wrapper.getBoundingClientRect().top - root.getBoundingClientRect().top
    const delta = next - top
    if (delta) root.scrollTop += delta
  }
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

function createLocalVirtualStrategy(host: () => HTMLDivElement | undefined, enabled: () => boolean): VirtualStrategy {
  let virtualizer: Option.Option<Virtualizer> = Option.none()
  let root: Option.Option<Document | HTMLElement> = Option.none()

  const release = () => {
    if (Option.isSome(virtualizer)) virtualizer.value.cleanUp()
    virtualizer = Option.none()
    root = Option.none()
  }

  return {
    get: () => {
      if (!enabled()) {
        release()
        return Option.none()
      }
      if (typeof document === "undefined") return Option.none()

      const wrapper = host()
      if (!wrapper) return Option.none()

      const next = Option.getOrElse(scrollParent(wrapper), (): Document | HTMLElement => document)
      if (Option.isSome(virtualizer) && Option.exists(root, (current) => current === next)) return virtualizer

      release()
      const created = new Virtualizer()
      if (next instanceof Document) created.setup(next)
      else created.setup(next, wrapper)
      virtualizer = Option.some(created)
      root = Option.some(next)
      return virtualizer
    },
    cleanup: release,
  }
}

function createSharedVirtualStrategy(host: () => HTMLDivElement | undefined, enabled: () => boolean): VirtualStrategy {
  let shared: Option.Option<VirtualizerLease> = Option.none()

  const release = () => {
    if (Option.isSome(shared)) shared.value.release()
    shared = Option.none()
  }

  return {
    get: () => {
      if (!enabled()) {
        release()
        return Option.none()
      }
      if (Option.isSome(shared)) return Option.some(shared.value.virtualizer)

      const container = host()
      if (!container) return Option.none()

      shared = acquireVirtualizer(container)
      return Option.map(shared, (lease) => lease.virtualizer)
    },
    cleanup: release,
  }
}

function parseLine(node: HTMLElement): Option.Option<number> {
  return parseLineNumber(node.dataset.line)
}

function mouseHit(
  event: MouseEvent,
  line: (node: HTMLElement) => Option.Option<number>,
  side?: (node: HTMLElement) => Option.Option<DiffSelectionSide>,
): MouseHit {
  const path = event.composedPath()
  let numberColumn = false
  let value: Option.Option<number> = Option.none()
  let branch: Option.Option<DiffSelectionSide> = Option.none()

  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue

    numberColumn = numberColumn || item.dataset.columnNumber != null
    if (Option.isNone(value)) value = line(item)
    if (Option.isNone(branch) && side) branch = side(item)

    if (numberColumn && Option.isSome(value) && (side == null || Option.isSome(branch))) break
  }

  return {
    line: value,
    numberColumn,
    side: branch,
  }
}

function diffMouseSide(node: HTMLElement): Option.Option<DiffSelectionSide> {
  const type = node.dataset.lineType
  if (type === "change-deletion") return Option.some("deletions")
  if (type === "change-addition" || type === "change-additions") return Option.some("additions")
  if (node.dataset.code === undefined) return Option.none()
  return Option.some(node.hasAttribute("data-deletions") ? "deletions" : "additions")
}

function diffSelectionSide(node: Node | null): Option.Option<DiffSelectionSide> {
  return Option.map(findElement(node), findDiffSide)
}

// ---------------------------------------------------------------------------
// Shared JSX shell
// ---------------------------------------------------------------------------

function ViewerShell(props: {
  mode: "text" | "diff"
  viewer: ReturnType<typeof useFileViewer>
  class: string | undefined
  classList: ComponentProps<"div">["classList"] | undefined
}) {
  return (
    <div
      data-component="file"
      data-mode={props.mode}
      dir="ltr"
      style={styleVariables}
      class="relative outline-none"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      ref={(el) => (props.viewer.wrapper = el)}
      tabIndex={0}
      onPointerDown={props.viewer.find.onPointerDown}
      onFocus={props.viewer.find.onFocus}
    >
      <Show when={props.viewer.find.open()}>
        <FileSearchBar
          pos={props.viewer.find.pos}
          query={props.viewer.find.query}
          count={props.viewer.find.count}
          index={props.viewer.find.index}
          setInput={props.viewer.find.setInput}
          onInput={props.viewer.find.setQuery}
          onKeyDown={props.viewer.find.onInputKeyDown}
          onClose={props.viewer.find.close}
          onPrev={() => props.viewer.find.next(-1)}
          onNext={() => props.viewer.find.next(1)}
        />
      </Show>
      <div ref={(el) => (props.viewer.container = el)} />
      <div ref={(el) => (props.viewer.overlay = el)} class="pointer-events-none absolute inset-0 z-0" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// TextViewer
// ---------------------------------------------------------------------------

function TextViewer<T>(props: TextFileProps<T>) {
  let instance: Option.Option<PierreFile<T> | VirtualizedFile<T>> = Option.none()
  let viewer!: Viewer

  const [local, others] = splitProps(props, textKeys)

  const text = () => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.join("\n")
    if (value == null) return ""
    // oxlint-disable-next-line no-base-to-string -- file contents cast to unknown, coercion is intentional
    return String(value)
  }

  const lineCount = () => {
    const value = text()
    const total = value.split("\n").length - (value.endsWith("\n") ? 1 : 0)
    return Math.max(1, total)
  }

  const bytes = createMemo(() => {
    const value = local.file.contents as unknown
    if (typeof value === "string") return value.length
    if (Array.isArray(value)) {
      return value.reduce(
        // oxlint-disable-next-line no-base-to-string -- array parts coerced intentionally
        (sum, part) => sum + (typeof part === "string" ? part.length + 1 : String(part).length + 1),
        0,
      )
    }
    if (value == null) return 0
    // oxlint-disable-next-line no-base-to-string -- file contents cast to unknown, coercion is intentional
    return String(value).length
  })

  const virtual = createMemo(() => bytes() > VIRTUALIZE_BYTES)

  const virtuals = createLocalVirtualStrategy(() => viewer.wrapper, virtual)

  const lineFromMouseEvent = (event: MouseEvent): MouseHit => mouseHit(event, parseLine)

  const applySelection = (range: SelectedLineRange | null) => {
    if (Option.isNone(instance)) return false
    const current = instance.value

    if (virtual()) {
      current.setSelectedLines(range)
      return true
    }

    const found = viewer.getRoot()
    if (Option.isNone(found)) return false
    const root = found.value

    const total = lineCount()
    if (root.querySelectorAll("[data-line]").length < total) return false

    if (!range) {
      current.setSelectedLines(null)
      return true
    }

    const start = Math.min(range.start, range.end)
    const end = Math.max(range.start, range.end)
    if (start < 1 || end > total) {
      current.setSelectedLines(null)
      return true
    }

    if (!root.querySelector(`[data-line="${start}"]`) || !root.querySelector(`[data-line="${end}"]`)) {
      current.setSelectedLines(null)
      return true
    }

    const normalized = (() => {
      if (range.endSide != null) return { start: range.start, end: range.end }
      if (range.side !== "deletions") return range
      if (root.querySelector("[data-deletions]") != null) return range
      return { start: range.start, end: range.end }
    })()

    current.setSelectedLines(normalized)
    return true
  }

  const setSelectedLines = (range: SelectedLineRange | null) => {
    viewer.lastSelection = range
    applySelection(range)
  }

  const adapter: ModeAdapter = {
    lineFromMouseEvent,
    setSelectedLines,
    updateSelection: (preserveTextSelection) => {
      const root = viewer.getRoot()
      if (Option.isNone(root)) return

      const selected = readShadowLineSelection({
        root: root.value,
        lineForNode: findFileLineNumber,
        sideForNode: findCodeSelectionSide,
        preserveTextSelection,
      })
      if (Option.isNone(selected)) return

      setSelectedLines(selected.value.range)
      const text = selected.value.text
      if (!preserveTextSelection || Option.isNone(text)) return
      restoreShadowTextSelection(root.value, text.value)
    },
    buildDragSelection: () =>
      Option.zipWith(viewer.dragStart, viewer.dragEnd, (start, end) => ({
        start: Math.min(start, end),
        end: Math.max(start, end),
      })),
    buildClickSelection: () => Option.map(viewer.dragStart, (line) => ({ start: line, end: line })),
    onDragStart: () => {},
    onDragMove: () => {},
    onDragReset: () => {},
    markCommented: markCommentedFileLines,
  }

  viewer = useModeViewer(
    {
      enableLineSelection: () => props.enableLineSelection === true,
      selectedLines: () => local.selectedLines,
      commentedLines: () => local.commentedLines,
      onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    },
    adapter,
  )

  const lineCallbacks = createLineCallbacks({
    viewer,
    onLineSelected: (range) => local.onLineSelected?.(range),
    onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    onLineNumberSelectionEnd: (range) => local.onLineNumberSelectionEnd?.(range),
  })

  const options = createMemo(() => ({
    ...createDefaultOptions("unified"),
    ...others,
    ...lineCallbacks,
  }))

  const notify = () => {
    notifyRendered({
      viewer,
      isReady: (root) => {
        if (virtual()) return root.querySelector("[data-line]") != null
        return root.querySelectorAll("[data-line]").length >= lineCount()
      },
      onReady: () => {
        applySelection(viewer.lastSelection)
        viewer.find.refresh({ reset: true })
        local.onRendered?.()
      },
    })
  }

  useSearchHandle({
    search: () => local.search,
    find: viewer.find,
  })

  // -- render instance --

  createEffect(() => {
    const opts = options()
    const workerPool = getWorkerPool("unified")
    const virtualizer = virtuals.get()

    renderViewer({
      viewer,
      current: instance,
      reset: Option.isSome(instance),
      create: () =>
        Option.match(virtualizer, {
          onNone: (): PierreFile<T> | VirtualizedFile<T> => new PierreFile<T>(opts, workerPool),
          onSome: (value) => new VirtualizedFile<T>(opts, value, codeMetrics, workerPool),
        }),
      assign: (value) => {
        instance = Option.some(value)
      },
      draw: (value) => {
        const contents = text()
        value.render({
          file: typeof local.file.contents === "string" ? local.file : { ...local.file, contents },
          lineAnnotations: [],
          containerWrapper: viewer.container,
        })
      },
      onReady: notify,
    })
  })

  useAnnotationRerender<LineAnnotation<T>>({
    viewer,
    current: () => instance,
    annotations: () => (local.annotations as LineAnnotation<T>[] | undefined) ?? [],
  })

  // -- cleanup --

  onCleanup(() => {
    if (Option.isSome(instance)) instance.value.cleanUp()
    instance = Option.none()
    virtuals.cleanup()
  })

  return <ViewerShell mode="text" viewer={viewer} class={local.class} classList={local.classList} />
}

// ---------------------------------------------------------------------------
// DiffViewer
// ---------------------------------------------------------------------------

function DiffViewer<T>(props: DiffFileProps<T>) {
  let instance: Option.Option<DiffInstance<T>> = Option.none()
  const currentDiff = () => Option.map(instance, (value) => value.diff)
  let dragSide: Option.Option<DiffSelectionSide> = Option.none()
  let dragEndSide: Option.Option<DiffSelectionSide> = Option.none()
  let viewer!: Viewer

  const [local, others] = splitProps(props, diffKeys)

  const mobile = createMediaQuery("(max-width: 640px)")

  const lineFromMouseEvent = (event: MouseEvent): MouseHit => mouseHit(event, findDiffLineNumber, diffMouseSide)

  const setSelectedLines = (range: SelectedLineRange | null, preserve?: { root: ShadowRoot; text: Range }) => {
    if (Option.isNone(instance)) return
    const active = instance.value.diff

    const fixed = fixDiffSelection(viewer.getRoot(), Option.fromNullOr(range))
    if (fixed._tag === "Pending") {
      viewer.lastSelection = range
      return
    }

    const next = Option.getOrNull(fixed.range)
    viewer.lastSelection = next
    active.setSelectedLines(next)
    restoreShadowTextSelection(preserve?.root, preserve?.text)
  }

  const adapter: ModeAdapter = {
    lineFromMouseEvent,
    setSelectedLines,
    updateSelection: (preserveTextSelection) => {
      const root = viewer.getRoot()
      if (Option.isNone(root)) return

      const selected = readShadowLineSelection({
        root: root.value,
        lineForNode: findDiffLineNumber,
        sideForNode: diffSelectionSide,
        preserveTextSelection,
      })
      if (Option.isNone(selected)) return

      const text = selected.value.text
      if (Option.isSome(text)) {
        setSelectedLines(selected.value.range, { root: root.value, text: text.value })
        return
      }

      setSelectedLines(selected.value.range)
    },
    buildDragSelection: () =>
      Option.zipWith(viewer.dragStart, viewer.dragEnd, (start, end) => {
        const selected: SelectedLineRange = { start, end }
        if (Option.isSome(dragSide)) selected.side = dragSide.value
        if (Option.isSome(dragEndSide) && Option.isSome(dragSide) && dragEndSide.value !== dragSide.value)
          selected.endSide = dragEndSide.value
        return selected
      }),
    buildClickSelection: () =>
      Option.map(viewer.dragStart, (line) => {
        const selected: SelectedLineRange = { start: line, end: line }
        if (Option.isSome(dragSide)) selected.side = dragSide.value
        return selected
      }),
    onDragStart: (hit) => {
      dragSide = hit.side
      dragEndSide = hit.side
    },
    onDragMove: (hit) => {
      dragEndSide = hit.side
    },
    onDragReset: () => {
      dragSide = Option.none()
      dragEndSide = Option.none()
    },
    markCommented: markCommentedDiffLines,
  }

  viewer = useModeViewer(
    {
      enableLineSelection: () => props.enableLineSelection === true,
      selectedLines: () => local.selectedLines,
      commentedLines: () => local.commentedLines,
      onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    },
    adapter,
  )

  const virtuals = createSharedVirtualStrategy(
    () => viewer.container,
    () => local.virtualize !== false,
  )

  const large = createMemo(() => {
    if (local.fileDiff) {
      const before = local.fileDiff.deletionLines.join("")
      const after = local.fileDiff.additionLines.join("")
      return Math.max(before.length, after.length) > 500_000
    }

    const before = typeof local.before?.contents === "string" ? local.before.contents : ""
    const after = typeof local.after?.contents === "string" ? local.after.contents : ""
    return Math.max(before.length, after.length) > 500_000
  })

  const largeOptions = {
    lineDiffType: "none",
    maxLineDiffLength: 0,
    tokenizeMaxLineLength: 1,
  } satisfies Pick<FileDiffOptions<T>, "lineDiffType" | "maxLineDiffLength" | "tokenizeMaxLineLength">

  const lineCallbacks = createLineCallbacks({
    viewer,
    normalize: (range) => fixDiffSelection(viewer.getRoot(), range),
    onLineSelected: (range) => local.onLineSelected?.(range),
    onLineSelectionEnd: (range) => local.onLineSelectionEnd?.(range),
    onLineNumberSelectionEnd: (range) => local.onLineNumberSelectionEnd?.(range),
  })

  const options = createMemo<FileDiffOptions<T>>(() => {
    const base = {
      ...createDefaultOptions(props.diffStyle),
      ...others,
      ...lineCallbacks,
    }

    const perf = large() ? { ...base, ...largeOptions } : base
    if (!mobile()) return perf
    return { ...perf, disableLineNumbers: true }
  })

  const notify = (done?: VoidFunction) => {
    notifyRendered({
      viewer,
      isReady: (root) => root.querySelector("[data-line]") != null,
      settleFrames: 1,
      onReady: () => {
        done?.()
        setSelectedLines(viewer.lastSelection)
        viewer.find.refresh({ reset: true })
        local.onRendered?.()
      },
    })
  }

  useSearchHandle({
    search: () => local.search,
    find: viewer.find,
  })

  // -- render instance --

  createEffect(() => {
    const opts = options()
    const workerPool = Option.fromUndefinedOr(large() ? getWorkerPool("unified") : getWorkerPool(props.diffStyle))
    const virtualizer = virtuals.get()
    const beforeContents = typeof local.before?.contents === "string" ? local.before.contents : ""
    const afterContents = typeof local.after?.contents === "string" ? local.after.contents : ""
    const done = preserve(viewer)

    onCleanup(done)

    const cacheKey = (contents: string) => {
      if (!large()) return sampledChecksum(contents, contents.length)
      return sampledChecksum(contents)
    }

    const before = Option.map(Option.fromNullishOr(local.before), (file) => ({
      ...file,
      contents: beforeContents,
      cacheKey: cacheKey(beforeContents),
    }))
    const after = Option.map(Option.fromNullishOr(local.after), (file) => ({
      ...file,
      contents: afterContents,
      cacheKey: cacheKey(afterContents),
    }))
    const targetChanged = (current: DiffInstance<T>) =>
      local.fileDiff !== undefined
        ? !Option.exists(current.fileDiff, (value) => value === local.fileDiff)
        : Option.isSome(current.fileDiff) || !sameFile(current.before, before) || !sameFile(current.after, after)
    // Pierre beta virtualized instances retain their first diff target and resolve separator metrics at construction.
    // Plain timeline diffs can retain the instance as content streams; virtualized viewers reset only when that is unsafe.
    // The instance keeps the hunk separators it was built with; they matter only for a virtualized instance.
    const reset = Option.exists(
      instance,
      (current) =>
        !sameVirtualizer(current.virtualizer, virtualizer) ||
        !sameWorkerPool(current.workerPool, workerPool) ||
        (Option.isSome(virtualizer) && (current.hunkSeparators !== opts.hunkSeparators || targetChanged(current))),
    )
    const forceRender = !reset && Option.exists(instance, (current) => !areOptionsEqual(current.diff.options, opts))

    renderViewer({
      viewer,
      current: currentDiff(),
      reset,
      // The FileDiff constructors take an optional worker pool, so an absent pool crosses as undefined.
      create: () =>
        Option.match(virtualizer, {
          onNone: () => new FileDiff<T>(opts, Option.getOrUndefined(workerPool)),
          onSome: (value) =>
            new VirtualizedFileDiff<T>(opts, value, virtualMetrics, Option.getOrUndefined(workerPool)),
        }),
      update: (value) => value.setOptions(opts),
      assign: (value) => {
        instance = Option.some({
          diff: value,
          virtualizer,
          workerPool,
          hunkSeparators: opts.hunkSeparators,
          fileDiff: Option.fromUndefinedOr(local.fileDiff),
          before,
          after,
        })
      },
      draw: (value) => {
        if (local.fileDiff) {
          value.render({
            fileDiff: local.fileDiff,
            forceRender,
            lineAnnotations: [],
            containerWrapper: viewer.container,
          })
          return
        }

        if (Option.isNone(before) || Option.isNone(after)) return

        value.render({
          oldFile: before.value,
          newFile: after.value,
          forceRender,
          lineAnnotations: [],
          containerWrapper: viewer.container,
        })
      },
      onReady: () => notify(done),
    })
  })

  useAnnotationRerender<DiffLineAnnotation<T>>({
    viewer,
    current: currentDiff,
    annotations: () => (local.annotations as DiffLineAnnotation<T>[] | undefined) ?? [],
  })

  // -- cleanup --

  onCleanup(() => {
    if (Option.isSome(instance)) instance.value.diff.cleanUp()
    instance = Option.none()
    virtuals.cleanup()
    dragSide = Option.none()
    dragEndSide = Option.none()
  })

  return <ViewerShell mode="diff" viewer={viewer} class={local.class} classList={local.classList} />
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function File<T>(props: FileProps<T>) {
  if (props.mode === "text") {
    return <FileMedia media={props.media} fallback={() => TextViewer(props)} />
  }

  return <FileMedia media={props.media} fallback={() => DiffViewer(props)} />
}

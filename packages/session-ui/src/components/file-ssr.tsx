import { DIFFS_TAG_NAME, FileDiff, type SelectedLineRange, VirtualizedFileDiff, type Virtualizer } from "@pierre/diffs"
import { type PreloadFileDiffResult, type PreloadMultiFileDiffResult } from "@pierre/diffs/ssr"
import { createEffect, onCleanup, onMount, Show, splitProps } from "solid-js"
import { Dynamic, isServer } from "solid-js/web"
import { Option } from "effect"
import { useWorkerPool } from "@opencode-ai/ui/context/worker-pool"
import { createDefaultOptions, styleVariables } from "../pierre"
import { markCommentedDiffLines } from "../pierre/commented-lines"
import { fixDiffSelection } from "../pierre/diff-selection"
import {
  applyViewerScheme,
  clearReadyWatcher,
  createReadyWatcher,
  notifyShadowReady,
  observeViewerScheme,
} from "../pierre/file-runtime"
import { acquireVirtualizer, type VirtualizerLease, virtualMetrics } from "../pierre/virtualizer"
import { File, type DiffFileProps, type FileProps } from "./file"

type DiffPreload<T> = PreloadMultiFileDiffResult<T> | PreloadFileDiffResult<T>

type SSRDiffFileProps<T> = DiffFileProps<T> & {
  preloadedDiff: DiffPreload<T>
}

function DiffSSRViewer<T>(props: SSRDiffFileProps<T>) {
  let container!: HTMLDivElement
  let fileDiffRef!: HTMLElement
  let fileDiffInstance: FileDiff<T> | undefined
  let sharedVirtualizer: Option.Option<VirtualizerLease> = Option.none()

  const ready = createReadyWatcher()
  const workerPool = useWorkerPool(props.diffStyle)

  const [local, others] = splitProps(props, [
    "mode",
    "media",
    "fileDiff",
    "before",
    "after",
    "class",
    "classList",
    "annotations",
    "selectedLines",
    "commentedLines",
    "onLineSelected",
    "onLineSelectionEnd",
    "onLineNumberSelectionEnd",
    "onRendered",
    "preloadedDiff",
  ])

  const getRoot = () => Option.fromNullishOr(fileDiffRef?.shadowRoot)

  const getVirtualizer = (): Option.Option<Virtualizer> => {
    if (Option.isSome(sharedVirtualizer)) return Option.some(sharedVirtualizer.value.virtualizer)
    sharedVirtualizer = acquireVirtualizer(container)
    return Option.map(sharedVirtualizer, (lease) => lease.virtualizer)
  }

  const setSelectedLines = (range: Option.Option<SelectedLineRange>, attempt = 0) => {
    const diff = fileDiffInstance
    if (!diff) return

    const fixed = fixDiffSelection(getRoot(), range)
    if (fixed._tag === "Pending") {
      if (attempt >= 120) return
      requestAnimationFrame(() => setSelectedLines(range, attempt + 1))
      return
    }

    // FileDiff.setSelectedLines takes null to clear the selection.
    diff.setSelectedLines(Option.getOrNull(fixed.range))
  }

  const notifyRendered = () => {
    notifyShadowReady({
      state: ready,
      container,
      getRoot,
      isReady: (root) => root.querySelector("[data-line]") != null,
      settleFrames: 1,
      onReady: () => {
        setSelectedLines(Option.fromNullishOr(local.selectedLines))
        local.onRendered?.()
      },
    })
  }

  onMount(() => {
    if (isServer) return

    onCleanup(observeViewerScheme(() => Option.some(fileDiffRef)))

    const virtualizer = getVirtualizer()
    const annotations = local.annotations ?? local.preloadedDiff.annotations ?? []
    fileDiffInstance = Option.match(virtualizer, {
      onNone: (): FileDiff<T> =>
        new FileDiff<T>(
          {
            ...createDefaultOptions(props.diffStyle),
            ...others,
            ...local.preloadedDiff.options,
          },
          workerPool,
        ),
      onSome: (value) =>
        new VirtualizedFileDiff<T>(
          {
            ...createDefaultOptions(props.diffStyle),
            ...others,
            ...local.preloadedDiff.options,
          },
          value,
          virtualMetrics,
          workerPool,
        ),
    })

    applyViewerScheme(Option.some(fileDiffRef))

    // @ts-expect-error private field required for hydration
    fileDiffInstance.fileContainer = fileDiffRef
    fileDiffInstance.hydrate(
      local.fileDiff
        ? {
            fileDiff: local.fileDiff,
            lineAnnotations: annotations,
            fileContainer: fileDiffRef,
            containerWrapper: container,
            prerenderedHTML: local.preloadedDiff.prerenderedHTML,
          }
        : {
            oldFile: local.before
              ? { ...local.before, contents: typeof local.before.contents === "string" ? local.before.contents : "" }
              : local.before,
            newFile: local.after
              ? { ...local.after, contents: typeof local.after.contents === "string" ? local.after.contents : "" }
              : local.after,
            lineAnnotations: annotations,
            fileContainer: fileDiffRef,
            containerWrapper: container,
            prerenderedHTML: local.preloadedDiff.prerenderedHTML,
          },
    )

    notifyRendered()
  })

  createEffect(() => {
    const diff = fileDiffInstance
    if (!diff) return
    diff.setLineAnnotations(local.annotations ?? [])
    diff.rerender()
  })

  createEffect(() => {
    setSelectedLines(Option.fromNullishOr(local.selectedLines))
  })

  createEffect(() => {
    const ranges = local.commentedLines ?? []
    requestAnimationFrame(() => {
      const root = getRoot()
      if (Option.isNone(root)) return
      markCommentedDiffLines(root.value, ranges)
    })
  })

  onCleanup(() => {
    clearReadyWatcher(ready)
    fileDiffInstance?.cleanUp()
    if (Option.isSome(sharedVirtualizer)) sharedVirtualizer.value.release()
    sharedVirtualizer = Option.none()
  })

  return (
    <div
      data-component="file"
      data-mode="diff"
      style={styleVariables}
      class={local.class}
      classList={local.classList}
      ref={container}
    >
      <Dynamic component={DIFFS_TAG_NAME} ref={fileDiffRef} id="ssr-diff">
        <Show when={isServer}>
          <template shadowrootmode="open" innerHTML={local.preloadedDiff.prerenderedHTML} />
        </Show>
      </Dynamic>
    </div>
  )
}

export type FileSSRProps<T = {}> = FileProps<T>

function hasPreloadedDiff<T>(props: DiffFileProps<T>): props is SSRDiffFileProps<T> {
  return props.preloadedDiff !== undefined
}

export function FileSSR<T>(props: FileSSRProps<T>) {
  if (props.mode !== "diff" || !hasPreloadedDiff(props)) return File(props)
  return DiffSSRViewer(props)
}

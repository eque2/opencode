/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import {
  TextAttributes,
  type BorderSides,
  type BoxRenderable,
  type DiffRenderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { Array as Arr, Equal, HashSet, MutableHashMap, Option, Order } from "effect"
import { LANGUAGE_EXTENSIONS } from "../../util/filetype"
import { useBindings, useCommandShortcut } from "../../keymap"
import { useTheme } from "../../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { DiffViewerFileTree } from "./diff-viewer-file-tree"
import { Panel, PanelGroup, Separator, type SeparatorEdge } from "./diff-viewer-ui"
import { DialogSelect } from "../../ui/dialog-select"
import { getScrollAcceleration } from "../../util/scroll"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  type FileTreeRow,
  flattenFileTree,
  moveFileTreeSelection,
  moveFileTreeSelectionToFirstChild,
  moveFileTreeSelectionToParent,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  setFileTreeDirectoryExpanded,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  toggleFileTreeDirectory,
} from "./diff-viewer-file-tree-utils"

const ROUTE = "diff"
const MIN_SPLIT_WIDTH = 100
const FILE_TREE_WIDTH = 32
const PLAIN_TEXT_FILETYPE = "opencode-plain-text"
const VCS_DIFF_CONTEXT_LINES = 12
const KV_SHOW_FILE_TREE = "diff_viewer_show_file_tree"
const KV_SINGLE_PATCH = "diff_viewer_single_patch"
const KV_VIEW = "diff_viewer_view"
type DiffMode = "git" | "branch" | "last-turn"
type DiffViewerFocus = "patches" | "files"
type DiffView = "split" | "unified"
type SelectedHunk = { readonly fileIndex: number; readonly hunkIndex: number; readonly scrollTop: number }
type DiffRouteParams = {
  readonly mode?: DiffMode
  readonly sessionID?: string
  readonly messageID?: string
  readonly returnRoute?: TuiRouteCurrent
}

// Option values are new objects on every set. Compare them by value, so an unchanged value does not notify,
// as it did not when the signals held plain numbers and strings.
const byValue = { equals: Equal.equals }

const byContentY = Order.mapInput(Order.Number, (item: { readonly contentY: number }) => item.contentY)

type DiffFile = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

const normalizeDiffs = (diffs: readonly (VcsFileDiff | SnapshotFileDiff)[]): DiffFile[] =>
  diffs.flatMap((item) =>
    item.file
      ? [
          {
            file: item.file,
            patch: item.patch,
            additions: item.additions,
            deletions: item.deletions,
            status: item.status ?? "modified",
          } satisfies DiffFile,
        ]
      : [],
  )

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function storedView(value: unknown): Option.Option<DiffView> {
  return value === "split" || value === "unified" ? Option.some(value) : Option.none()
}

// A stored boolean setting, or the fallback when the key is absent or holds another kind of value.
function storedFlag(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function diffSourceLabel(mode: DiffMode) {
  if (mode === "last-turn") return "last turn"
  if (mode === "branch") return "main branch"
  return "working tree"
}

function DiffViewer(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const themeState = useTheme()
  const theme = () => props.api.theme.current
  const params = (): DiffRouteParams =>
    "params" in props.api.route.current ? ((props.api.route.current.params as DiffRouteParams | undefined) ?? {}) : {}
  const mode = () => params().mode ?? "git"
  const diffInput = createMemo(() => {
    const sessionID = params().sessionID
    return {
      mode: mode(),
      sessionID,
      messageID: params().messageID,
      directory: Option.fromNullishOr(sessionID).pipe(
        Option.filter((id) => id !== ""),
        Option.flatMapNullishOr((id) => props.api.state.session.get(id)?.directory),
      ),
    }
  })
  const [diff] = createResource(diffInput, async (input) => {
    if (input.mode === "last-turn") {
      const sessionID = input.sessionID
      if (!sessionID) return []
      const result = await props.api.client.session.diff(
        { sessionID, messageID: input.messageID },
        { throwOnError: true },
      )
      return normalizeDiffs(result.data ?? [])
    }

    const result = await props.api.client.vcs.diff(
      {
        ...Option.match(input.directory, { onNone: () => ({}), onSome: (directory) => ({ directory }) }),
        mode: input.mode,
        context: VCS_DIFF_CONTEXT_LINES,
      },
      { throwOnError: true },
    )
    return normalizeDiffs(result.data ?? [])
  })
  const files = createMemo(() => diff() ?? [])
  const [focus, setFocus] = createSignal<DiffViewerFocus>("patches")
  const [fileTreeEnabled, setFileTreeEnabled] = createSignal(storedFlag(props.api.kv.get(KV_SHOW_FILE_TREE), true))
  const showFileTree = createMemo(() => showDiffViewerFileTree(fileTreeEnabled(), files().length))
  const [singlePatch, setSinglePatch] = createSignal(storedFlag(props.api.kv.get(KV_SINGLE_PATCH), false))
  const patchPaneWidth = createMemo(() => dimensions().width - (showFileTree() ? 33 : 0) - 4)
  const patchLeftBorder = createMemo<BorderSides[]>(() => (showFileTree() ? ["left"] : []))
  const splitAvailable = createMemo(() => patchPaneWidth() >= MIN_SPLIT_WIDTH)
  const defaultView = createMemo(() => {
    if (props.api.tuiConfig.diff_style === "stacked") return "unified"
    return splitAvailable() ? "split" : "unified"
  })
  const [viewOverride, setViewOverride] = createSignal(storedView(props.api.kv.get(KV_VIEW)), byValue)
  const view = createMemo(() => (splitAvailable() ? Option.getOrElse(viewOverride(), defaultView) : "unified"))
  const fileTree = createMemo(() => buildFileTree(files()))
  const [expandedFileNodes, setExpandedFileNodes] = createSignal(HashSet.empty<number>())
  const [highlightedFileNode, setHighlightedFileNode] = createSignal(Option.none<number>(), byValue)
  const [lastHighlightedFileNode, setLastHighlightedFileNode] = createSignal(Option.none<number>(), byValue)
  const [activePatchFileIndex, setActivePatchFileIndex] = createSignal(Option.none<number>(), byValue)
  const [selectedFileIndex, setSelectedFileIndex] = createSignal(Option.none<number>(), byValue)
  const [reviewedFileNames, setReviewedFileNames] = createSignal(HashSet.empty<string>())
  const patchScrollAcceleration = createMemo(() => getScrollAcceleration(props.api.tuiConfig))
  const fileRows = createMemo(() => flattenFileTree(fileTree(), expandedFileNodes()))
  const patchFileIndexes = createMemo(() => orderedPatchFileIndexes(flattenFileTree(fileTree())))
  const focusRunner = (input: Record<DiffViewerFocus, () => void>) => () => input[focus()]()
  const switchFocusShortcut = useCommandShortcut("diff.switch_focus")
  const nextHunkShortcut = useCommandShortcut("diff.next_hunk")
  const previousHunkShortcut = useCommandShortcut("diff.previous_hunk")
  const nextFileShortcut = useCommandShortcut("diff.next_file")
  const previousFileShortcut = useCommandShortcut("diff.previous_file")
  const switchSourceShortcut = useCommandShortcut("diff.switch_source")
  const markReviewedShortcut = useCommandShortcut("diff.mark_reviewed")
  const helpShortcut = useCommandShortcut("diff.help")
  let scroll: ScrollBoxRenderable | undefined
  const patchNodeByFileIndex = MutableHashMap.empty<number, BoxRenderable>()
  const diffNodeByFileIndex = MutableHashMap.empty<number, DiffRenderable>()
  const [selectedHunk, setSelectedHunk] = createSignal(Option.none<SelectedHunk>())
  const [pendingPatchScrollFileIndex, setPendingPatchScrollFileIndex] = createSignal(Option.none<number>(), byValue)
  const [patchFillerHeight, setPatchFillerHeight] = createSignal(0)

  onCleanup(() => props.api.ui.dialog.clear())

  createEffect(() => {
    setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
    setHighlightedFileNode(Option.none())
    setLastHighlightedFileNode(Option.none())
    setActivePatchFileIndex(Option.none())
    setSelectedFileIndex(Option.none())
    setSelectedHunk(Option.none())
    setReviewedFileNames(HashSet.empty())
  })

  const highlightedRow = () =>
    Option.flatMap(highlightedFileNode(), (node) => Arr.findFirst(fileRows(), (row) => row.id === node))

  const ensureHighlightedFileNode = () => {
    const visible = (node: number) => fileRows().some((row) => row.id === node)
    if (Option.exists(highlightedFileNode(), visible)) return
    setHighlightedFileNode(
      Option.filter(lastHighlightedFileNode(), visible).pipe(
        Option.orElse(() =>
          Option.map(
            Arr.findFirst(fileRows(), (row) => row.fileIndex !== undefined),
            (row) => row.id,
          ),
        ),
      ),
    )
  }

  const setHighlighted = (node: Option.Option<number>) => {
    setHighlightedFileNode(node)
    if (Option.isSome(node)) setLastHighlightedFileNode(node)
  }

  const moveFileSelection = (offset: number) =>
    setHighlighted(moveFileTreeSelection(fileRows(), highlightedFileNode(), offset))

  const clearFileTreePatchState = () => {
    setHighlightedFileNode(Option.none())
    setActivePatchFileIndex(Option.none())
    setSelectedHunk(Option.none())
  }

  const scrollPatchNodeToTop = (patchNode: BoxRenderable) => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const scrollDelta = patchNode.y - scroll.viewport.y
      const contentY = scroll.scrollTop + scrollDelta
      const offset = contentY === 0 ? 0 : 1
      scroll.scrollBy(scrollDelta + offset)
    })
  }

  const revealFileTreeFile = (fileIndex: number) => {
    const selection = fileTreeFileSelection(fileTree(), fileIndex)
    if (Option.isNone(selection)) return
    const { expandedNodes, highlightedNode } = selection.value
    setExpandedFileNodes((expanded) => HashSet.union(expanded, HashSet.fromIterable(expandedNodes)))
    setHighlighted(Option.some(highlightedNode))
  }

  const selectPatchFile = (fileIndex: number) => {
    revealFileTreeFile(fileIndex)
    setActivePatchFileIndex(Option.some(fileIndex))
    setSelectedFileIndex(Option.some(fileIndex))
  }

  const scrollToPatchNode = (fileIndex: number) => {
    const patchNode = MutableHashMap.get(patchNodeByFileIndex, fileIndex)
    if (Option.isSome(patchNode)) scrollPatchNodeToTop(patchNode.value)
  }

  const scrollToFileIndex = (fileIndex: number) => {
    selectPatchFile(fileIndex)
    scrollToPatchNode(fileIndex)
  }

  const jumpToFileIndex = (fileIndex: number) => {
    setSelectedHunk(Option.none())
    scrollToFileIndex(fileIndex)
  }

  const currentPatchFileIndex = (): Option.Option<number> => {
    const patchScroll = scroll
    if (!patchScroll) return Option.none()
    const viewportContentY = patchScroll.scrollTop + 1
    const entries = Arr.sort(
      patchFileIndexes().flatMap((fileIndex) =>
        Option.toArray(
          Option.map(MutableHashMap.get(patchNodeByFileIndex, fileIndex), (node) => ({
            fileIndex,
            contentY: patchScroll.scrollTop + node.y - patchScroll.viewport.y,
          })),
        ),
      ),
      byContentY,
    )
    return Arr.findLast(entries, (entry) => entry.contentY <= viewportContentY).pipe(
      Option.orElse(() => Arr.head(entries)),
      Option.map((entry) => entry.fileIndex),
    )
  }

  const jumpRelativePatchFile = (offset: number) => {
    setSelectedHunk(Option.none())
    const next = movePatchFileIndex(
      patchFileIndexes(),
      Option.orElse(selectedFileIndex(), activePatchFileIndex),
      offset,
    )
    if (Option.isNone(next)) return
    if (singlePatch()) {
      selectPatchFile(next.value)
      scrollSinglePatchToTop()
      return
    }
    scrollToFileIndex(next.value)
  }

  const jumpRelativeHunk = (offset: -1 | 1) => {
    const patchScroll = scroll
    if (!patchScroll) return
    const hunks = Arr.sort(
      visiblePatchFiles().flatMap((entry) => {
        const node = MutableHashMap.get(diffNodeByFileIndex, entry.fileIndex)
        if (Option.isNone(node) || node.value.isDestroyed) return []
        const contentY = patchScroll.scrollTop + node.value.y - patchScroll.viewport.y
        return node.value.diff
          .split("\n")
          .flatMap((line, row) => (line.startsWith("@@") ? [row] : []))
          .map((row, hunkIndex) => ({
            fileIndex: entry.fileIndex,
            hunkIndex,
            contentY: contentY + row,
          }))
      }),
      byContentY,
    )
    const selectedIndex = selectedHunk().pipe(
      Option.filter((selected) => selected.scrollTop === patchScroll.scrollTop),
      Option.flatMap((selected) =>
        Arr.findFirstIndex(
          hunks,
          (hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex,
        ),
      ),
    )
    const next = Option.match(selectedIndex, {
      onSome: (index) => Arr.get(hunks, index + offset),
      onNone: () =>
        offset === 1
          ? Arr.findFirst(hunks, (hunk) => hunk.contentY > patchScroll.scrollTop)
          : Arr.findLast(hunks, (hunk) => hunk.contentY < patchScroll.scrollTop),
    })
    if (Option.isNone(next)) return
    const hunk = next.value
    selectPatchFile(hunk.fileIndex)
    patchScroll.scrollTo(hunk.contentY)
    setSelectedHunk(
      Option.some({ fileIndex: hunk.fileIndex, hunkIndex: hunk.hunkIndex, scrollTop: patchScroll.scrollTop }),
    )
  }

  const firstPatchFileIndex = () =>
    Arr.findFirst(fileRows(), (row) => row.fileIndex !== undefined).pipe(
      Option.flatMapNullishOr((row) => row.fileIndex),
    )
  const patchEntry = (fileIndex: number) => Option.map(Arr.get(files(), fileIndex), (file) => ({ file, fileIndex }))
  const visiblePatchFiles = createMemo(() => {
    if (!singlePatch()) {
      return patchFileIndexes().flatMap((fileIndex) => Option.toArray(patchEntry(fileIndex)))
    }
    const fileIndex = singlePatchFileIndex(
      selectedFileIndex(),
      activePatchFileIndex(),
      currentPatchFileIndex(),
      firstPatchFileIndex(),
    )
    return Option.toArray(Option.flatMap(fileIndex, patchEntry))
  })

  const ensureHighlightedPatchFile = () => {
    const fileIndex = currentPatchFileIndex().pipe(
      Option.orElse(activePatchFileIndex),
      Option.orElse(firstPatchFileIndex),
    )
    if (Option.isSome(fileIndex)) selectPatchFile(fileIndex.value)
  }

  const scrollToPatchFileIndexAfterRender = (fileIndex: number) => {
    setPendingPatchScrollFileIndex(Option.some(fileIndex))
    requestAnimationFrame(() => {
      scrollToPatchNode(fileIndex)
      requestAnimationFrame(() => {
        scrollToPatchNode(fileIndex)
        setPendingPatchScrollFileIndex(Option.none())
      })
    })
  }

  const scrollSinglePatchToTop = () => {
    requestAnimationFrame(() => {
      scroll?.scrollTo(0)
      requestAnimationFrame(() => scroll?.scrollTo(0))
    })
  }

  const measurePatchFiller = () => {
    requestAnimationFrame(() => {
      if (!scroll) return
      const entries = visiblePatchFiles().flatMap((entry) =>
        Option.toArray(MutableHashMap.get(patchNodeByFileIndex, entry.fileIndex)),
      )
      if (entries.length === 0) {
        setPatchFillerHeight(0)
        return
      }
      const contentHeight = Math.max(
        ...entries.map((node) => scroll!.scrollTop + node.y - scroll!.viewport.y + node.height),
      )
      setPatchFillerHeight(Math.max(0, scroll.viewport.height - contentHeight))
    })
  }

  const registerPatchNode = (fileIndex: number, element: BoxRenderable) => {
    MutableHashMap.set(patchNodeByFileIndex, fileIndex, element)
    measurePatchFiller()
    if (!Option.contains(pendingPatchScrollFileIndex(), fileIndex)) return
    requestAnimationFrame(() => {
      scrollPatchNodeToTop(element)
      requestAnimationFrame(() => {
        scrollPatchNodeToTop(element)
        setPendingPatchScrollFileIndex(Option.none())
      })
    })
  }

  createEffect(() => {
    visiblePatchFiles()
    dimensions()
    view()
    measurePatchFiller()
  })

  const toggleSelectedFileTreeRow = () => {
    const fileIndex = Option.flatMapNullishOr(highlightedRow(), (row) => row.fileIndex)
    if (Option.isSome(fileIndex)) {
      jumpToFileIndex(fileIndex.value)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, highlightedFileNode()))
  }

  const clickFileTreeRow = (row: FileTreeRow) => {
    setFocus("files")
    setHighlighted(Option.some(row.id))
    if (row.fileIndex !== undefined) {
      jumpToFileIndex(row.fileIndex)
      return
    }
    setExpandedFileNodes((expanded) => toggleFileTreeDirectory(fileTree(), expanded, Option.some(row.id)))
  }

  const toggleSelectedFileReviewed = () => {
    const fileIndex =
      focus() === "files"
        ? Option.flatMapNullishOr(highlightedRow(), (row) => row.fileIndex)
        : selectedFileIndex().pipe(Option.orElse(activePatchFileIndex), Option.orElse(currentPatchFileIndex))
    const file = Option.flatMap(fileIndex, (index) => Arr.get(files(), index))
    if (Option.isNone(file)) return
    const name = file.value.file
    setReviewedFileNames((reviewed) =>
      HashSet.has(reviewed, name) ? HashSet.remove(reviewed, name) : HashSet.add(reviewed, name),
    )
  }

  const commands = [
    {
      name: "diff.close",
      title: "Close diff viewer",
      category: "VCS",
      run() {
        const returnRoute = Option.fromNullishOr(params().returnRoute)
        props.api.ui.dialog.clear()

        Option.match(returnRoute, {
          onNone: () => props.api.route.navigate("home"),
          onSome: (route) =>
            "params" in route
              ? props.api.route.navigate(route.name, route.params)
              : props.api.route.navigate(route.name),
        })
      },
    },
    {
      name: "diff.down",
      title: "Move diff viewer down",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(1)
        },
        patches() {
          clearFileTreePatchState()
          scroll?.scrollBy(1)
        },
      }),
    },
    {
      name: "diff.up",
      title: "Move diff viewer up",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-1)
        },
        patches() {
          clearFileTreePatchState()
          scroll?.scrollBy(-1)
        },
      }),
    },
    {
      name: "diff.page.down",
      title: "Page diff viewer down",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(8)
        },
        patches() {
          clearFileTreePatchState()
          if (scroll) scroll.scrollBy(scroll.height)
        },
      }),
    },
    {
      name: "diff.page.up",
      title: "Page diff viewer up",
      category: "VCS",
      run: focusRunner({
        files() {
          moveFileSelection(-8)
        },
        patches() {
          clearFileTreePatchState()
          if (scroll) scroll.scrollBy(-scroll.height)
        },
      }),
    },
    {
      name: "diff.toggle",
      title: "Toggle diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          toggleSelectedFileTreeRow()
        },
        patches() {},
      }),
    },
    {
      name: "diff.expand",
      title: "Expand diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          if (Option.exists(highlighted, (node) => HashSet.has(expandedFileNodes(), node))) {
            setHighlighted(moveFileTreeSelectionToFirstChild(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), true),
          )
        },
        patches() {},
      }),
    },
    {
      name: "diff.expand_all",
      title: "Expand all diff viewer folders",
      category: "VCS",
      run: focusRunner({
        files() {
          setExpandedFileNodes(allExpandedFileTreeDirectories(fileTree()))
        },
        patches() {},
      }),
    },
    {
      name: "diff.collapse",
      title: "Collapse diff viewer item",
      category: "VCS",
      run: focusRunner({
        files() {
          const highlighted = highlightedFileNode()
          const expandedDirectory = highlighted.pipe(
            Option.flatMap((node) => Arr.get(fileTree().nodes, node)),
            Option.exists((node) => node.kind === "directory" && HashSet.has(expandedFileNodes(), node.id)),
          )
          if (!expandedDirectory) {
            setHighlighted(moveFileTreeSelectionToParent(fileRows(), highlighted))
            return
          }
          setExpandedFileNodes((expanded) =>
            setFileTreeDirectoryExpanded(fileTree(), expanded, highlightedFileNode(), false),
          )
        },
        patches() {},
      }),
    },
    {
      name: "diff.next_hunk",
      title: "Jump to next diff hunk",
      category: "VCS",
      run() {
        jumpRelativeHunk(1)
      },
    },
    {
      name: "diff.previous_hunk",
      title: "Jump to previous diff hunk",
      category: "VCS",
      run() {
        jumpRelativeHunk(-1)
      },
    },
    {
      name: "diff.next_file",
      title: "Jump to next diff file",
      category: "VCS",
      run() {
        jumpRelativePatchFile(1)
      },
    },
    {
      name: "diff.previous_file",
      title: "Jump to previous diff file",
      category: "VCS",
      run() {
        jumpRelativePatchFile(-1)
      },
    },
    {
      name: "diff.mark_reviewed",
      title: "Toggle selected diff file reviewed",
      category: "VCS",
      run() {
        toggleSelectedFileReviewed()
      },
    },
    {
      name: "diff.switch_focus",
      title: "Switch diff viewer focus",
      category: "VCS",
      run() {
        if (!showFileTree()) return
        setFocus((current) => {
          if (current === "files") return "patches"
          ensureHighlightedFileNode()
          return "files"
        })
      },
    },
    {
      name: "diff.toggle_file_tree",
      title: "Toggle diff viewer file tree",
      category: "VCS",
      run() {
        const next = !fileTreeEnabled()
        if (!next) setFocus("patches")
        setFileTreeEnabled(next)
        props.api.kv.set(KV_SHOW_FILE_TREE, next)
      },
    },
    {
      name: "diff.single_patch",
      title: "Toggle single patch view",
      category: "VCS",
      run() {
        setSelectedHunk(Option.none())
        if (!singlePatch()) {
          ensureHighlightedPatchFile()
          setSinglePatch(true)
          props.api.kv.set(KV_SINGLE_PATCH, true)
          scrollSinglePatchToTop()
          return
        }
        const fileIndex = Arr.head(visiblePatchFiles()).pipe(
          Option.map((entry) => entry.fileIndex),
          Option.orElse(() =>
            singlePatchFileIndex(
              selectedFileIndex(),
              activePatchFileIndex(),
              currentPatchFileIndex(),
              firstPatchFileIndex(),
            ),
          ),
        )
        if (Option.isSome(fileIndex)) selectPatchFile(fileIndex.value)
        setSinglePatch(false)
        props.api.kv.set(KV_SINGLE_PATCH, false)
        if (Option.isSome(fileIndex)) scrollToPatchFileIndexAfterRender(fileIndex.value)
      },
    },
    {
      name: "diff.switch_source",
      title: "Switch diff viewer source",
      category: "VCS",
      run() {
        openSwitchDiffDialog()
      },
    },
    {
      name: "diff.toggle_view",
      title: "Toggle diff viewer split or unified view",
      category: "VCS",
      run() {
        if (!splitAvailable()) return
        setSelectedHunk(Option.none())
        const next = view() === "split" ? "unified" : "split"
        setViewOverride(Option.some(next))
        props.api.kv.set(KV_VIEW, next)
      },
    },
    {
      name: "diff.help",
      title: "Show more diff viewer shortcuts",
      category: "VCS",
      run() {
        openHelpDialog()
      },
    },
  ]

  const switchDiffOptions = createMemo(() => {
    const vcs = props.api.state.vcs
    return [
      {
        title: "Working tree",
        value: "git" as const,
        description: "Show current git changes",
      },
      ...(vcs?.branch && vcs.default_branch && vcs.branch !== vcs.default_branch
        ? [
            {
              title: "Main branch",
              value: "branch" as const,
              description: "Show changes compared to main branch",
            },
          ]
        : []),
      {
        title: "Last turn",
        value: "last-turn" as const,
        description: "Show changes from the last assistant turn",
      },
    ]
  })

  const openSwitchDiffDialog = () => {
    props.api.ui.dialog.replace(() => (
      <DialogSelect
        title="Switch source"
        skipFilter={true}
        renderFilter={false}
        current={mode()}
        options={switchDiffOptions().map((option) => ({
          ...option,
          onSelect(dialog) {
            dialog.clear()
            props.api.route.navigate(ROUTE, {
              mode: option.value,
              sessionID: params().sessionID,
              messageID: params().messageID,
              returnRoute: params().returnRoute,
            })
          },
        }))}
      />
    ))
  }

  const openHelpDialog = () => {
    props.api.ui.dialog.replace(() => <DiffViewerHelpDialog />)
    props.api.ui.dialog.setSize("large")
  }

  useBindings(() => ({
    commands,
    bindings: [
      { key: "j,down", cmd: "diff.down", desc: "Move diff viewer down" },
      { key: "k,up", cmd: "diff.up", desc: "Move diff viewer up" },
      { key: "pagedown,ctrl+f", cmd: "diff.page.down", desc: "Page diff viewer down" },
      { key: "pageup,ctrl+b", cmd: "diff.page.up", desc: "Page diff viewer up" },
      { key: "m", cmd: "diff.mark_reviewed", desc: "Mark selected file reviewed" },
      ...props.api.tuiConfig.keybinds.gather(
        "diff",
        commands.map((command) => command.name),
      ),
    ],
  }))

  return (
    <box position="absolute" zIndex={2500} left={0} top={0} width={dimensions().width} height={dimensions().height}>
      <PanelGroup axis="y" width="100%" height="100%">
        <Panel border="none" flexShrink={0} padding={0} paddingLeft={1}>
          <text fg={theme().text}>Diff </text>
          <text fg={theme().textMuted}>{diffSourceLabel(mode())}</text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>
            {files().length} {files().length === 1 ? "file" : "files"}
          </text>
        </Panel>

        <box flexGrow={1} minHeight={0}>
          <Switch>
            <Match when={diff.loading}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>Loading diff…</text>
              </box>
            </Match>
            <Match when={!diff.loading && files().length === 0}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().textMuted}>No diff!</text>
              </box>
            </Match>
            <Match when={!diff.loading && diff.error}>
              <Separator axis="x" />
              <box flexGrow={1} paddingLeft={1}>
                <text fg={theme().error}>Failed to load diff</text>
              </box>
            </Match>
            <Match when={!diff.loading}>
              <PanelGroup axis="x">
                <Show when={showFileTree()}>
                  <DiffViewerFileTree
                    files={files()}
                    loading={diff.loading}
                    error={diff.error}
                    theme={theme()}
                    focused={focus() === "files"}
                    width={FILE_TREE_WIDTH}
                    highlightedNode={highlightedFileNode()}
                    selectedFileIndex={selectedFileIndex()}
                    reviewedFileNames={reviewedFileNames()}
                    expandedNodes={expandedFileNodes()}
                    onRowClick={clickFileTreeRow}
                  />
                </Show>

                <Panel flexGrow={1} minHeight={0} border="none">
                  <PatchSeparator edge="edge-out" fileTree={showFileTree()} />
                  <scrollbox
                    ref={(element: ScrollBoxRenderable) => (scroll = element)}
                    flexGrow={1}
                    minHeight={0}
                    scrollAcceleration={patchScrollAcceleration()}
                    verticalScrollbarOptions={{ visible: false }}
                    horizontalScrollbarOptions={{ visible: false }}
                  >
                    <For each={visiblePatchFiles()}>
                      {(entry, index) => {
                        const reviewed = () => HashSet.has(reviewedFileNames(), entry.file.file)
                        return (
                          <box ref={(element: BoxRenderable) => registerPatchNode(entry.fileIndex, element)}>
                            {index() !== 0 ? <PatchSeparator edge="edge" fileTree={showFileTree()} /> : null}
                            <box
                              flexDirection="row"
                              gap={1}
                              flexShrink={0}
                              paddingLeft={1}
                              paddingRight={1}
                              border={patchLeftBorder()}
                              borderColor={theme().border}
                            >
                              <text fg={reviewed() ? theme().textMuted : theme().text}>{entry.file.file}</text>
                              <box flexGrow={1} />
                              <text fg={reviewed() ? theme().textMuted : theme().diffAdded}>
                                +{entry.file.additions}
                              </text>
                              <text fg={reviewed() ? theme().textMuted : theme().diffRemoved}>
                                -{entry.file.deletions}
                              </text>
                            </box>
                            <PatchSeparator edge="edge" fileTree={showFileTree()} />
                            <Show
                              when={entry.file.patch}
                              fallback={<text fg={theme().textMuted}>No patch available for this file.</text>}
                            >
                              {(patch) => (
                                <box border={patchLeftBorder()} borderColor={theme().border}>
                                  <diff
                                    ref={(element: DiffRenderable) =>
                                      MutableHashMap.set(diffNodeByFileIndex, entry.fileIndex, element)
                                    }
                                    diff={patch()}
                                    view={view()}
                                    filetype={reviewed() ? PLAIN_TEXT_FILETYPE : filetype(entry.file.file)}
                                    syntaxStyle={themeState.syntax()}
                                    showLineNumbers={true}
                                    width="100%"
                                    wrapMode="char"
                                    fg={reviewed() ? theme().textMuted : theme().text}
                                    addedBg={reviewed() ? theme().backgroundElement : theme().diffAddedBg}
                                    removedBg={reviewed() ? theme().backgroundElement : theme().diffRemovedBg}
                                    addedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightAdded}
                                    removedSignColor={reviewed() ? theme().textMuted : theme().diffHighlightRemoved}
                                    lineNumberFg={theme().diffLineNumber}
                                    addedLineNumberBg={
                                      reviewed() ? theme().backgroundElement : theme().diffAddedLineNumberBg
                                    }
                                    removedLineNumberBg={
                                      reviewed() ? theme().backgroundElement : theme().diffRemovedLineNumberBg
                                    }
                                  />
                                </box>
                              )}
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                    <Show when={patchFillerHeight() > 0}>
                      <box height={patchFillerHeight()} border={patchLeftBorder()} borderColor={theme().border} />
                    </Show>
                  </scrollbox>
                  <PatchSeparator edge="edge-in" fileTree={showFileTree()} />
                </Panel>
              </PanelGroup>
            </Match>
          </Switch>
        </box>

        <Panel flexShrink={0} gap={2} paddingLeft={1} border="none">
          <Show when={switchFocusShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>focus file tree</span>
              </text>
            )}
          </Show>
          <Show when={nextFileShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>next file</span>
              </text>
            )}
          </Show>
          <Show when={nextHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>next hunk</span>
              </text>
            )}
          </Show>
          <Show when={previousHunkShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>previous hunk</span>
              </text>
            )}
          </Show>
          <Show when={previousFileShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>previous file</span>
              </text>
            )}
          </Show>
          <Show when={switchSourceShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>switch source</span>
              </text>
            )}
          </Show>
          <Show when={markReviewedShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>mark reviewed</span>
              </text>
            )}
          </Show>
          <Show when={helpShortcut()}>
            {(shortcut) => (
              <text fg={theme().text}>
                {shortcut()} <span style={{ fg: theme().textMuted }}>all</span>
              </text>
            )}
          </Show>
        </Panel>
      </PanelGroup>
    </box>
  )
}

// A horizontal separator that joins the file tree border with the given edge while the file tree shows.
function PatchSeparator(props: { readonly edge: SeparatorEdge; readonly fileTree: boolean }) {
  return (
    <Show when={props.fileTree} fallback={<Separator axis="x" />}>
      <Separator axis="x" start={props.edge} />
    </Show>
  )
}

function DiffViewerHelpDialog() {
  const { theme } = useTheme()
  const rows = [
    {
      shortcut: () => "q",
      action: "Close viewer",
      description: "Quit the diff viewer",
    },
    {
      shortcut: useCommandShortcut("diff.switch_focus"),
      action: "Focus file tree",
      description: "Move keyboard focus between the file tree and patch pane",
    },
    {
      shortcut: useCommandShortcut("diff.next_hunk"),
      action: "Next hunk",
      description: "Jump to the next diff hunk",
    },
    {
      shortcut: useCommandShortcut("diff.previous_hunk"),
      action: "Previous hunk",
      description: "Jump to the previous diff hunk",
    },
    {
      shortcut: useCommandShortcut("diff.next_file"),
      action: "Next file",
      description: "Select the next changed file in file-tree order",
    },
    {
      shortcut: useCommandShortcut("diff.previous_file"),
      action: "Previous file",
      description: "Select the previous changed file in file-tree order",
    },
    {
      shortcut: useCommandShortcut("diff.toggle_file_tree"),
      action: "Toggle file tree",
      description: "Show or hide the file tree sidebar",
    },
    {
      shortcut: useCommandShortcut("diff.single_patch"),
      action: "Toggle patches",
      description: "Switch between one selected patch and all patches",
    },
    {
      shortcut: useCommandShortcut("diff.switch_source"),
      action: "Switch source",
      description: "Choose working tree, main branch, or last-turn changes",
    },
    {
      shortcut: useCommandShortcut("diff.toggle_view"),
      action: "Toggle view",
      description: "Switch between split and unified diff layout",
    },
    {
      shortcut: useCommandShortcut("diff.expand_all"),
      action: "Expand all folders",
      description: "Open every folder in the file tree",
    },
    {
      shortcut: useCommandShortcut("diff.mark_reviewed"),
      action: "Mark reviewed",
      description: "Toggle reviewed state for the selected file",
    },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Diff shortcuts
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <box flexDirection="row">
        <text fg={theme.textMuted} width={5} wrapMode="none">
          Key
        </text>
        <text fg={theme.textMuted} width={22} wrapMode="none">
          Action
        </text>
        <text fg={theme.textMuted}>Description</text>
      </box>
      <For each={rows}>
        {(row) => (
          <box flexDirection="row">
            <text fg={theme.text} width={5} wrapMode="none">
              {row.shortcut() || "-"}
            </text>
            <text fg={theme.text} width={22} wrapMode="none">
              {row.action}
            </text>
            <text fg={theme.textMuted}>{row.description}</text>
          </box>
        )}
      </For>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: () => <DiffViewer api={api} />,
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "diff.open",
        title: "Open diff viewer",
        slashName: "diff",
        category: "VCS",
        namespace: "palette",
        run() {
          const current = api.route.current
          api.route.navigate(ROUTE, {
            mode: "git",
            ...("params" in current ? { sessionID: current.params?.sessionID } : {}),
            returnRoute: current,
          })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

export default {
  id: "diff-viewer",
  tui,
}

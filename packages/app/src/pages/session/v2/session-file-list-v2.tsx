import { FileIcon } from "@opencode-ai/ui/file-icon"
import "@opencode-ai/ui/v2/file-tree-v2.css"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { Array as Arr, HashMap, Option } from "effect"
import { kindChange, kindLabel, type Kind } from "@/components/file-tree-v2"
import { normalizePath } from "@/pages/session/v2/review-diff-kinds"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { virtualScrollElement } from "@/components/virtual-scroll-element"

// Drives the highlight/selection of the flat search-result list from the filter
// input's keyboard events.
export function applyFileListKeyDown(
  event: KeyboardEvent,
  files: readonly string[],
  highlighted: Option.Option<string>,
  options: { onHighlight: (path: string) => void; onSelect: (path: string) => void },
) {
  if (files.length === 0) return

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const currentIndex = Option.match(highlighted, { onNone: () => -1, onSome: (path) => files.indexOf(path) })
    const delta = event.key === "ArrowDown" ? 1 : -1
    const start = currentIndex === -1 ? (delta > 0 ? 0 : files.length - 1) : currentIndex + delta
    const index = Math.max(0, Math.min(files.length - 1, start))
    options.onHighlight(files[index])
    event.preventDefault()
    return
  }

  if (event.key !== "Enter") return
  const target = Option.orElse(highlighted, () => Arr.head(files))
  if (Option.isNone(target) || !target.value) return
  options.onSelect(target.value)
  event.preventDefault()
}

// Flat variant of FileTreeV2 for filtered results: reuses its data-component and
// row data-slots on purpose so file-tree-v2.css styles both. data-highlighted has
// no CSS of its own — it folds into data-selected below and only exists as the
// scrollIntoView query hook.
export function SessionFileListV2(props: {
  files: readonly string[]
  active?: string
  highlighted: Option.Option<string>
  kinds?: HashMap.HashMap<string, Kind>
  id?: string
  role?: "listbox"
  optionID?: (path: string) => string
  onFileClick: (path: string) => void
  onFileDoubleClick?: (path: string) => void
}) {
  const active = () => normalizePath(props.active ?? "")
  const highlighted = () => normalizePath(Option.getOrElse(props.highlighted, () => ""))
  const normalized = createMemo(() => props.files.map(normalizePath))
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [focused, setFocused] = createSignal(Option.none<string>())
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return props.files.length
    },
    getScrollElement: () => virtualScrollElement(root()),
    initialRect: { width: 0, height: 600 },
    estimateSize: () => 28,
    gap: 2,
    overscan: 10,
    get getItemKey() {
      const files = props.files
      return (index: number) => files[index] ?? index
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const index = Option.match(focused(), { onNone: () => -1, onSome: (path) => props.files.indexOf(path) })
      if (index < 0 || indexes.includes(index)) return indexes
      return [...indexes, index].sort((a, b) => a - b)
    },
  })

  createEffect(() => {
    const index = normalized().indexOf(highlighted())
    if (index < 0) return
    queueMicrotask(() => {
      if (virtualizer.range && index >= virtualizer.range.startIndex && index <= virtualizer.range.endIndex) return
      virtualizer.scrollToIndex(index, { align: "auto" })
    })
  })
  const virtualItemByKey = createMemo(() =>
    HashMap.fromIterable(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  // getItemKey returns the file path for every row in range.
  const virtualRowKeys = createMemo(() =>
    virtualizer.getVirtualItems().flatMap((item) => (typeof item.key === "string" ? [item.key] : [])),
  )

  return (
    <div
      ref={setRoot}
      id={props.id}
      role={props.role}
      data-component="file-tree-v2"
      data-total-rows={props.files.length}
      style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}
    >
      <For each={virtualRowKeys()}>
        {(path) => {
          const value = normalizePath(path)
          const selected = () => (highlighted() ? highlighted() === value : active() === value)
          const highlightedRow = () => highlighted() === value
          const kind = () => (props.kinds ? HashMap.get(props.kinds, value) : Option.none())
          const directory = () =>
            Option.map(
              Option.liftPredicate(value, (path) => path.includes("/")),
              getDirectory,
            )
          const filename = () => getFilename(value)
          return (
            <Show when={Option.getOrUndefined(HashMap.get(virtualItemByKey(), path))}>
              {(item) => (
                <div
                  style={{
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    height: `${item().size}px`,
                    transform: `translateY(${item().start}px)`,
                  }}
                >
                  <button
                    type="button"
                    id={props.optionID?.(path)}
                    {...(props.role ? { role: "option" as const, "aria-selected": selected() } : {})}
                    data-slot="file-tree-v2-row"
                    data-path={path}
                    bool:data-selected={selected()}
                    bool:data-highlighted={highlightedRow()}
                    style="padding-left: 8px"
                    onFocus={() => setFocused(Option.some(path))}
                    onBlur={() => setFocused(Option.none())}
                    onClick={() => props.onFileClick(path)}
                    onDblClick={() => props.onFileDoubleClick?.(path)}
                  >
                    <span class="filetree-iconpair size-4">
                      <FileIcon node={{ path, type: "file" }} class="size-4 filetree-icon filetree-icon--color" />
                      <FileIcon node={{ path, type: "file" }} class="size-4 filetree-icon filetree-icon--mono" mono />
                    </span>
                    <span class="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
                      <Show when={Option.getOrUndefined(directory())}>
                        {(value) => (
                          <span class="text-12-medium text-text-muted truncate min-w-0 shrink">{value()}</span>
                        )}
                      </Show>
                      <span class="text-12-medium text-text-base truncate min-w-0 shrink-0">{filename()}</span>
                    </span>
                    <Show when={Option.getOrUndefined(kind())}>
                      {(value) => (
                        <span data-slot="file-tree-v2-change" data-change={kindChange(value())}>
                          {kindLabel(value())}
                        </span>
                      )}
                    </Show>
                  </button>
                </div>
              )}
            </Show>
          )
        }}
      </For>
    </div>
  )
}

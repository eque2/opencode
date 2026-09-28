import "@pierre/trees/web-components"
import { FileTree } from "@pierre/trees"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Effect, MutableHashMap, MutableHashSet, Option } from "effect"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import type { Path } from "@opencode-ai/sdk/v2/client"
import {
  absoluteTreePath,
  activeTreeNavigation,
  advanceTreePreload,
  nextSuggestionIndex,
  nextTreeScrollTop,
  pickerFileSearchQuery,
  pickerAbsoluteInput,
  pickerMode,
  preloadTreeDirectories,
  cleanPickerInput,
  createPriorityTaskQueue,
  createDirectorySearch,
  currentPickerSuggestions,
  displayPickerPath,
  pickerParent,
  pickerPathOption,
  pickerRoot,
} from "./directory-picker-domain"
import "./dialog-select-directory-v2.css"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { getFilename } from "@opencode-ai/core/util/path"

type TreeListing = Option.Option<ReadonlyArray<{ name: string; type: "file" | "directory" }>>

/**
 * Runs a picker action in the background. A failure or defect goes to the
 * Effect logger, as an unhandled rejection went to the console before.
 */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

interface DialogSelectDirectoryV2Props {
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[]) => void
  server: ServerConnection.Any
  mode?: "directory" | "file"
  start?: string
}

export function DialogSelectDirectoryV2(props: DialogSelectDirectoryV2Props) {
  const global = useGlobal()
  const { sync, sdk } = global.ensureServerCtx(props.server)
  const dialog = useDialog()
  const language = useLanguage()
  const policy = pickerMode(props.mode ?? "directory", props.start)
  const action = {
    file: language.t("dialog.directory.action.selectFile"),
    directory: language.t("dialog.directory.action.selectFolder"),
  }
  const [root, setRoot] = createSignal("")
  const [input, setInput] = createSignal("")
  const [selected, setSelected] = createSignal("")
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false)
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [rootValid, setRootValid] = createSignal(false)
  const listings = MutableHashMap.empty<string, Effect.Effect<TreeListing>>()
  const loads = createPriorityTaskQueue<TreeListing>(3)
  const advanced = MutableHashSet.empty<string>()
  let tree: FileTree | undefined
  let container: HTMLDivElement | undefined
  let pathArea: HTMLDivElement | undefined
  let navigation = 0

  // A v1 server can leave the home and directory paths out of its sync data, so the dialog asks for them once.
  const loadFallbackPath = Effect.gen(function* () {
    const protocol = yield* Effect.promise(() => sdk.protocol)
    if (protocol !== "v1") return Option.none<Path>()
    return yield* Effect.tryPromise(() => sdk.client.path.get()).pipe(
      Effect.map((result) => Option.fromNullishOr(result.data)),
      Effect.orElseSucceed(() => Option.none<Path>()),
    )
  })

  // A false source skips the fetch, as an undefined source did.
  const missingBase = createMemo(() => !(sync.data.path.home || sync.data.path.directory))
  const [fallbackPath] = createResource(missingBase, () => Effect.runPromise(loadFallbackPath), {
    initialValue: Option.none<Path>(),
  })
  const fallback = (field: "home" | "directory") =>
    Option.match(fallbackPath(), { onNone: () => "", onSome: (path) => path[field] })
  const home = createMemo(() => sync.data.path.home || fallback("home"))
  const start = createMemo(
    () => props.start || sync.data.path.home || sync.data.path.directory || fallback("home") || fallback("directory"),
  )
  const search = createDirectorySearch({ sdk, home, base: () => pickerPathOption(root() || start()) })
  const loadSuggestions = (value: string) =>
    Effect.gen(function* () {
      const cleaned = cleanPickerInput(value)
      const typed = cleaned.replace(/\/+$/, "")
      const current = displayPickerPath(root(), value, home()).replace(/\/+$/, "")
      if (!cleaned || (root() && typed === current)) return { query: value, items: [] }
      const directories = (yield* search(value)).map((absolute) => ({ absolute, type: "directory" as const }))
      if (!policy.includeFiles) return { query: value, items: directories.slice(0, 5) }
      const base = pickerRoot(cleaned) || root() || start()
      if (!base) return { query: value, items: directories.slice(0, 5) }
      const files = yield* Effect.tryPromise(() =>
        sdk.api.file.find({
          location: { directory: base },
          query: pickerFileSearchQuery(base, value, home()),
          type: "file",
          limit: 20,
        }),
      ).pipe(
        Effect.map((result) => result.data),
        Effect.orElseSucceed(() => []),
      )
      const results = [
        ...directories,
        ...files.map((entry) => ({ absolute: absoluteTreePath(base, entry.path), type: "file" as const })),
      ]
      return {
        query: value,
        items: Array.from(
          MutableHashMap.values(
            MutableHashMap.fromIterable(results.map((result) => [result.absolute, result] as const)),
          ),
        ).slice(0, 8),
      }
    })
  const [suggestions] = createResource(input, (value) => Effect.runPromise(loadSuggestions(value)))
  const currentSuggestions = createMemo(() => currentPickerSuggestions(suggestions(), input()))

  // Lists one directory for the tree. A stale navigation or a failed request gives no listing.
  const listDirectory = (absolute: string, generation: number): Effect.Effect<TreeListing> =>
    Effect.suspend(() => {
      if (!activeTreeNavigation(generation, navigation)) return Effect.succeed(Option.none())
      return Effect.tryPromise(() => sdk.api.file.list({ location: { directory: absolute } })).pipe(
        Effect.map((result) =>
          Option.some(
            result.data.map((entry) => ({
              name: getFilename(entry.path.replace(/[\\/]+$/, "")),
              type: entry.type,
            })),
          ),
        ),
        Effect.orElseSucceed(() => Option.none()),
      )
    })

  const load = (path: string, generation: number, eager = false): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const key = path.replace(/\/+$/, "")
      setError(false)
      const absolute = absoluteTreePath(root(), key)
      const existing = MutableHashMap.get(listings, key)
      if (Option.isSome(existing) && !eager) loads.promote(`${generation}:${key}`)
      const request = Option.isSome(existing)
        ? existing.value
        : yield* loads.schedule(
            `${generation}:${key}`,
            eager ? "background" : "user",
            listDirectory(absolute, generation),
          )
      MutableHashMap.set(listings, key, request)
      const nodes = yield* request
      if (!activeTreeNavigation(generation, navigation)) return false
      if (Option.isNone(nodes)) {
        MutableHashMap.remove(listings, key)
        if (!key) setError(true)
        return false
      }
      tree?.batch(policy.entries(key, nodes.value).map((item) => ({ type: "add", path: item })))
      if (!eager && advanceTreePreload(advanced, key)) {
        // Each preload starts at once and runs on its own, as the fire-and-forget Promise call did.
        for (const directory of preloadTreeDirectories(key, nodes.value)) {
          yield* Effect.forkDetach(load(directory, generation, true), { startImmediately: true })
        }
      }
      return true
    })

  const navigate = (path: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const target = policy.navigation(pickerAbsoluteInput(cleanPickerInput(path), home(), root() || start() || home()))
      if (Option.isNone(target)) return
      const value = target.value
      const token = ++navigation
      setLoading(true)
      setRootValid(false)
      setSelected("")
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
      setRoot(value)
      setInput(displayPickerPath(value, value, home()))
      MutableHashMap.clear(listings)
      MutableHashSet.clear(advanced)
      tree?.resetPaths([])
      const valid = yield* load("", token)
      if (!activeTreeNavigation(token, navigation)) return
      setRootValid(valid)
      setLoading(false)
    })

  function complete() {
    const items = currentSuggestions()
    const match = items[activeSuggestion()] ?? items[0]
    if (!match) return
    const value = displayPickerPath(match.absolute, input(), home())
    setInput(match.type === "directory" && !value.endsWith("/") ? value + "/" : value)
    if (match.type === "file") {
      setSelected(
        Option.getOrElse(policy.selection(root(), pickerFileSearchQuery(root(), match.absolute, home())), () => ""),
      )
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
  }

  function chooseSuggestion(suggestion: { absolute: string; type: "file" | "directory" }) {
    if (suggestion.type === "directory") {
      runDetached(navigate(suggestion.absolute))
      return
    }
    setInput(displayPickerPath(suggestion.absolute, input(), home()))
    setSelected(
      Option.getOrElse(policy.selection(root(), pickerFileSearchQuery(root(), suggestion.absolute, home())), () => ""),
    )
    setSuggestionsOpen(false)
    setActiveSuggestion(-1)
  }

  function moveSuggestion(delta: -1 | 1) {
    setSuggestionsOpen(true)
    setActiveSuggestion((current) => nextSuggestionIndex(current, delta, currentSuggestions().length))
  }

  function activeSuggestionValue() {
    const items = currentSuggestions()
    return items[activeSuggestion()] ?? items[0]
  }

  const keyActions: Partial<Record<string, () => void>> = {
    ArrowDown: () => moveSuggestion(1),
    ArrowUp: () => moveSuggestion(-1),
    Enter: () => {
      const suggestion = activeSuggestionValue()
      if (suggestion) chooseSuggestion(suggestion)
      if (!suggestion) runDetached(navigate(input()))
    },
    Tab: complete,
  }

  function handleInputKey(event: KeyboardEvent) {
    const action = keyActions[event.key]
    if (!action) return
    if (event.key === "Tab" && event.shiftKey) return
    event.preventDefault()
    action()
  }

  function resolve() {
    const path = policy.result(root(), selected(), rootValid())
    if (Option.isNone(path)) return
    props.onSelect(props.multiple ? [path.value] : path.value)
    dialog.close()
  }

  onMount(() => {
    const closeSuggestions = (event: PointerEvent) => {
      if (event.target instanceof Node && pathArea?.contains(event.target)) return
      setSuggestionsOpen(false)
      setActiveSuggestion(-1)
    }
    document.addEventListener("pointerdown", closeSuggestions)
    onCleanup(() => document.removeEventListener("pointerdown", closeSuggestions))
    tree = new FileTree({
      paths: [],
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      stickyFolders: true,
      unsafeCSS: `
        button[data-type="item"] {
          background: transparent !important;
          box-shadow: none !important;
        }
        button[data-type="item"]:hover {
          background: var(--v2-overlay-simple-overlay-hover) !important;
        }
        button[data-type="item"]:focus-visible {
          outline: none !important;
          box-shadow: none !important;
        }
        [data-file-tree-virtualized-scroll] {
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
      `,
      onExpansionChange(change) {
        if (change.expanded) runDetached(load(change.path, navigation))
      },
      onSelectionChange(paths) {
        const path = paths.at(-1)
        setSelected(path ? Option.getOrElse(policy.selection(root(), path), () => "") : "")
      },
    })
    if (!container) return
    tree.render({ containerWrapper: container })
    tree.getFileTreeContainer()?.classList.add("directory-picker-v2-tree")
  })

  createEffect(() => {
    const path = start()
    if (!path || root()) return
    runDetached(navigate(path))
  })

  onCleanup(() => tree?.cleanUp())

  return (
    <Dialog size="large" class="directory-picker-v2">
      <DialogHeader>
        <DialogTitle>{props.title ?? language.t("command.project.open")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="directory-picker-v2-body pt-4!">
        <div class="directory-picker-v2-path" ref={pathArea}>
          <TextInputV2
            value={input()}
            autofocus
            autocomplete="off"
            spellcheck={false}
            class="!w-full"
            onInput={(event) => {
              setInput(cleanPickerInput(event.currentTarget.value))
              setSelected("")
              setSuggestionsOpen(true)
              setActiveSuggestion(-1)
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen()}
            aria-controls="directory-picker-v2-suggestions"
            {...(activeSuggestion() >= 0
              ? { "aria-activedescendant": `directory-picker-v2-suggestion-${activeSuggestion()}` }
              : {})}
            onKeyDown={handleInputKey}
          />
          <div class="directory-picker-v2-actions">
            <ButtonV2 size="small" variant="ghost" onClick={() => runDetached(navigate(home()))}>
              ~
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => runDetached(navigate(pickerRoot(root()) || root()))}>
              {language.t("dialog.directory.root")}
            </ButtonV2>
            <ButtonV2 size="small" variant="ghost" onClick={() => runDetached(navigate(pickerParent(root())))}>
              {language.t("dialog.directory.parent")}
            </ButtonV2>
          </div>
          <Show when={suggestionsOpen() && currentSuggestions().length > 0}>
            <div id="directory-picker-v2-suggestions" role="listbox" class="directory-picker-v2-suggestions">
              <For each={currentSuggestions()}>
                {(suggestion, index) => (
                  <button
                    id={`directory-picker-v2-suggestion-${index()}`}
                    data-directory-path={suggestion.absolute}
                    role="option"
                    aria-selected={index() === activeSuggestion()}
                    bool:data-active={index() === activeSuggestion()}
                    onPointerMove={() => setActiveSuggestion(index())}
                    onClick={() => chooseSuggestion(suggestion)}
                  >
                    {displayPickerPath(suggestion.absolute, input(), home())}
                    {suggestion.type === "directory" ? "/" : ""}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div
          class="directory-picker-v2-browser"
          ref={container}
          onWheel={(event) => {
            const scroller = tree
              ?.getFileTreeContainer()
              ?.shadowRoot?.querySelector<HTMLElement>("[data-file-tree-virtualized-scroll]")
            if (!scroller) return
            const next = nextTreeScrollTop(
              scroller.scrollTop,
              event.deltaY,
              scroller.scrollHeight,
              scroller.clientHeight,
            )
            if (next === scroller.scrollTop) return
            event.preventDefault()
            scroller.scrollTop = next
            scroller.dispatchEvent(new Event("scroll"))
          }}
        >
          <Show when={loading()}>
            <div class="directory-picker-v2-state">{language.t("common.loading")}</div>
          </Show>
          <Show when={!loading() && error()}>
            <div class="directory-picker-v2-state">{language.t("dialog.directory.readError")}</div>
          </Show>
        </div>
        <div class="directory-picker-v2-selection">
          {Option.getOrElse(policy.result(root(), selected(), rootValid()), () => "")}
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="contrast"
          disabled={Option.isNone(policy.result(root(), selected(), rootValid()))}
          onClick={resolve}
        >
          {action[policy.action]}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { Data, Effect, HashSet, MutableHashMap, Option } from "effect"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { showToast } from "@/utils/toast"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createPathHelpers } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { useServerSDK } from "./server-sdk"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { createFileTreeStore, FileTreeListError } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

class FileReadError extends Data.TaggedError("App.FileReadError")<{ readonly cause: unknown }> {}
class FileSearchError extends Data.TaggedError("App.FileSearchError")<{ readonly cause: unknown }> {}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const serverSDK = useServerSDK()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk().directory)
    const path = createPathHelpers(scope)
    const tabs = layout.tabs(() =>
      SessionStateKey.from(serverSDK().scope, SessionRouteKey.fromRoute(base64Encode(sdk().directory), params.id)),
    )

    const inflight = MutableHashMap.empty<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      normalizeDir: path.normalizeDir,
      list: (dir) =>
        Effect.tryPromise({
          try: () => sdk().client.file.list({ path: dir }),
          catch: (cause) => new FileTreeListError({ cause }),
        }).pipe(Effect.map((x) => x.data ?? [])),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: Option.getOrUndefined(message),
        })
      },
    })

    const evictContent = (keep: HashSet.HashSet<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            delete draft.content
            draft.loaded = false
          }),
        )
      })
    }

    createEffect(() => {
      scope()
      MutableHashMap.clear(inflight)
      resetFileContentLru()
      batch(() => {
        setStore("file", reconcile({}))
        tree.reset()
      })
    })

    const viewCache = createFileViewCache(serverSDK().scope)
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          delete draft.error
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    // Records a running load until it settles. A load that settles before
    // runPromise returns is not recorded, so no settled promise stays cached.
    const track = (key: string, program: Effect.Effect<void>) => {
      let settled = false
      const promise = Effect.runPromise(
        program.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              settled = true
              MutableHashMap.remove(inflight, key)
            }),
          ),
        ),
      )
      if (!settled) MutableHashMap.set(inflight, key, promise)
      return promise
    }

    const load = (input: string, options?: { force?: boolean }): Promise<void> => {
      const file = path.normalize(input)
      if (!file) return Effect.runPromise(Effect.void)

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Effect.runPromise(Effect.void)

      const pending = MutableHashMap.get(inflight, key)
      if (Option.isSome(pending)) return pending.value

      setLoading(file)

      return track(
        key,
        Effect.tryPromise({
          try: () => sdk().client.file.read({ path: file }),
          catch: (cause) => new FileReadError({ cause }),
        }).pipe(
          Effect.map((x) => {
            if (scope() !== directory) return
            const content = x.data
            setLoaded(file, content)

            if (!content) return
            touchFileContent(file, approxBytes(content))
            evictContent(HashSet.make(file))
          }),
          Effect.catch((error) =>
            Effect.sync(() => {
              if (scope() !== directory) return
              setLoadError(file, errorMessage(error.cause, language.t("error.chain.unknown")))
            }),
          ),
        ),
      )
    }

    const search = (query: string, dirs: "true" | "false", options?: { limit?: number; signal?: AbortSignal }) =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () =>
            serverSDK().api.file.find(
              {
                location: { directory: sdk().directory },
                query,
                type: dirs === "true" ? "directory" : "file",
                limit: options?.limit,
              },
              { signal: options?.signal },
            ),
          catch: (cause) => new FileSearchError({ cause }),
        }).pipe(
          Effect.map((x) => x.data.map((entry) => path.normalize(entry.path))),
          // An aborted search still rejects with the original abort reason; any
          // other failure resolves to no results.
          Effect.catch((error) => (options?.signal?.aborted ? Effect.fail(error.cause) : Effect.succeed<string[]>([]))),
        ),
      )

    const stop = sdk().event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    onCleanup(() => {
      stop()
      viewCache.clear()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string, options?: { limit?: number; signal?: AbortSignal }) =>
        search(query, "false", options),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})

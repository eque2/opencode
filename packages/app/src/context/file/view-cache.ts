import { createEffect, createRoot } from "solid-js"
import { Option } from "effect"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { createScopedCache } from "@/utils/scoped-cache"
import type { FileViewState, SelectedLineRange } from "./types"
import type { ServerScope } from "@/utils/server-scope"

const WORKSPACE_KEY = "__workspace__"
const MAX_FILE_VIEW_SESSIONS = 20
const MAX_VIEW_FILES = 500

function normalizeSelectedLines(range: SelectedLineRange): SelectedLineRange {
  if (range.start <= range.end) return { ...range }

  const startSide = range.side
  const endSide = range.endSide ?? startSide

  return {
    start: range.end,
    end: range.start,
    side: endSide,
    ...(startSide !== endSide ? { endSide: startSide } : {}),
  }
}

const sameSelectedLines = Option.makeEquivalence((a: SelectedLineRange, b: SelectedLineRange) => {
  const left = normalizeSelectedLines(a)
  const right = normalizeSelectedLines(b)
  return (
    left.start === right.start && left.end === right.end && left.side === right.side && left.endSide === right.endSide
  )
})

function createViewSession(scope: ServerScope, dir: string, id: Option.Option<string>) {
  const legacySuffix = Option.match(
    Option.filter(id, (value) => value.length > 0),
    { onNone: () => "", onSome: (value) => "/" + value },
  )
  const legacyViewKey = `${dir}/file${legacySuffix}.v1`

  const [view, setView, _, ready] = persisted(
    Persist.serverScoped(scope, dir, Option.getOrUndefined(id), "file-view", [legacyViewKey]),
    createStore<{
      file: Record<string, FileViewState>
    }>({
      file: {},
    }),
  )

  const meta = { pruned: false }

  const pruneView = (keep?: string) => {
    const keys = Object.keys(view.file)
    if (keys.length <= MAX_VIEW_FILES) return

    const drop = keys.filter((key) => key !== keep).slice(0, keys.length - MAX_VIEW_FILES)
    if (drop.length === 0) return

    setView(
      produce((draft) => {
        for (const key of drop) {
          delete draft.file[key]
        }
      }),
    )
  }

  createEffect(() => {
    if (!ready()) return
    if (meta.pruned) return
    meta.pruned = true
    pruneView()
  })

  const scrollTop = (path: string) => view.file[path]?.scrollTop
  const scrollLeft = (path: string) => view.file[path]?.scrollLeft
  const selectedLines = (path: string) => view.file[path]?.selectedLines

  const setScrollTop = (path: string, top: number) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.scrollTop === top) return
        file.scrollTop = top
      }),
    )
    pruneView(path)
  }

  const setScrollLeft = (path: string, left: number) => {
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (file.scrollLeft === left) return
        file.scrollLeft = left
      }),
    )
    pruneView(path)
  }

  // A null range clears the selection. Readers treat a missing key and a
  // stored null the same, so the key is deleted instead of set to null.
  const setSelectedLines = (path: string, range: SelectedLineRange | null) => {
    const next = Option.map(Option.fromNullOr(range), normalizeSelectedLines)
    setView(
      produce((draft) => {
        const file = draft.file[path] ?? (draft.file[path] = {})
        if (sameSelectedLines(Option.fromNullishOr(file.selectedLines), next)) return
        if (Option.isSome(next)) file.selectedLines = next.value
        else delete file.selectedLines
      }),
    )
    pruneView(path)
  }

  return {
    ready,
    scrollTop,
    scrollLeft,
    selectedLines,
    setScrollTop,
    setScrollLeft,
    setSelectedLines,
  }
}

export function createFileViewCache(scope: ServerScope) {
  const cache = createScopedCache(
    (key) => {
      const split = key.lastIndexOf("\n")
      const dir = split >= 0 ? key.slice(0, split) : key
      const id = split >= 0 ? key.slice(split + 1) : WORKSPACE_KEY
      return createRoot((dispose) => ({
        value: createViewSession(
          scope,
          dir,
          Option.liftPredicate(id, (value) => value !== WORKSPACE_KEY),
        ),
        dispose,
      }))
    },
    {
      maxEntries: MAX_FILE_VIEW_SESSIONS,
      dispose: (entry) => entry.dispose(),
    },
  )

  return {
    load: (dir: string, id: string | undefined) => {
      const key = `${dir}\n${id ?? WORKSPACE_KEY}`
      return cache.get(key).value
    },
    clear: () => cache.clear(),
  }
}

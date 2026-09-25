import path from "path"
import { Effect, Option, Schema } from "effect"
import { onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, fileSystemLayer, readText, writeText } from "../util/persistence"

const FrecencyEntry = Schema.Struct({
  path: Schema.String,
  frequency: Schema.Number,
  lastOpen: Schema.Number,
}).annotate({ identifier: "TuiFrecency.Entry" })
type FrecencyEntry = typeof FrecencyEntry.Type

const FrecencyLine = Schema.fromJsonString(FrecencyEntry)
const decodeFrecencyLine = Schema.decodeUnknownOption(FrecencyLine)
const encodeFrecencyLine = Schema.encodeSync(FrecencyLine)

function formatFrecency(entries: readonly FrecencyEntry[]) {
  return entries.map((entry) => `${encodeFrecencyLine(entry)}\n`).join("")
}

export const MAX_FRECENCY_ENTRIES = 1000

// A line that is not JSON, or not a frecency entry, is skipped. The last line for a path wins.
export function parseFrecency(text: string) {
  const latest = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Option.toArray(decodeFrecencyLine(line)))
    .reduce<Record<string, FrecencyEntry>>((result, entry) => {
      result[entry.path] = entry
      return result
    }, {})
  return Object.values(latest)
    .sort((a, b) => b.lastOpen - a.lastOpen)
    .slice(0, MAX_FRECENCY_ENTRIES)
}

function calculateFrecency(entry?: { frequency: number; lastOpen: number }) {
  if (!entry) return 0
  return entry.frequency / (1 + (Date.now() - entry.lastOpen) / 86400000)
}

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const paths = useTuiPaths()
    const frecencyPath = path.join(paths.state, "frecency.jsonl")
    onMount(() => {
      Effect.runFork(
        Effect.gen(function* () {
          const lines = parseFrecency(yield* readText(frecencyPath).pipe(Effect.orElseSucceed(() => "")))
          setStore(
            "data",
            Object.fromEntries(
              lines.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
            ),
          )
          if (lines.length > 0) yield* writeText(frecencyPath, formatFrecency(lines)).pipe(Effect.ignore)
        }).pipe(Effect.provide(fileSystemLayer)),
      )
    })

    const [store, setStore] = createStore({ data: {} as Record<string, { frequency: number; lastOpen: number }> })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(paths.cwd, filePath)
      const newEntry = { frequency: (store.data[absolutePath]?.frequency || 0) + 1, lastOpen: Date.now() }
      setStore("data", absolutePath, newEntry)
      Effect.runFork(
        appendText(frecencyPath, formatFrecency([{ path: absolutePath, ...newEntry }])).pipe(
          Effect.ignore,
          Effect.provide(fileSystemLayer),
        ),
      )

      if (Object.keys(store.data).length <= MAX_FRECENCY_ENTRIES) return
      const sorted = Object.entries(store.data)
        .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)
      setStore("data", Object.fromEntries(sorted))
      const text = formatFrecency(sorted.map(([entryPath, entry]) => ({ path: entryPath, ...entry })))
      Effect.runFork(writeText(frecencyPath, text).pipe(Effect.ignore, Effect.provide(fileSystemLayer)))
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(paths.cwd, filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})

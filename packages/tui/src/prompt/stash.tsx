import path from "path"
import { DateTime, Effect, Option, Schema } from "effect"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, fileSystemLayer, readText, writeText } from "../util/persistence"
import { PromptParts, type PromptInfo } from "./history"

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

const PromptStashEntry = Schema.Struct({
  input: Schema.String,
  parts: PromptParts,
  timestamp: Schema.Number,
}).annotate({ identifier: "TuiPromptStash.Entry" })

const PromptStashLine = Schema.fromJsonString(PromptStashEntry)
const decodePromptStashLine = Schema.decodeUnknownOption(PromptStashLine)
// StashEntry parts type text part metadata as unknown, so each entry is checked as it is encoded.
// An entry that is not JSON-encodable has no line.
const encodePromptStashLine = Schema.encodeUnknownOption(PromptStashLine)

function formatPromptStash(entries: readonly StashEntry[]) {
  return entries
    .flatMap((entry) => Option.toArray(encodePromptStashLine(entry)))
    .map((line) => `${line}\n`)
    .join("")
}

export const MAX_STASH_ENTRIES = 50

// A line that is not JSON, or not a StashEntry, is skipped.
export function parsePromptStash(text: string): StashEntry[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Option.toArray(decodePromptStashLine(line)))
    .slice(-MAX_STASH_ENTRIES)
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const paths = useTuiPaths()
    const stashPath = path.join(paths.state, "prompt-stash.jsonl")
    onMount(() => {
      Effect.runFork(
        Effect.gen(function* () {
          const lines = parsePromptStash(yield* readText(stashPath).pipe(Effect.orElseSucceed(() => "")))
          setStore("entries", lines)
          if (lines.length > 0) yield* writeText(stashPath, formatPromptStash(lines)).pipe(Effect.ignore)
        }).pipe(Effect.provide(fileSystemLayer)),
      )
    })

    function rewrite(entries: readonly StashEntry[]) {
      Effect.runFork(
        writeText(stashPath, formatPromptStash(entries)).pipe(Effect.ignore, Effect.provide(fileSystemLayer)),
      )
    }

    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()) }))
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.entries.push(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (trimmed) {
          rewrite(store.entries)
          return
        }
        const append = Option.match(encodePromptStashLine(stash), {
          onNone: () => Effect.logWarning("Prompt stash entry is not JSON-encodable; it is not saved"),
          onSome: (line) => appendText(stashPath, `${line}\n`),
        })
        Effect.runFork(append.pipe(Effect.ignore, Effect.provide(fileSystemLayer)))
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        rewrite(store.entries)
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        rewrite(store.entries)
      },
    }
  },
})

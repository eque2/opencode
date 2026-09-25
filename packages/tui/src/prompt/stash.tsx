import path from "path"
import { Effect, Option, Schema } from "effect"
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
          if (lines.length > 0)
            yield* writeText(stashPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n").pipe(
              Effect.ignore,
            )
        }).pipe(Effect.provide(fileSystemLayer)),
      )
    })

    function rewrite(text: string) {
      Effect.runFork(writeText(stashPath, text).pipe(Effect.ignore, Effect.provide(fileSystemLayer)))
    }

    const [store, setStore] = createStore({ entries: [] as StashEntry[] })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
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
          rewrite(store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n")
          return
        }
        Effect.runFork(
          appendText(stashPath, JSON.stringify(stash) + "\n").pipe(Effect.ignore, Effect.provide(fileSystemLayer)),
        )
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(produce((draft) => void draft.entries.pop()))
        rewrite(store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : "")
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(produce((draft) => void draft.entries.splice(index, 1)))
        rewrite(store.entries.length > 0 ? store.entries.map((line) => JSON.stringify(line)).join("\n") + "\n" : "")
      },
    }
  },
})

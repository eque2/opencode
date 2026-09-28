import path from "path"
import { Effect, Equal, Option, Schema } from "effect"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AgentPart, FilePart, TextPart } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, fileSystemLayer, readText, writeText } from "../util/persistence"

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | Omit<AgentPart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

// The span of a part's placeholder text in the prompt.
const PromptPartSourceText = Schema.Struct({
  value: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
}).annotate({ identifier: "TuiPromptHistory.PartSourceText" })

const PromptPosition = Schema.Struct({
  line: Schema.Number,
  character: Schema.Number,
}).annotate({ identifier: "TuiPromptHistory.Position" })

const PromptFileSource = Schema.Struct({
  text: PromptPartSourceText,
  type: Schema.Literal("file"),
  path: Schema.String,
}).annotate({ identifier: "TuiPromptHistory.FileSource" })

const PromptSymbolSource = Schema.Struct({
  text: PromptPartSourceText,
  type: Schema.Literal("symbol"),
  path: Schema.String,
  range: Schema.Struct({ start: PromptPosition, end: PromptPosition }),
  name: Schema.String,
  kind: Schema.Number,
}).annotate({ identifier: "TuiPromptHistory.SymbolSource" })

const PromptResourceSource = Schema.Struct({
  text: PromptPartSourceText,
  type: Schema.Literal("resource"),
  clientName: Schema.String,
  uri: Schema.String,
}).annotate({ identifier: "TuiPromptHistory.ResourceSource" })

// The SDK FilePart, AgentPart and TextPart without their IDs, as PromptInfo stores them.
const PromptFilePart = Schema.Struct({
  type: Schema.Literal("file"),
  mime: Schema.String,
  filename: Schema.optional(Schema.String),
  url: Schema.String,
  source: Schema.optional(Schema.Union([PromptFileSource, PromptSymbolSource, PromptResourceSource])),
}).annotate({ identifier: "TuiPromptHistory.FilePart" })

const PromptAgentPart = Schema.Struct({
  type: Schema.Literal("agent"),
  name: Schema.String,
  source: Schema.optional(PromptPartSourceText),
}).annotate({ identifier: "TuiPromptHistory.AgentPart" })

const PromptTextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  synthetic: Schema.optional(Schema.Boolean),
  ignored: Schema.optional(Schema.Boolean),
  time: Schema.optional(Schema.Struct({ start: Schema.Number, end: Schema.optional(Schema.Number) })),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  source: Schema.optional(Schema.Struct({ text: PromptPartSourceText })),
}).annotate({ identifier: "TuiPromptHistory.TextPart" })

/** The persisted form of `PromptInfo["parts"]`, shared with the prompt stash. */
export const PromptParts = Schema.mutable(
  Schema.Array(Schema.Union([PromptFilePart, PromptAgentPart, PromptTextPart])),
).annotate({ identifier: "TuiPromptHistory.Parts" })

const PromptHistoryEntry = Schema.Struct({
  input: Schema.String,
  mode: Schema.optional(Schema.Literals(["normal", "shell"])),
  parts: PromptParts,
}).annotate({ identifier: "TuiPromptHistory.Entry" })

const PromptHistoryLine = Schema.fromJsonString(PromptHistoryEntry)
const decodePromptHistoryLine = Schema.decodeUnknownOption(PromptHistoryLine)
// PromptInfo types text part metadata as unknown, so each entry is checked as it is encoded.
// An entry that is not JSON-encodable has no line.
const encodePromptHistoryLine = Schema.encodeUnknownOption(PromptHistoryLine)

function formatPromptHistory(entries: readonly PromptInfo[]) {
  return entries
    .flatMap((entry) => Option.toArray(encodePromptHistoryLine(entry)))
    .map((line) => `${line}\n`)
    .join("")
}

export const MAX_HISTORY_ENTRIES = 50

// A line that is not JSON, or not a PromptInfo, is skipped.
export function parsePromptHistory(text: string): PromptInfo[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Option.toArray(decodePromptHistoryLine(line)))
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  const encoded = encodePromptHistoryLine(next)
  return Option.isSome(encoded) && Equal.equals(encodePromptHistoryLine(previous), encoded)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    onMount(() => {
      Effect.runFork(
        Effect.gen(function* () {
          const lines = parsePromptHistory(yield* readText(historyPath).pipe(Effect.orElseSucceed(() => "")))
          setStore("history", lines)

          // Rewrite valid retained entries to self-heal corruption and enforce the limit.
          if (lines.length > 0) yield* writeText(historyPath, formatPromptHistory(lines)).pipe(Effect.ignore)
        }).pipe(Effect.provide(fileSystemLayer)),
      )
    })

    const [store, setStore] = createStore({
      index: 0,
      history: [] as PromptInfo[],
    })

    return {
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return undefined
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0) return { input: "", parts: [] }
        return store.history.at(store.index)
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
            draft.index = 0
          }),
        )

        const write = trimmed
          ? writeText(historyPath, formatPromptHistory(store.history))
          : Option.match(encodePromptHistoryLine(entry), {
              onNone: () => Effect.logWarning("Prompt history entry is not JSON-encodable; it is not saved"),
              onSome: (line) => appendText(historyPath, `${line}\n`),
            })
        Effect.runFork(write.pipe(Effect.ignore, Effect.provide(fileSystemLayer)))
      },
    }
  },
})

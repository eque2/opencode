import { describe, expect, test } from "bun:test"
import { Data, Effect, Option } from "effect"
import type { Prompt } from "@/context/prompt"
import {
  canNavigateHistoryAtCursor,
  clonePromptParts,
  normalizePromptHistoryEntry,
  navigatePromptHistory,
  prependHistoryEntry,
  promptLength,
  type PromptHistoryComment,
} from "./history"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

/** A precondition of a test did not hold, so the rest of the test cannot run. */
class TestFailure extends Data.TaggedError("Test.Failure")<{ readonly message: string }> {}

/** Succeeds with a navigation result that moved through history, and fails the test otherwise. */
const expectHandled = (result: ReturnType<typeof navigatePromptHistory>) =>
  result.handled ? Effect.succeed(result) : Effect.fail(new TestFailure({ message: "expected handled" }))

/** Succeeds with the file part at an index, and fails the test otherwise. */
const expectFile = (prompt: Prompt, index: number) => {
  const part = prompt[index]
  return part?.type === "file" ? Effect.succeed(part) : Effect.fail(new TestFailure({ message: "expected file" }))
}

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]
const comment = (id: string, value = "note"): PromptHistoryComment => ({
  id,
  path: "src/a.ts",
  selection: { start: 2, end: 4 },
  comment: value,
  time: 1,
  origin: "review",
  preview: "const a = 1",
})

describe("prompt-input history", () => {
  test("prependHistoryEntry skips empty prompt and deduplicates consecutive entries", () => {
    const first = prependHistoryEntry([], DEFAULT_PROMPT)
    expect(first).toEqual([])

    const commentsOnly = prependHistoryEntry([], DEFAULT_PROMPT, [comment("c1")])
    expect(commentsOnly).toHaveLength(1)

    const withOne = prependHistoryEntry([], text("hello"))
    expect(withOne).toHaveLength(1)

    const deduped = prependHistoryEntry(withOne, text("hello"))
    expect(deduped).toBe(withOne)

    const dedupedComments = prependHistoryEntry(commentsOnly, DEFAULT_PROMPT, [comment("c1")])
    expect(dedupedComments).toBe(commentsOnly)
  })

  test("navigatePromptHistory restores saved prompt when moving down from newest", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = [text("third"), text("second"), text("first")]
        const result = navigatePromptHistory({
          direction: "up",
          entries,
          historyIndex: -1,
          currentPrompt: text("draft"),
          currentComments: [comment("draft")],
          savedPrompt: Option.none(),
        })
        expect(result.handled).toBe(true)
        const up = yield* expectHandled(result)
        expect(up.historyIndex).toBe(0)
        expect(up.cursor).toBe("start")
        expect(up.entry.comments).toEqual([])

        const next = navigatePromptHistory({
          direction: "down",
          entries,
          historyIndex: up.historyIndex,
          currentPrompt: text("ignored"),
          currentComments: [],
          savedPrompt: up.savedPrompt,
        })
        expect(next.handled).toBe(true)
        const down = yield* expectHandled(next)
        expect(down.historyIndex).toBe(-1)
        expect(down.entry.prompt[0]?.type === "text" ? down.entry.prompt[0].content : "").toBe("draft")
        expect(down.entry.comments).toEqual([comment("draft")])
      }),
    ))

  test("navigatePromptHistory keeps entry comments when moving through history", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entries = [
          {
            prompt: text("with comment"),
            comments: [comment("c1")],
          },
        ]

        const result = navigatePromptHistory({
          direction: "up",
          entries,
          historyIndex: -1,
          currentPrompt: text("draft"),
          currentComments: [],
          savedPrompt: Option.none(),
        })

        expect(result.handled).toBe(true)
        const up = yield* expectHandled(result)
        expect(up.entry.prompt[0]?.type === "text" ? up.entry.prompt[0].content : "").toBe("with comment")
        expect(up.entry.comments).toEqual([comment("c1")])
      }),
    ))

  test("normalizePromptHistoryEntry supports legacy prompt arrays", () => {
    const entry = normalizePromptHistoryEntry(text("legacy"))
    expect(entry.prompt[0]?.type === "text" ? entry.prompt[0].content : "").toBe("legacy")
    expect(entry.comments).toEqual([])
  })

  test("helpers clone prompt and count text content length", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const original: Prompt = [
          { type: "text", content: "one", start: 0, end: 3 },
          {
            type: "file",
            path: "src/a.ts",
            content: "@src/a.ts",
            start: 3,
            end: 12,
            selection: { startLine: 1, startChar: 1, endLine: 2, endChar: 1 },
          },
          { type: "image", id: "1", filename: "img.png", mime: "image/png", blob: { id: "blob", url: "blob:test" } },
        ]
        const copy = clonePromptParts(original)
        expect(copy).not.toBe(original)
        expect(promptLength(copy)).toBe(12)
        const copied = yield* expectFile(copy, 1)
        copied.selection!.startLine = 9
        const source = yield* expectFile(original, 1)
        expect(source.selection?.startLine).toBe(1)
      }),
    ))

  test("canNavigateHistoryAtCursor only allows prompt boundaries", () => {
    const value = "a\nb\nc"

    expect(canNavigateHistoryAtCursor("up", value, 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 0)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 2)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 2)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 5)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 5)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 3)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", "", 0)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "", 0)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1, true)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1, true)).toBe(false)
  })
})

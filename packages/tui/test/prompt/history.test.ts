import { describe, expect, test } from "bun:test"
import { isDuplicateEntry, MAX_HISTORY_ENTRIES, parsePromptHistory, type PromptInfo } from "../../src/prompt/history"

const entry = (input: string, parts: PromptInfo["parts"] = []): PromptInfo => ({ input, parts })

describe("prompt history", () => {
  test("recovers valid JSONL entries around corruption", () => {
    expect(parsePromptHistory(`${JSON.stringify(entry("one"))}\nnot-json\n${JSON.stringify(entry("two"))}\n`)).toEqual([
      entry("one"),
      entry("two"),
    ])
  })

  test("keeps every stored part shape and skips entries that are not prompts", () => {
    const stored = entry("see @src/a.ts @build [Pasted ~2 lines]", [
      {
        type: "file",
        mime: "text/plain",
        filename: "a.ts",
        url: "file:///repo/src/a.ts",
        source: { type: "file", path: "src/a.ts", text: { start: 4, end: 13, value: "@src/a.ts" } },
      },
      {
        type: "file",
        mime: "text/plain",
        filename: "main",
        url: "file:///repo/src/main.ts",
        source: {
          type: "symbol",
          path: "src/main.ts",
          name: "main",
          kind: 12,
          range: { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } },
          text: { start: 0, end: 0, value: "" },
        },
      },
      { type: "agent", name: "build", source: { start: 14, end: 20, value: "@build" } },
      {
        type: "text",
        text: "one\ntwo",
        synthetic: true,
        metadata: { kind: "paste", lines: [1, 2] },
        source: { text: { start: 21, end: 39, value: "[Pasted ~2 lines]" } },
      },
    ])
    const shell = { ...entry("ls"), mode: "shell" as const }
    const text = [
      JSON.stringify(stored),
      JSON.stringify({ input: 1, parts: [] }),
      JSON.stringify({ input: "bad part", parts: [{ type: "unknown" }] }),
      JSON.stringify(shell),
    ].join("\n")
    expect(parsePromptHistory(text)).toEqual([stored, shell])
  })

  test("retains only the newest entries", () => {
    const input = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, index) =>
      JSON.stringify(entry(String(index))),
    ).join("\n")
    const result = parsePromptHistory(input)
    expect(result).toHaveLength(MAX_HISTORY_ENTRIES)
    expect(result[0]?.input).toBe("5")
  })

  test("dedupes only identical consecutive entries", () => {
    expect(isDuplicateEntry(undefined, entry("hello"))).toBe(false)
    expect(isDuplicateEntry(entry("hello"), entry("hello"))).toBe(true)
    expect(isDuplicateEntry(entry("foo"), entry("bar"))).toBe(false)
    expect(isDuplicateEntry({ ...entry("ls"), mode: "normal" }, { ...entry("ls"), mode: "shell" })).toBe(false)
  })

  test("does not dedupe entries with different parts", () => {
    const a = entry("describe this", [
      { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" },
    ])
    const b = entry("describe this", [
      { type: "file", mime: "image/png", filename: "b.png", url: "data:image/png;base64,BBB" },
    ])
    expect(isDuplicateEntry(a, b)).toBe(false)
  })
})

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createMarkdownParser } from "./marked-parser"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

const parse = (src: string) => Effect.promise(() => parser.parse(src, { async: true }))

test("renders links with application attributes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* parse("[OpenCode](https://opencode.ai)")).toBe(
        '<p><a href="https://opencode.ai" class="external-link" target="_blank" rel="noopener noreferrer">OpenCode</a></p>\n',
      )
    }),
  ))

test("renders inline and block math", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* parse("\\(x^2\\)")).toContain('<span class="katex">')
      expect(yield* parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
    }),
  ))

test("uses the configured code highlighter", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* parse("```ts\nconst value = 1\n```\n")).toBe('<pre data-language="ts">const value = 1</pre>\n')
    }),
  ))

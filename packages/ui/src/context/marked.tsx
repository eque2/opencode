import { getSharedHighlighter } from "@pierre/diffs"
import { Effect } from "effect"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { createMarkdownParser } from "./marked-parser"
import { registerOpenCodeTheme } from "./marked-theme-register"

export { OpenCodeTheme } from "./marked-theme"

registerOpenCodeTheme()

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () =>
    createMarkdownParser((code, language) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const highlighter = yield* Effect.promise(() =>
            getSharedHighlighter({
              themes: ["OpenCode"],
              langs: [],
              preferredHighlighter: "shiki-wasm",
            }),
          )
          const name = isBundledLanguage(language) ? language : "text"
          if (!highlighter.getLoadedLanguages().includes(name))
            yield* Effect.promise(() => highlighter.loadLanguage(name))
          return highlighter.codeToHtml(code, {
            lang: name,
            theme: "OpenCode",
            tabindex: false,
          })
        }),
      ),
    ),
})

function isBundledLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language)
}

/// <reference lib="webworker" />

import { ShikiStreamTokenizer } from "@shikijs/stream"
import { Cause, Effect, MutableHashMap, Option, Predicate } from "effect"
import { createMarkdownParser } from "@opencode-ai/ui/context/marked-parser"
import { OpenCodeTheme } from "@opencode-ai/ui/context/marked-theme"
import {
  bundledLanguages,
  createHighlighter,
  getTokenStyleObject,
  stringifyTokenStyle,
  type BundledLanguage,
  type ThemedToken,
} from "shiki"
import type { MarkdownToken, MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol"
import { createLatestWorkerQueue } from "./markdown-worker-queue"
import { project, type Projection } from "./markdown-stream"

type Stream = {
  language: string
  source: string
  tokenizer: ShikiStreamTokenizer
}

const streams = MutableHashMap.empty<string, Stream>()
const projections = MutableHashMap.empty<string, Projection>()
let highlighter: ReturnType<typeof createHighlighter> | undefined
const highlightQueue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "highlight" }>>({
  run: highlight,
  supersede: (request) => post({ type: "superseded", id: request.id, key: request.key }),
  dispose: (key) => {
    MutableHashMap.remove(streams, key)
  },
})
const projectQueue = createLatestWorkerQueue<Extract<MarkdownWorkerRequest, { type: "project" }>>({
  run: runProject,
  supersede: (request) => post({ type: "superseded", id: request.id, key: request.key }),
  dispose: (key) => {
    MutableHashMap.remove(projections, key)
  },
})
const parser = createMarkdownParser((code, language) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const instance = yield* Effect.promise(() => getHighlighter())
      const name = language in bundledLanguages ? language : "text"
      if (!instance.getLoadedLanguages().includes(name))
        yield* Effect.promise(() => instance.loadLanguage(bundledLanguages[name as BundledLanguage]))
      return instance.codeToHtml(code, { lang: name as BundledLanguage, theme: "OpenCode", tabindex: false })
    }),
  ),
)

// The message handler is the runner boundary. Each program posts its own result or error.
self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  if (event.data.type === "dispose") {
    highlightQueue.dispose(event.data.key)
    projectQueue.dispose(event.data.key)
    return
  }
  if (event.data.type === "parse") {
    Effect.runFork(parse(event.data))
    return
  }
  if (event.data.type === "project") {
    projectQueue.highlight(event.data)
    return
  }

  highlightQueue.highlight(event.data)
}

function parse(request: Extract<MarkdownWorkerRequest, { type: "parse" }>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const parsed = parser.parse(request.text)
    const html = Predicate.isPromiseLike(parsed) ? yield* Effect.promise(() => parsed) : parsed
    post({ type: "parse", id: request.id, html })
  }).pipe(
    Effect.catchCause((cause) => Effect.sync(() => post({ type: "error", id: request.id, message: failure(cause) }))),
  )
}

function runProject(request: Extract<MarkdownWorkerRequest, { type: "project" }>): Effect.Effect<void> {
  return Effect.sync(() => {
    const projection = project(MutableHashMap.get(projections, request.key), request.text, request.live)
    MutableHashMap.set(projections, request.key, projection)
    post({ type: "project", id: request.id, key: request.key, projection })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => post({ type: "error", id: request.id, key: request.key, message: failure(cause) })),
    ),
  )
}

function highlight(request: Extract<MarkdownWorkerRequest, { type: "highlight" }>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const instance = yield* Effect.promise(() => getHighlighter())
    const language = request.language in bundledLanguages ? request.language : "text"
    if (!instance.getLoadedLanguages().includes(language))
      yield* Effect.promise(() => instance.loadLanguage(bundledLanguages[language as BundledLanguage]))

    if (request.complete) {
      const result = instance.codeToTokens(request.text, { lang: language as BundledLanguage, theme: "OpenCode" })
      MutableHashMap.remove(streams, request.key)
      post({
        type: "highlight",
        id: request.id,
        key: request.key,
        language,
        reset: true,
        stable: result.tokens
          .flatMap((line, index) =>
            index === result.tokens.length - 1 ? line : [...line, { content: "\n", offset: 0 }],
          )
          .map(token),
        unstable: [],
      })
      return
    }

    // Reuse the stream only while the language matches and the text extends the streamed source.
    const reusable = Option.filter(
      MutableHashMap.get(streams, request.key),
      (previous) => previous.language === language && request.text.startsWith(previous.source),
    )
    const reset = Option.isNone(reusable)
    const stream = Option.getOrElse(
      reusable,
      (): Stream => ({
        language,
        source: "",
        tokenizer: new ShikiStreamTokenizer({ highlighter: instance, lang: language, theme: "OpenCode" }),
      }),
    )
    const result = yield* Effect.promise(() => stream.tokenizer.enqueue(request.text.slice(stream.source.length)))
    stream.source = request.text
    MutableHashMap.set(streams, request.key, stream)
    post({
      type: "highlight",
      id: request.id,
      key: request.key,
      language,
      reset,
      stable: result.stable.filter((token) => token.content.length > 0).map(token),
      unstable: result.unstable.filter((token) => token.content.length > 0).map(token),
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => post({ type: "error", id: request.id, key: request.key, message: failure(cause) })),
    ),
  )
}

// The message of the thrown or rejected value, as the old catch blocks reported it.
function failure(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

function getHighlighter() {
  return (highlighter ??= createHighlighter({ themes: [OpenCodeTheme], langs: [] }))
}

function post(response: MarkdownWorkerResponse) {
  self.postMessage(response)
}

function token(value: ThemedToken): MarkdownToken {
  return [value.content, stringifyTokenStyle(value.htmlStyle ?? getTokenStyleObject(value))]
}

import { checksum } from "@opencode-ai/core/util/encode"
import DOMPurify from "dompurify"
import { Array, Effect, Iterable, MutableHashMap, Option } from "effect"
import { parseMarkdown } from "./markdown-worker"

export type MarkdownCacheEntry = {
  raw: string
  hash: string
  html: string
}

const max = 200
const cache = MutableHashMap.empty<string, MarkdownCacheEntry>()
const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    // Array.dedupe keeps the first occurrence, as the Set insertion order did.
    node.setAttribute("rel", Array.dedupe([...rel.split(/\s+/).filter(Boolean), "noopener", "noreferrer"]).join(" "))
  })
}

export function sanitizeMarkdown(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

export function getCachedMarkdown(key: string): Option.Option<MarkdownCacheEntry> {
  return MutableHashMap.get(cache, key)
}

export function touchCachedMarkdown(key: string, value: MarkdownCacheEntry) {
  // Remove, then set, moves the key to the end: MutableHashMap keeps insertion order for string keys.
  MutableHashMap.remove(cache, key)
  MutableHashMap.set(cache, key, value)

  if (MutableHashMap.size(cache) <= max) return

  const first = Iterable.head(MutableHashMap.keys(cache))
  if (Option.isNone(first) || !first.value) return
  MutableHashMap.remove(cache, first.value)
}

export function preloadMarkdown(text: string, cacheKey: string): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const key = `${cacheKey}:0:full`
      const cached = getCachedMarkdown(key)
      if (Option.isSome(cached) && cached.value.raw === text) {
        touchCachedMarkdown(key, cached.value)
        return
      }
      const hash = checksum(text)
      if (!hash) return
      const html = yield* parseMarkdown(text)
      touchCachedMarkdown(key, { raw: text, hash, html: sanitizeMarkdown(html) })
    }),
  )
}

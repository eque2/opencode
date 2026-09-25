import { useI18n } from "@opencode-ai/ui/context/i18n"
import { Effect, Fiber, HashSet, MutableHashMap, MutableHashSet, Option, Result } from "effect"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import {
  type Accessor,
  type ComponentProps,
  createEffect,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  type Setter,
  splitProps,
} from "solid-js"
import { isServer, render } from "solid-js/web"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { canReusePendingBlock, completedProjection } from "./markdown-projection"
import type { Block, Projection } from "./markdown-stream"
import {
  disposeMarkdownProjection,
  disposeStreamingCode,
  highlightStreamingCode,
  parseMarkdown,
  projectMarkdown,
  type MarkdownWorkerError,
} from "./markdown-worker"
import { markdownBlockKey, type MarkdownToken } from "./markdown-worker-protocol"
import { shouldResetCodeTokens, type RenderedCodeState } from "./markdown-code-state"
import { getCachedMarkdown, sanitizeMarkdown, touchCachedMarkdown, type MarkdownCacheEntry } from "./markdown-cache"
import { inlineCodeKind } from "./markdown-inline-code-kind"

type RenderedBlock =
  | (MarkdownCacheEntry & { key: string; mode: Exclude<Block["mode"], "code"> })
  | {
      key: string
      mode: "code"
      raw: string
      hash: string
      language: string
      complete: boolean
      generation: number
      stable: MarkdownToken[]
      unstable: MarkdownToken[]
    }

type RenderResult = {
  text: string
  blocks: RenderedBlock[]
}

const renderedCodeTokens = new WeakMap<HTMLDivElement, RenderedCodeState>()

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

type CodeTokens = {
  language: string
  generation: number
  stable: MarkdownToken[]
  unstable: MarkdownToken[]
}

// Posts the highlight request now; the Effect waits for the tokens. When the request fails, the
// text renders as one plain token, and only a failure of the worker itself is logged.
function code(text: string, language: string | undefined, key: string, complete = false): Effect.Effect<CodeTokens> {
  return highlightStreamingCode(key, text, language ?? "text", complete).pipe(
    Effect.map(
      (result): CodeTokens => ({
        language: result.language,
        generation: result.generation,
        stable: result.stable,
        unstable: result.unstable,
      }),
    ),
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (error._tag === "MarkdownWorkerFailedError")
          yield* Effect.logError("Markdown highlighting worker failed", error)
        const plain: CodeTokens = { language: language ?? "text", generation: 0, stable: [], unstable: [[text, ""]] }
        return plain
      }),
    ),
  )
}

function fallbackResult(text: string, key: string): RenderResult {
  return {
    text,
    blocks: [{ key, mode: "full", raw: text, hash: checksum(text) ?? "", html: fallback(text) }],
  }
}

type CopyLabels = {
  copy: string
  copied: string
}

type CopyButtonState = {
  setLabels: Setter<CopyLabels>
  setCopied: Setter<boolean>
  dispose: () => void
}

const copyButtonState = new WeakMap<HTMLElement, CopyButtonState>()

// The fiber that clears a button's "copied" state. A WeakMap keys it by element identity.
const copyResets = new WeakMap<HTMLElement, Fiber.Fiber<void>>()

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string): Option.Option<string> {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return Option.none()
  // The URL constructor throws on an invalid URL; that text stays plain code.
  return Result.getSuccess(Result.try(() => new URL(href).toString()))
}

function createCopyButton(labels: CopyLabels) {
  const host = document.createElement("div")
  host.setAttribute("data-slot", "markdown-copy-button")

  const state: Partial<CopyButtonState> = {}
  const dispose = render(() => {
    const [labelState, setLabels] = createSignal(labels, { equals: false })
    const [copied, setCopied] = createSignal(false)
    state.setLabels = setLabels
    state.setCopied = setCopied
    return <MarkdownCopyButton labels={labelState} copied={copied} />
  }, host)
  state.dispose = dispose
  copyButtonState.set(host, state as CopyButtonState)
  return host
}

function MarkdownCopyButton(props: { labels: Accessor<CopyLabels>; copied: Accessor<boolean> }) {
  const label = () => (props.copied() ? props.labels().copied : props.labels().copy)
  return (
    <TooltipV2 placement="top" value={label()}>
      <IconButtonV2
        type="button"
        size="normal"
        variant="ghost-muted"
        aria-label={label()}
        icon={
          <>
            <IconV2 name="outline-copy" data-copy-icon />
            <IconV2 name="check" data-check-icon />
          </>
        }
      />
    </TooltipV2>
  )
}

function setCopyState(host: HTMLElement, labels: CopyLabels, copied: boolean) {
  const state = copyButtonState.get(host)
  state?.setLabels(labels)
  state?.setCopied(copied)
  if (copied) {
    host.setAttribute("data-copied", "true")
    return
  }
  host.removeAttribute("data-copied")
}

function scheduleCopyReset(host: HTMLElement, labels: CopyLabels) {
  stopCopyReset(host)
  copyResets.set(
    host,
    Effect.runFork(
      Effect.sleep("2 seconds").pipe(
        Effect.andThen(Effect.sync(() => setCopyState(host, labels, false))),
        Effect.tapDefect((defect) => Effect.logError(defect)),
      ),
    ),
  )
}

function stopCopyReset(host: HTMLElement) {
  const fiber = copyResets.get(host)
  if (fiber) Effect.runFork(Fiber.interrupt(fiber))
  copyResets.delete(host)
}

function disposeCopyButton(host: HTMLElement) {
  stopCopyReset(host)
  copyButtonState.get(host)?.dispose()
  copyButtonState.delete(host)
}

function disposeCopyButtons(root: Element) {
  const hosts = [
    ...(root instanceof HTMLElement && root.getAttribute("data-slot") === "markdown-copy-button" ? [root] : []),
    ...Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    ),
  ]
  hosts.forEach(disposeCopyButton)
}

const shellLanguages = HashSet.fromIterable(["bash", "sh", "shell", "zsh", "fish", "console", "terminal"])

function codeKind(language: string | undefined) {
  const value = language?.toLowerCase()
  if (!value) return
  if (HashSet.has(shellLanguages, value)) return "shell"
}

function codeLanguage(block: HTMLPreElement) {
  const code = block.querySelector("code")
  if (!(code instanceof HTMLElement)) return
  return code.className.match(/(?:^|\s)language-([^\s]+)/)?.[1]
}

function applyCodeMetadata(wrapper: HTMLElement, language: string | undefined) {
  if (!document.body.hasAttribute("data-new-layout")) {
    delete wrapper.dataset.language
    delete wrapper.dataset.codeKind
    return
  }

  if (language) wrapper.dataset.language = language
  else delete wrapper.dataset.language

  const kind = codeKind(language)
  if (kind) wrapper.dataset.codeKind = kind
  else delete wrapper.dataset.codeKind
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    applyCodeMetadata(wrapper, codeLanguage(block))
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  applyCodeMetadata(parent, codeLanguage(block))

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    disposeCopyButton(button)
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink = Option.liftPredicate(
      code.parentElement,
      (parent): parent is HTMLAnchorElement =>
        parent instanceof HTMLAnchorElement && parent.classList.contains("external-link"),
    )

    if (Option.isNone(href)) {
      if (Option.isSome(parentLink)) parentLink.value.replaceWith(code)
      continue
    }

    if (Option.isSome(parentLink)) {
      parentLink.value.href = href.value
      continue
    }

    const link = document.createElement("a")
    link.href = href.value
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function markInlineCode(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    if (!(code instanceof HTMLElement)) continue
    delete code.dataset.inlineCodeKind
    const kind = inlineCodeKind(code.textContent ?? "")
    if (kind) code.dataset.inlineCodeKind = kind
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  if (!document.body.hasAttribute("data-new-layout")) return
  markInlineCode(root)
  markCodeLinks(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const updateLabel = (button: HTMLElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.promise(() => clipboard.writeText(content))
        const labels = getLabels()
        setCopyState(button, labels, true)
        scheduleCopyReset(button, labels)
      }).pipe(Effect.tapDefect((defect) => Effect.logError(defect))),
    )
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    // Disposing each button also stops its reset fiber.
    disposeCopyButtons(root)
  }
}

function initialResult(text: string, key: string | undefined, projection: Projection, owner: string): RenderResult {
  if (!text) return { text, blocks: [] }
  const base = key ?? checksum(text)
  if (base) {
    const blocks = projection.blocks.flatMap((block, index) => {
      if (block.mode === "code") return []
      const cacheKey = `${base}:${index}:${block.mode}`
      const cached = getCachedMarkdown(cacheKey)
      if (Option.isNone(cached) || cached.value.raw !== block.raw) return []
      return [{ key: `${owner}:${cacheKey}`, mode: block.mode, ...cached.value }]
    })
    if (blocks.length === projection.blocks.length) return { text, blocks }
  }
  return {
    text,
    blocks: [
      {
        key: "initial",
        mode: "full",
        raw: text,
        hash: checksum(text) ?? "",
        html: fallback(text),
      },
    ],
  }
}

function pendingProjection(text: string): Projection {
  return { text, blocks: text ? [{ raw: text, src: text, mode: "live" }] : [] }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const owner = createUniqueId()
  const activeCodeKeys = MutableHashSet.empty<string>()
  const completedCode = MutableHashMap.empty<string, Extract<RenderedBlock, { mode: "code" }>>()
  let streamed = false
  const [projection] = createResource(
    () => {
      if (isServer) return
      const live = local.streaming ?? false
      if (live) streamed = true
      if (!live && !streamed) return
      return { key: owner, text: local.text, live }
    },
    (src) => Effect.runPromise(projectMarkdown(src.key, src.text, src.live)),
    { initialValue: pendingProjection("") },
  )
  const currentProjection = () => {
    if (!(local.streaming ?? false) && !streamed) return completedProjection(local.text)
    const value = projection.latest
    if (value?.text === local.text) return value
    if (value?.text) return value
    return pendingProjection(local.text)
  }
  const [html] = createResource(
    () => {
      if (isServer)
        return {
          text: local.text,
          key: local.cacheKey,
          projection: pendingProjection(local.text),
        }
      const value = !(local.streaming ?? false) && !streamed ? completedProjection(local.text) : projection.latest
      if (!value || value.text !== local.text) return
      return {
        text: local.text,
        key: local.cacheKey,
        projection: value,
      }
    },
    (src) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (isServer) return fallbackResult(src.text, "server")
          if (!src.text) return { text: src.text, blocks: [] } satisfies RenderResult

          const base = src.key ?? checksum(src.text)
          // Effect.runPromise starts this program at once, so every block posts its worker request
          // during the fetcher call, in block order, as the old async callbacks did.
          return yield* Effect.suspend(() =>
            Effect.all(
              src.projection.blocks.map((block, index) => renderBlock(block, index, base, src.key)),
              { concurrency: "unbounded" },
            ),
          ).pipe(
            Effect.map((blocks): RenderResult => ({ text: src.text, blocks })),
            Effect.catchCause(() => Effect.succeed(fallbackResult(src.text, base ?? "fallback"))),
          )
        }),
      ),
    {
      initialValue: initialResult(
        local.text,
        local.cacheKey,
        local.streaming ? pendingProjection(local.text) : completedProjection(local.text),
        owner,
      ),
    },
  )

  // Posts the block's worker request at once, unless a cache already holds the block.
  function renderBlock(
    block: Block,
    index: number,
    base: string | undefined,
    cacheKey: string | undefined,
  ): Effect.Effect<RenderedBlock, MarkdownWorkerError> {
    const key = base ? Option.some(`${base}:${index}:${block.mode}`) : Option.none()
    const blockKey = markdownBlockKey(owner, Option.fromNullishOr(cacheKey), index, block.mode)

    if (block.mode === "code") {
      const cached = MutableHashMap.get(completedCode, blockKey)
      if (block.complete && Option.isSome(cached) && cached.value.raw === block.raw) return Effect.succeed(cached.value)
      return code(block.src, block.language, blockKey, block.complete).pipe(
        Effect.map((result) => {
          const rendered: Extract<RenderedBlock, { mode: "code" }> = {
            key: blockKey,
            mode: "code",
            raw: block.raw,
            hash: String(block.raw.length),
            complete: !!block.complete,
            ...result,
          }
          if (block.complete) MutableHashMap.set(completedCode, blockKey, rendered)
          return rendered
        }),
      )
    }

    const mode = block.mode
    if (Option.isSome(key)) {
      const cached = getCachedMarkdown(key.value)
      if (Option.isSome(cached) && cached.value.raw === block.raw) {
        touchCachedMarkdown(key.value, cached.value)
        return Effect.succeed({ key: blockKey, mode, ...cached.value })
      }
    }

    const hash = checksum(block.raw)
    return parseMarkdown(block.src).pipe(
      Effect.map((html) => {
        const safe = sanitizeMarkdown(html)
        if (Option.isSome(key) && hash) touchCachedMarkdown(key.value, { raw: block.raw, hash, html: safe })
        return { key: blockKey, mode, raw: block.raw, hash: hash ?? "", html: safe }
      }),
    )
  }

  let copyCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const result = html.latest ?? html()
    const projected = currentProjection()
    const content = local.text ? pendingBlocks(result, projected, local.cacheKey, owner) : []
    if (!container) return
    if (isServer) return
    if (content.length === 0) {
      disposeCopyButtons(container)
      container.innerHTML = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const nextCodeKeys = MutableHashSet.fromIterable(
      content.filter((block) => block.mode === "code").map((block) => block.key),
    )
    for (const key of activeCodeKeys) {
      if (!MutableHashSet.has(nextCodeKeys, key)) disposeCode(key)
    }
    MutableHashSet.clear(activeCodeKeys)
    for (const key of nextCodeKeys) MutableHashSet.add(activeCodeKeys, key)
    content.forEach((block, index) => updateBlock(container, index, block, labels))
    while (container.children.length > content.length) {
      const child = container.lastElementChild
      if (!child) break
      disposeCopyButtons(child)
      child.remove()
    }
    container
      .querySelectorAll<HTMLElement>('[data-slot="markdown-copy-button"]')
      .forEach((button) => setCopyState(button, labels, button.dataset.copied === "true"))
    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
    disposeMarkdownProjection(owner)
    for (const key of activeCodeKeys) disposeCode(key)
    MutableHashMap.clear(completedCode)
  })

  return (
    <div
      data-component="markdown"
      dir="auto"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}

function pendingBlocks(
  result: RenderResult | undefined,
  projection: Projection | undefined,
  cacheKey: string | undefined,
  owner: string,
) {
  if (!result) return []
  if (!projection || result.text === projection.text) return result.blocks
  const initial = result.blocks.length === 1 && result.blocks[0]?.key === "initial"
  return projection.blocks.map((block, index) => {
    const current = initial ? Option.none() : Option.fromNullishOr(result.blocks.at(index))
    if (Option.isSome(current) && canReusePendingBlock(current.value, block)) return current.value
    const key = markdownBlockKey(owner, Option.fromNullishOr(cacheKey), index, block.mode)
    if (block.mode !== "code")
      return { key, mode: block.mode, raw: block.raw, hash: String(block.raw.length), html: fallback(block.src) }
    return {
      key,
      mode: block.mode,
      raw: block.raw,
      hash: String(block.raw.length),
      language: block.language ?? "text",
      complete: !!block.complete,
      stable: [],
      generation: 0,
      unstable: [[block.src, ""] as MarkdownToken],
    }
  })
}

function disposeCode(key: string) {
  disposeStreamingCode(key)
}

function updateBlock(container: HTMLDivElement, index: number, block: RenderedBlock, labels: CopyLabels) {
  const current = container.children[index]
  if (block.mode === "code") {
    updateCodeBlock(container, current, block, labels)
    return
  }
  if (
    current instanceof HTMLDivElement &&
    current.dataset.markdownKey === block.key &&
    current.dataset.markdownHash === block.hash
  )
    return

  const next = document.createElement("div")
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.style.display = "contents"
  next.innerHTML = block.html
  decorate(next, labels)

  if (!(current instanceof HTMLDivElement)) {
    container.appendChild(next)
    return
  }

  morphdom(current, next, {
    onBeforeElUpdated: (fromEl, toEl) => {
      if (
        fromEl instanceof HTMLElement &&
        toEl instanceof HTMLElement &&
        fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
        toEl.getAttribute("data-slot") === "markdown-copy-button"
      ) {
        return false
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
    onBeforeNodeDiscarded: (node) => {
      if (node instanceof Element) disposeCopyButtons(node)
      return true
    },
  })
}

function updateCodeBlock(
  container: HTMLDivElement,
  current: Element | undefined,
  block: Extract<RenderedBlock, { mode: "code" }>,
  labels: CopyLabels,
) {
  const existing = Option.liftPredicate(
    current,
    (element): element is HTMLDivElement =>
      element instanceof HTMLDivElement && element.dataset.markdownKey === block.key,
  )
  const next = Option.getOrElse(existing, () => document.createElement("div"))
  next.dataset.markdownBlock = ""
  next.dataset.markdownKey = block.key
  next.dataset.markdownHash = block.hash
  next.dataset.markdownComplete = block.complete ? "true" : "false"
  next.style.display = "contents"

  const existingCode = Option.flatMapNullishOr(existing, (element) => element.querySelector("code"))
  if (Option.isSome(existingCode)) {
    const code = existingCode.value
    const wrapper = code.closest('[data-component="markdown-code"]')
    if (wrapper instanceof HTMLElement) applyCodeMetadata(wrapper, block.language)
    code.className = `language-${block.language}`
    const previous = renderedCodeTokens.get(next)
    const reset = shouldResetCodeTokens(previous, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      raw: block.raw,
    })
    const stableCount = reset ? 0 : previous!.stableCount
    const tail = [...block.stable.slice(stableCount), ...block.unstable]
    const prior = reset ? [] : previous!.unstable
    const prefix = prior.findIndex((token, index) => !sameToken(token, tail[index]))
    const keep = stableCount + (prefix < 0 ? Math.min(prior.length, tail.length) : prefix)
    while (code.children.length > keep) code.lastElementChild?.remove()
    tail
      .slice(keep - stableCount)
      .map(createTokenSpan)
      .forEach((span) => code.appendChild(span))
    renderedCodeTokens.set(next, {
      language: block.language,
      generation: block.generation,
      stableCount: block.stable.length,
      unstable: block.unstable,
      raw: block.raw,
    })
    return
  }

  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "markdown-code")
  applyCodeMetadata(wrapper, block.language)
  const pre = document.createElement("pre")
  pre.className = "shiki OpenCode"
  const codeElement = document.createElement("code")
  codeElement.className = `language-${block.language}`
  ;[...block.stable, ...block.unstable].map(createTokenSpan).forEach((span) => codeElement.appendChild(span))
  pre.appendChild(codeElement)
  wrapper.appendChild(pre)
  wrapper.appendChild(createCopyButton(labels))
  next.appendChild(wrapper)
  renderedCodeTokens.set(next, {
    language: block.language,
    generation: block.generation,
    stableCount: block.stable.length,
    unstable: block.unstable,
    raw: block.raw,
  })
  if (current) {
    disposeCopyButtons(current)
    current.replaceWith(next)
    return
  }
  container.appendChild(next)
}

function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

function createTokenSpan(token: MarkdownToken) {
  const span = document.createElement("span")
  span.setAttribute("style", token[1])
  span.textContent = token[0]
  return span
}

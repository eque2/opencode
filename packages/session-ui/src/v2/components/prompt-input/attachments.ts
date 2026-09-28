import { Effect, HashMap, HashSet, Option, Random } from "effect"
import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { PromptInputV2Attachment, PromptInputV2Prompt } from "./types"

const accepted = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]

type PromptTarget = {
  current: () => PromptInputV2Prompt
  cursor: () => number | undefined
  set: (prompt: PromptInputV2Prompt, cursor?: number) => void
}

type AttachmentTarget = { prompt: PromptTarget; cursor: number }

export type PromptInputV2AttachmentConfig = {
  picker?: (
    options: { defaultPath?: string; multiple?: boolean; accept?: string[] },
    onFile: (file: File) => Promise<unknown>,
  ) => Promise<void>
  directory: () => string
  isDialogActive: () => boolean
  warn: () => void
  duplicate: () => void
  onError: (error: unknown) => void
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
  store?: (file: File) => Promise<{ id: string; url: string }>
}

export function createPromptInputV2Attachments(
  input: PromptInputV2AttachmentConfig & {
    capture: () => PromptTarget
    editor: () => HTMLElement | undefined
    focusEditor: () => void
    addPart: (part: PromptInputV2Prompt[number]) => boolean
    setDraggingType: (type: Option.Option<"image" | "@mention">) => void
  },
) {
  const capture = (): Option.Option<AttachmentTarget> => {
    const prompt = input.capture()
    return Option.map(Option.fromNullishOr(input.editor()), (editor) => ({
      prompt,
      cursor: prompt.cursor() ?? cursorPosition(editor),
    }))
  }
  const add = (file: File, toast = true, target = capture(), clipboard = false): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (Option.isNone(target)) return false
      const mime = yield* attachmentMime(file)
      if (Option.isNone(mime)) {
        if (toast) input.warn()
        return false
      }
      const store = input.store
      const blob = store ? yield* Effect.promise(() => store(file)) : yield* blobReference(file)
      const sourcePath = Option.fromNullishOr(input.getPathForFile?.(file)).pipe(Option.filter((path) => path !== ""))
      // Native clipboard images arrive with a fresh timestamped filename on every paste, so identical
      // clipboard content is matched on bytes alone.
      const duplicate = target.value.prompt.current().some(
        (part) =>
          part.type === "image" &&
          part.blob.id === blob.id &&
          Option.match(sourcePath, {
            onSome: (path) => part.sourcePath === path,
            onNone: () => !part.sourcePath && (clipboard || part.filename === file.name),
          }),
      )
      if (duplicate) {
        input.duplicate()
        return true
      }
      const id = globalThis.crypto?.randomUUID?.() ?? (yield* Random.next).toString(16).slice(2)
      const attachment: PromptInputV2Attachment = {
        type: "image",
        id,
        filename: file.name,
        sourcePath: Option.getOrUndefined(sourcePath),
        mime: mime.value,
        blob,
      }
      target.value.prompt.set([...target.value.prompt.current(), attachment], target.value.cursor)
      return true
    })
  // Adds the files one after another and reports whether any of them was accepted.
  const addAll = (files: ReadonlyArray<File>, toast: boolean, target: Option.Option<AttachmentTarget>) =>
    Effect.gen(function* () {
      const found = yield* Effect.reduce(
        files,
        () => false,
        (previous, file) => add(file, false, target).pipe(Effect.map((added) => added || previous)),
      )
      if (!found && files.length > 0 && toast) input.warn()
      return found
    })
  const pasteText = (plainText: string) => {
    const text = plainText.includes("\r") ? plainText.replace(/\r\n?/g, "\n") : plainText
    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }
    if (text.includes("\n") || largePaste(text)) {
      put()
      return
    }
    if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) return
    put()
  }
  // Runs the synchronous part of a paste while the event dispatches (preventDefault, clipboard reads,
  // text insertion) and returns the asynchronous rest as an Effect.
  const startPaste = (event: ClipboardEvent): Effect.Effect<void> => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return Effect.void
    const target = capture()
    if (Option.isNone(target)) return Effect.void
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })
    if (files.length > 0) return Effect.asVoid(addAll(files, true, target))
    const plainText = clipboardData.getData("text/plain") ?? ""
    const readClipboardImage = input.readClipboardImage
    if (readClipboardImage && !plainText) {
      return Effect.promise(() => readClipboardImage()).pipe(
        Effect.flatMap((file) => (file ? add(file, true, target, true) : Effect.succeed(false))),
        Effect.asVoid,
      )
    }
    if (plainText) pasteText(plainText)
    return Effect.void
  }
  // Runs the synchronous part of a drop while the event dispatches and returns the file reads as an Effect.
  const startDrop = (event: DragEvent): Effect.Effect<void> => {
    if (input.isDialogActive()) return Effect.void
    event.preventDefault()
    input.setDraggingType(Option.none())
    const plainText = event.dataTransfer?.getData("text/plain")
    if (plainText?.startsWith("file:")) {
      const path = plainText.slice("file:".length)
      input.focusEditor()
      input.addPart({ type: "file", path, content: `@${path}`, start: 0, end: 0 })
      return Effect.void
    }
    const files = event.dataTransfer?.files
    if (!files) return Effect.void
    return Effect.asVoid(addAll(Array.from(files), true, capture()))
  }
  const handleDrop = (event: DragEvent) => Effect.runPromise(startDrop(event))

  onMount(() => {
    makeEventListener(document, "dragover", (event) => {
      if (input.isDialogActive()) return
      event.preventDefault()
      if (event.dataTransfer?.types.includes("Files")) input.setDraggingType(Option.some("image"))
      else if (event.dataTransfer?.types.includes("text/plain")) input.setDraggingType(Option.some("@mention"))
    })
    makeEventListener(document, "dragleave", (event) => {
      if (!input.isDialogActive() && !event.relatedTarget) input.setDraggingType(Option.none())
    })
    makeEventListener(document, "drop", handleDrop)
  })

  return {
    addAttachments: (files: File[], toast = true, target = capture()) =>
      Effect.runPromise(addAll(files, toast, target)),
    handlePaste: (event: ClipboardEvent) => Effect.runPromise(startPaste(event)),
    handleDrop,
    pick: (fallback: () => void) => {
      if (!input.picker) {
        fallback()
        return
      }
      void input
        .picker({ defaultPath: input.directory(), multiple: true, accept: accepted }, (file) =>
          Effect.runPromise(add(file)),
        )
        .catch(input.onError)
    },
  }
}

const imageMimes = HashSet.fromIterable(["image/png", "image/jpeg", "image/gif", "image/webp"])

function blobReference(file: File): Effect.Effect<{ id: string; url: string }> {
  return Effect.gen(function* () {
    const bytes = yield* Effect.promise(() => file.arrayBuffer())
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes))
    const id = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    return { id, url: URL.createObjectURL(file) }
  })
}
const imageExtensions = HashMap.fromIterable([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const textMimes = HashSet.fromIterable([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

function attachmentMime(file: File): Effect.Effect<Option.Option<string>> {
  return Effect.gen(function* () {
    const type = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (HashSet.has(imageMimes, type) || type === "application/pdf") return Option.some(type)
    const index = file.name.lastIndexOf(".")
    const suffix = index === -1 ? "" : file.name.slice(index + 1).toLowerCase()
    const fallback = HashMap.get(imageExtensions, suffix).pipe(
      Option.orElse(() => (suffix === "pdf" ? Option.some("application/pdf") : Option.none())),
    )
    if ((!type || type === "application/octet-stream") && Option.isSome(fallback)) return fallback
    if (type.startsWith("text/") || HashSet.has(textMimes, type) || type.endsWith("+json") || type.endsWith("+xml")) {
      return Option.some("text/plain")
    }
    const bytes = new Uint8Array(yield* Effect.promise(() => file.slice(0, 4096).arrayBuffer()))
    if (bytes.some((byte) => byte === 0)) return Option.none()
    const control = bytes.filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length
    if (bytes.length > 0 && control / bytes.length > 0.3) return Option.none()
    return Option.some("text/plain")
  })
}

function cursorPosition(editor: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return 0
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().replace(/\u200B/g, "").length
}

function largePaste(text: string) {
  if (text.length >= 8000) return true
  return text.split("\n").length - 1 >= 120
}

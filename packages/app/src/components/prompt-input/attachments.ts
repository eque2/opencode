import { Effect, Option } from "effect"
import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@/utils/toast"
import { type ContentPart, type ImageAttachmentPart, type usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { createBlobReference, type DraftStore } from "@/utils/draft-store"
import { attachmentMime } from "./files"
import { normalizePaste, pasteMode } from "./paste"

type PromptTarget = Pick<ReturnType<ReturnType<typeof usePrompt>["capture"]>, "current" | "cursor" | "set">
type AttachmentTarget = { prompt: PromptTarget; cursor: number }

type PromptAttachmentsCoreInput = {
  capture: () => PromptTarget
  editor: () => HTMLDivElement | undefined
  focusEditor?: () => void
  addPart?: (part: ContentPart) => boolean
  warn?: () => void
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
  draftStore?: DraftStore
}

export type PromptAttachmentsInput = {
  prompt: ReturnType<typeof usePrompt>
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
}

export function createPromptAttachmentsCore(input: PromptAttachmentsCoreInput) {
  // Reads the prompt and the cursor when the user acts, so a slow file read still lands in that prompt.
  const capture = (): Option.Option<AttachmentTarget> => {
    const prompt = input.capture()
    return Option.map(Option.fromNullishOr(input.editor()), (editor) => ({
      prompt,
      cursor: prompt.cursor() ?? getCursorPosition(editor),
    }))
  }

  const add = (file: File, toast: boolean, target: Option.Option<AttachmentTarget>): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (Option.isNone(target)) return false
      const mime = yield* attachmentMime(file)
      if (Option.isNone(mime)) {
        if (toast) input.warn?.()
        return false
      }

      const draftStore = input.draftStore
      const attachment: ImageAttachmentPart = {
        type: "image",
        id: uuid(),
        filename: file.name,
        sourcePath: input.getPathForFile?.(file) || undefined,
        mime: mime.value,
        blob: yield* Effect.promise(() => (draftStore ? draftStore.putBlob(file) : createBlobReference(file))),
      }
      target.value.prompt.set([...target.value.prompt.current(), attachment], target.value.cursor)
      return true
    })

  // Adds the files one after another and reports whether any of them was accepted.
  const addAll = (files: ReadonlyArray<File>, toast: boolean, target: Option.Option<AttachmentTarget>) =>
    Effect.gen(function* () {
      const added = yield* Effect.forEach(files, (file) => add(file, false, target))
      const found = added.some(Boolean)
      if (!found && files.length > 0 && toast) input.warn?.()
      return found
    })

  const addClipboard = (pending: Promise<File | null>, target: Option.Option<AttachmentTarget>) =>
    Effect.promise(() => pending).pipe(
      Effect.flatMap((file) => (file ? add(file, true, target) : Effect.succeed(false))),
    )

  const removeAttachment = (id: string) => {
    const target = input.capture()
    const current = target.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    target.set(next, target.cursor())
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

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    const readClipboardImage = input.readClipboardImage
    if (readClipboardImage && !plainText) return Effect.asVoid(addClipboard(readClipboardImage(), target))

    if (!plainText) return Effect.void

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart?.({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor?.()
      return input.addPart?.({ type: "text", content: text, start: 0, end: 0 }) ?? false
    }

    if (pasteMode(text) === "manual") {
      put()
      return Effect.void
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return Effect.void

    put()
    return Effect.void
  }

  return {
    addAttachment: (file: File) => Effect.runPromise(add(file, true, capture())),
    addAttachments: (files: ReadonlyArray<File>) => Effect.runPromise(addAll(files, true, capture())),
    addClipboardAttachment: (pending: Promise<File | null>) => Effect.runPromise(addClipboard(pending, capture())),
    // Captures the prompt target now and returns the Effect that adds the files to it.
    attachFiles: (files: ReadonlyArray<File>) => addAll(files, true, capture()),
    removeAttachment,
    handlePaste: (event: ClipboardEvent) => Effect.runPromise(startPaste(event)),
  }
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const language = useLanguage()
  const platform = usePlatform()
  const attachments = createPromptAttachmentsCore({
    ...input,
    draftStore: platform.draftStore,
    capture: input.prompt.capture,
    warn: () => {
      showToast({
        title: language.t("prompt.toast.pasteUnsupported.title"),
        description: language.t("prompt.toast.pasteUnsupported.description"),
      })
    },
  })

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  // Runs the synchronous part of a drop while the event dispatches and returns the file reads as an Effect.
  const startDrop = (event: DragEvent): Effect.Effect<void> => {
    if (input.isDialogActive()) return Effect.void

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return Effect.void
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return Effect.void

    return Effect.asVoid(attachments.attachFiles(Array.from(dropped)))
  }

  const handleGlobalDrop = (event: DragEvent) => Effect.runPromise(startDrop(event))

  onMount(() => {
    makeEventListener(document, "dragover", handleGlobalDragOver)
    makeEventListener(document, "dragleave", handleGlobalDragLeave)
    makeEventListener(document, "drop", handleGlobalDrop)
  })

  return attachments
}

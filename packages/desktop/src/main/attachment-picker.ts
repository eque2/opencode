import { randomUUID } from "node:crypto"
import { NodeFileSystem } from "@effect/platform-node"
import { Data, Effect, FileSystem, MutableHashMap, MutableHashSet, Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { nativeT } from "./native-translations"

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export class AttachmentPickerError extends Data.TaggedError("AttachmentPickerError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export function createPickedFileAuthorizations(
  read: (path: string, maxBytes: number) => Effect.Effect<ArrayBuffer, AttachmentPickerError> = readAttachment,
  budget = MAX_ATTACHMENT_BYTES,
) {
  const selections = MutableHashMap.empty<
    string,
    { sender: number; paths: MutableHashSet.MutableHashSet<string>; remaining: number }
  >()

  return {
    add(sender: number, paths: string[]) {
      const token = randomUUID()
      MutableHashMap.set(selections, token, {
        sender,
        paths: MutableHashSet.fromIterable(paths),
        remaining: budget,
      })
      return token
    },
    read: (sender: number, token: string, path: string) =>
      Effect.gen(function* () {
        const selection = Option.filter(
          MutableHashMap.get(selections, token),
          (item) => item.sender === sender && MutableHashSet.has(item.paths, path),
        )
        if (Option.isNone(selection))
          return yield* new AttachmentPickerError({ message: nativeT("desktop.picker.error.notSelected") })
        MutableHashSet.remove(selection.value.paths, path)
        const bytes = yield* read(path, selection.value.remaining)
        selection.value.remaining -= bytes.byteLength
        if (MutableHashSet.size(selection.value.paths) === 0) MutableHashMap.remove(selections, token)
        return bytes
      }),
    release(sender: number, token: string) {
      const selection = MutableHashMap.get(selections, token)
      if (Option.isSome(selection) && selection.value.sender === sender) MutableHashMap.remove(selections, token)
    },
  }
}

const sizeLimitError = () =>
  new AttachmentPickerError({
    message: nativeT("desktop.picker.error.sizeLimit", { limit: MAX_ATTACHMENT_BYTES / 1024 / 1024 }),
  })

export const assertAttachmentBudget = (files: { size: number }[]) =>
  files.reduce((sum, file) => sum + file.size, 0) <= MAX_ATTACHMENT_BYTES ? Effect.void : Effect.fail(sizeLimitError())

export const readAttachment = (filePath: string, maxBytes = MAX_ATTACHMENT_BYTES) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = yield* fs.open(filePath, { flag: "r" }).pipe(Effect.mapError(fileError))
    const info = yield* file.stat.pipe(Effect.mapError(fileError))
    const size = Number(info.size)
    if (size > maxBytes) return yield* sizeLimitError()
    const bytes = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      // The handle keeps its own read position, so each read fills the rest of the buffer.
      const bytesRead = yield* file.read(bytes.subarray(offset)).pipe(Effect.mapError(fileError))
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + offset)
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))

// The IPC boundary forwards the message to the renderer, so a filesystem failure keeps the Node.js message text,
// which PlatformError keeps as its cause.
const fileError = (error: PlatformError) =>
  new AttachmentPickerError({
    message: error.cause instanceof Error ? error.cause.message : error.message,
    cause: error.cause ?? error,
  })

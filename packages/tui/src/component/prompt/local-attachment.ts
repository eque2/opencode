import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, FileSystem, Option } from "effect"
import path from "node:path"

export type LocalFiles = Readonly<{
  readText(path: string): Effect.Effect<string, unknown>
  readBytes(path: string): Effect.Effect<Uint8Array, unknown>
  mime(path: string): Effect.Effect<string, unknown>
}>

export type LocalAttachment =
  | Readonly<{ type: "text"; mime: "image/svg+xml"; content: string }>
  | Readonly<{ type: "binary"; mime: string; content: Uint8Array }>

// The prompt paste handler reads an unsupported or unreadable file as undefined.
export function readLocalAttachment(file: string): Promise<LocalAttachment | undefined> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const attachment = yield* readLocalAttachmentWith(
        {
          readText: (value) => fs.readFileString(value, "utf8"),
          readBytes: (value) => fs.readFile(value),
          mime: (value) =>
            Effect.succeed(mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream"),
        },
        file,
      )
      return Option.getOrUndefined(attachment)
    }).pipe(Effect.provide(LayerNode.compile(LayerNodePlatform.filesystem))),
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

// A failed read, an empty MIME type or empty SVG text gives no attachment.
export function readLocalAttachmentWith(files: LocalFiles, file: string): Effect.Effect<Option.Option<LocalAttachment>> {
  return Effect.gen(function* () {
    const mime = Option.filter(yield* Effect.option(files.mime(file)), (value) => value.length > 0)
    if (Option.isNone(mime)) return Option.none()
    if (mime.value === "image/svg+xml") {
      const text = Option.filter(yield* Effect.option(files.readText(file)), (value) => value.length > 0)
      return Option.map(text, (content): LocalAttachment => ({ type: "text", mime: "image/svg+xml", content }))
    }
    if (!mime.value.startsWith("image/") && mime.value !== "application/pdf") return Option.none()
    const bytes = yield* Effect.option(files.readBytes(file))
    return Option.map(bytes, (content): LocalAttachment => ({ type: "binary", mime: mime.value, content }))
  })
}

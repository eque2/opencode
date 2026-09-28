import { Effect, HashMap, HashSet, Option } from "effect"
import { ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export { ACCEPTED_FILE_TYPES }

type AttachmentPicker = (
  options: {
    defaultPath?: string
    multiple?: boolean
    accept?: string[]
  },
  onFile: (file: File) => Promise<unknown>,
) => Promise<void>

export function pickAttachmentFiles(input: {
  picker?: AttachmentPicker
  directory: () => string
  fallback: () => void
  onFile: (file: File) => Promise<unknown>
  onError: (error: unknown) => void
}) {
  if (!input.picker) {
    input.fallback()
    return
  }
  void input
    .picker(
      {
        defaultPath: input.directory(),
        multiple: true,
        accept: ACCEPTED_FILE_TYPES,
      },
      input.onFile,
    )
    .catch(input.onError)
}

const IMAGE_MIMES = HashSet.fromIterable(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = HashMap.fromIterable([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = HashSet.fromIterable([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (HashSet.has(TEXT_MIMES, type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export function attachmentMime(file: File): Effect.Effect<Option.Option<string>> {
  return Effect.gen(function* () {
    const type = kind(file.type)
    if (HashSet.has(IMAGE_MIMES, type)) return Option.some(type)
    if (type === "application/pdf") return Option.some(type)

    const suffix = ext(file.name)
    const fallback = HashMap.get(IMAGE_EXTS, suffix).pipe(
      Option.orElse(() => (suffix === "pdf" ? Option.some("application/pdf") : Option.none())),
    )
    if ((!type || type === "application/octet-stream") && Option.isSome(fallback)) return fallback

    if (textMime(type)) return Option.some("text/plain")
    const bytes = new Uint8Array(yield* Effect.promise(() => file.slice(0, SAMPLE).arrayBuffer()))
    if (!textBytes(bytes)) return Option.none()
    return Option.some("text/plain")
  })
}

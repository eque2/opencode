import { HashSet, Option, Predicate, Result } from "effect"

export type MediaKind = "image" | "audio" | "svg"

const imageExtensions = HashSet.make("png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff", "heic")
const audioExtensions = HashSet.make("mp3", "wav", "ogg", "m4a", "aac", "flac", "opus")

type MediaValue = unknown

// A FileContent-like record read from untrusted media input; each field is
// checked before use.
type MediaRecord = { readonly [key: PropertyKey]: unknown }

function mediaRecord(value: MediaValue): Option.Option<MediaRecord> {
  return Option.liftPredicate(value, Predicate.isObject)
}

function recordMimeType(record: MediaRecord): Option.Option<string> {
  return Option.liftPredicate(record.mimeType, Predicate.isString).pipe(Option.flatMap(normalizeMimeType))
}

export function normalizeMimeType(type: string): Option.Option<string> {
  const mime = type.split(";", 1)[0]?.trim().toLowerCase()
  if (!mime) return Option.none()
  if (mime === "audio/x-aac") return Option.some("audio/aac")
  if (mime === "audio/x-m4a") return Option.some("audio/mp4")
  return Option.some(mime)
}

export function fileExtension(path: string | undefined) {
  if (!path) return ""
  const idx = path.lastIndexOf(".")
  if (idx === -1) return ""
  return path.slice(idx + 1).toLowerCase()
}

export function mediaKindFromPath(path: string | undefined): Option.Option<MediaKind> {
  const ext = fileExtension(path)
  if (ext === "svg") return Option.some("svg")
  if (HashSet.has(imageExtensions, ext)) return Option.some("image")
  if (HashSet.has(audioExtensions, ext)) return Option.some("audio")
  return Option.none()
}

export function isBinaryContent(value: MediaValue) {
  return Option.exists(mediaRecord(value), (record) => record.type === "binary")
}

function validDataUrl(value: string, kind: MediaKind): Option.Option<string> {
  if (kind === "svg") return value.startsWith("data:image/svg+xml") ? Option.some(value) : Option.none()
  if (kind === "image") return value.startsWith("data:image/") ? Option.some(value) : Option.none()
  if (value.startsWith("data:audio/x-aac;")) return Option.some(value.replace("data:audio/x-aac;", "data:audio/aac;"))
  if (value.startsWith("data:audio/x-m4a;")) return Option.some(value.replace("data:audio/x-m4a;", "data:audio/mp4;"))
  if (value.startsWith("data:audio/")) return Option.some(value)
  return Option.none()
}

export function dataUrlFromMediaValue(value: MediaValue, kind: MediaKind): Option.Option<string> {
  if (!value) return Option.none()

  if (typeof value === "string") {
    return validDataUrl(value, kind)
  }

  return mediaRecord(value).pipe(Option.flatMap((record) => dataUrlFromRecord(record, kind)))
}

function dataUrlFromRecord(record: MediaRecord, kind: MediaKind): Option.Option<string> {
  const content = record.content
  if (typeof content !== "string") return Option.none()

  const found = recordMimeType(record)
  if (Option.isNone(found)) return Option.none()
  const mime = found.value

  if (kind === "svg") {
    if (mime !== "image/svg+xml") return Option.none()
    if (record.encoding === "base64") return Option.some(`data:image/svg+xml;base64,${content}`)
    return Option.some(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`)
  }

  if (kind === "image" && !mime.startsWith("image/")) return Option.none()
  if (kind === "audio" && !mime.startsWith("audio/")) return Option.none()
  if (record.encoding !== "base64") return Option.none()

  return Option.some(`data:${mime};base64,${content}`)
}

function decodeBase64Utf8(value: string): Option.Option<string> {
  if (typeof atob !== "function") return Option.none()

  // atob throws on malformed base64; a malformed payload has no SVG text.
  return Result.getSuccess(
    Result.try(() => {
      const raw = atob(value)
      const bytes = Uint8Array.from(raw, (x) => x.charCodeAt(0))
      if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes)
      return raw
    }),
  )
}

export function svgTextFromValue(value: MediaValue): Option.Option<string> {
  return mediaRecord(value).pipe(Option.flatMap(svgTextFromRecord))
}

function svgTextFromRecord(record: MediaRecord): Option.Option<string> {
  const content = record.content
  if (typeof content !== "string") return Option.none()
  if (!Option.contains(recordMimeType(record), "image/svg+xml")) return Option.none()
  if (record.encoding === "base64") return decodeBase64Utf8(content)
  return Option.some(content)
}

export function hasMediaValue(value: MediaValue) {
  if (typeof value === "string") return value.length > 0
  return Option.exists(mediaRecord(value), (record) => typeof record.content === "string" && record.content.length > 0)
}

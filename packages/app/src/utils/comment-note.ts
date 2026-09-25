import { Option, Predicate } from "effect"
import type { FileSelection } from "@/context/file"

export type PromptComment = {
  path: string
  selection?: FileSelection
  comment: string
  preview?: string
  origin?: "review" | "file"
}

/** Reads one coordinate of stored comment metadata with Number() coercion; a missing key reads as NaN. */
function coordinate(value: object, key: keyof FileSelection) {
  return Number(Predicate.hasProperty(value, key) ? value[key] : Number.NaN)
}

function selection(selection: unknown): Option.Option<FileSelection> {
  if (!selection || typeof selection !== "object") return Option.none()
  const startLine = coordinate(selection, "startLine")
  const startChar = coordinate(selection, "startChar")
  const endLine = coordinate(selection, "endLine")
  const endChar = coordinate(selection, "endChar")
  if (![startLine, startChar, endLine, endChar].every(Number.isFinite)) return Option.none()
  return Option.some({
    startLine,
    startChar,
    endLine,
    endChar,
  })
}

export function createCommentMetadata(input: PromptComment) {
  return {
    opencodeComment: {
      path: input.path,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
      origin: input.origin,
    },
  }
}

export function readCommentMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { opencodeComment?: unknown }).opencodeComment
  if (!meta || typeof meta !== "object") return
  const path = (meta as { path?: unknown }).path
  const comment = (meta as { comment?: unknown }).comment
  if (typeof path !== "string" || typeof comment !== "string") return
  const preview = (meta as { preview?: unknown }).preview
  const origin = (meta as { origin?: unknown }).origin
  const range = selection((meta as { selection?: unknown }).selection)
  return {
    path,
    comment,
    ...Option.match(range, { onNone: () => ({}), onSome: (selection) => ({ selection }) }),
    ...(typeof preview === "string" ? { preview } : {}),
    ...(origin === "review" || origin === "file" ? { origin } : {}),
  } satisfies PromptComment
}

export function formatCommentNote(input: { path: string; selection?: FileSelection; comment: string }) {
  const range = Option.fromNullishOr(input.selection).pipe(
    Option.map((selection) => {
      const start = Math.min(selection.startLine, selection.endLine)
      const end = Math.max(selection.startLine, selection.endLine)
      return start === end ? `line ${start}` : `lines ${start} through ${end}`
    }),
    Option.getOrElse(() => "this file"),
  )
  return `The user made the following comment regarding ${range} of ${input.path}: ${input.comment}`
}

export function parseCommentNote(text: string) {
  const match = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  )
  if (!match) return
  // "line N" fills group 2; "lines N through M" fills groups 3 and 4; "this file" fills neither.
  const lines = match[2]
    ? Option.some({ start: Number(match[2]), end: Number(match[2]) })
    : match[3] && match[4]
      ? Option.some({ start: Number(match[3]), end: Number(match[4]) })
      : Option.none<{ start: number; end: number }>()
  return {
    path: match[5],
    comment: match[6],
    ...Option.match(lines, {
      onNone: () => ({}),
      onSome: (range) => ({
        selection: {
          startLine: range.start,
          startChar: 0,
          endLine: range.end,
          endChar: 0,
        },
      }),
    }),
  } satisfies PromptComment
}

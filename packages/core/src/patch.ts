export * as Patch from "./patch"

import { Result, Schema } from "effect"

/** The patch text does not follow the apply_patch grammar. */
export class ParseError extends Schema.TaggedError<ParseError>()("Patch.ParseError", {
  message: Schema.String,
}) {}

/** An update chunk does not match the current file content. */
export class MatchError extends Schema.TaggedError<MatchError>()("Patch.MatchError", {
  message: Schema.String,
}) {}

export type Hunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
      readonly type: "update"
      readonly path: string
      readonly movePath?: string
      readonly chunks: ReadonlyArray<UpdateFileChunk>
    }

export interface UpdateFileChunk {
  readonly oldLines: ReadonlyArray<string>
  readonly newLines: ReadonlyArray<string>
  readonly changeContext?: string
  readonly endOfFile?: boolean
}

export interface FileUpdate {
  readonly content: string
  readonly bom: boolean
}

const invalid = (message: string) => Result.fail(new ParseError({ message }))

export function parse(patchText: string): Result.Result<ReadonlyArray<Hunk>, ParseError> {
  return Result.gen(function* () {
    const lines = stripHeredoc(patchText.trim()).split("\n")
    const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
    const end = lines.findIndex((line) => line.trim() === "*** End Patch")
    if (begin === -1 || end === -1 || begin >= end)
      return yield* invalid("Invalid patch format: missing Begin/End markers")

    let hunks: ReadonlyArray<Hunk> = []
    let index = begin + 1
    while (index < end) {
      const line = lines[index]!
      if (line.startsWith("*** Add File:")) {
        const path = line.slice("*** Add File:".length).trim()
        if (!path) return yield* invalid("Invalid add file path")
        const parsed = yield* parseAdd(lines, index + 1)
        hunks = [...hunks, { type: "add", path, contents: parsed.content }]
        index = parsed.next
        continue
      }
      if (line.startsWith("*** Delete File:")) {
        const path = line.slice("*** Delete File:".length).trim()
        if (!path) return yield* invalid("Invalid delete file path")
        hunks = [...hunks, { type: "delete", path }]
        index++
        continue
      }
      if (line.startsWith("*** Update File:")) {
        const path = line.slice("*** Update File:".length).trim()
        if (!path) return yield* invalid("Invalid update file path")
        let next = index + 1
        let movePath: string | undefined
        if (lines[next]?.startsWith("*** Move to:")) {
          movePath = lines[next]!.slice("*** Move to:".length).trim()
          if (!movePath) return yield* invalid("Invalid move file path")
          next++
        }
        const parsed = yield* parseUpdate(lines, next)
        if (parsed.chunks.length === 0)
          return yield* invalid(`Invalid update hunk for ${path}: expected at least one @@ chunk`)
        hunks = [...hunks, { type: "update", path, movePath, chunks: parsed.chunks }]
        index = parsed.next
        continue
      }
      return yield* invalid(`Invalid patch line: ${line}`)
    }
    return hunks
  })
}

export function derive(
  path: string,
  chunks: ReadonlyArray<UpdateFileChunk>,
  original: string,
): Result.Result<FileUpdate, MatchError> {
  return Result.gen(function* () {
    const source = splitBom(original)
    const split = source.text.split("\n")
    const lines = split.at(-1) === "" ? split.slice(0, -1) : split
    const replacements = yield* computeReplacements(lines, path, chunks)
    const updated = replacements
      .toReversed()
      .reduce((result, [start, remove, insert]) => result.toSpliced(start, remove, ...insert), lines)
    const next = splitBom([...updated, ...(updated.at(-1) === "" ? [] : [""])].join("\n"))
    return { content: next.text, bom: source.bom || next.bom }
  })
}

export function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

/** Returns the first index at or after `start` whose line matches, or the line count. */
function findFrom(lines: ReadonlyArray<string>, start: number, predicate: (line: string) => boolean) {
  const offset = lines.slice(start).findIndex(predicate)
  return offset === -1 ? lines.length : start + offset
}

function parseAdd(lines: ReadonlyArray<string>, start: number) {
  return Result.gen(function* () {
    const next = findFrom(lines, start, (line) => line.startsWith("***"))
    const body = lines.slice(start, next)
    const bad = body.findIndex((line) => !line.startsWith("+"))
    if (bad !== -1) return yield* invalid(`Invalid add file line: ${body[bad]}`)
    return { content: body.map((line) => line.slice(1)).join("\n"), next }
  })
}

function parseUpdate(lines: ReadonlyArray<string>, start: number) {
  return Result.gen(function* () {
    let chunks: ReadonlyArray<UpdateFileChunk> = []
    let index = start
    while (index < lines.length && !lines[index]!.startsWith("***")) {
      const parsed = yield* parseChunk(lines, index)
      chunks = [...chunks, parsed.chunk]
      index = parsed.next
    }
    return { chunks, next: index }
  })
}

function parseChunk(lines: ReadonlyArray<string>, index: number) {
  return Result.gen(function* () {
    if (!lines[index]!.startsWith("@@")) {
      return yield* invalid(`Invalid update file line: ${lines[index]}`)
    }
    const changeContext = lines[index]!.slice(2).trim() || undefined
    const end = findFrom(lines, index + 1, (line) => line.startsWith("@@") || line.startsWith("***"))
    const body = lines.slice(index + 1, end)
    const bad = body.findIndex((line) => !line.startsWith(" ") && !line.startsWith("-") && !line.startsWith("+"))
    if (bad !== -1) return yield* invalid(`Invalid update chunk line: ${body[bad]}`)
    const endOfFile = lines[end] === "*** End of File"
    const chunk: UpdateFileChunk = {
      oldLines: body.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1)),
      newLines: body.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1)),
      changeContext,
      endOfFile: endOfFile || undefined,
    }
    return { chunk, next: endOfFile ? end + 1 : end }
  })
}

const mismatch = (message: string) => Result.fail(new MatchError({ message }))

type Replacement = readonly [start: number, remove: number, insert: ReadonlyArray<string>]

function computeReplacements(lines: ReadonlyArray<string>, path: string, chunks: ReadonlyArray<UpdateFileChunk>) {
  return Result.gen(function* () {
    let replacements: ReadonlyArray<Replacement> = []
    let lineIndex = 0
    for (const chunk of chunks) {
      if (chunk.changeContext) {
        const context = seek(lines, [chunk.changeContext], lineIndex)
        if (context === -1) return yield* mismatch(`Failed to find context '${chunk.changeContext}' in ${path}`)
        lineIndex = context + 1
      }
      if (chunk.oldLines.length === 0) {
        replacements = [...replacements, [lines.length, 0, chunk.newLines]]
        continue
      }
      let oldLines = chunk.oldLines
      let newLines = chunk.newLines
      let found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
      if (found === -1 && oldLines.at(-1) === "") {
        oldLines = oldLines.slice(0, -1)
        if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
        found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
      }
      if (found === -1)
        return yield* mismatch(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`)
      replacements = [...replacements, [found, oldLines.length, newLines]]
      lineIndex = found + oldLines.length
    }
    return replacements.toSorted((left, right) => left[0] - right[0])
  })
}

function seek(lines: ReadonlyArray<string>, pattern: ReadonlyArray<string>, start: number, eof = false) {
  if (pattern.length === 0) return -1
  for (const compare of [exact, rstrip, trim, normalized]) {
    if (eof) {
      const offset = lines.length - pattern.length
      if (offset >= start && matches(lines, pattern, offset, compare)) return offset
    }
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
  }
  return -1
}

function matches(
  lines: ReadonlyArray<string>,
  pattern: ReadonlyArray<string>,
  offset: number,
  compare: (left: string, right: string) => boolean,
) {
  return pattern.every((line, index) => compare(lines[offset + index]!, line))
}

const exact = (left: string, right: string) => left === right
const rstrip = (left: string, right: string) => left.trimEnd() === right.trimEnd()
const trim = (left: string, right: string) => left.trim() === right.trim()
const normalized = (left: string, right: string) => normalize(left.trim()) === normalize(right.trim())
const normalize = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const stripHeredoc = (input: string) =>
  input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)?.[2] ?? input

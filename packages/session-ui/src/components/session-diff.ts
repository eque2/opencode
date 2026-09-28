import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { parsePatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { Iterable, MutableHashMap, Option } from "effect"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type SnapshotDiff = SnapshotFileDiff & { file: string }
type ReviewDiff = SnapshotDiff | FileDiffInfo | VcsFileDiff | LegacyDiff
export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const diffCacheLimit = 16
// String keys keep insertion order, so the first key is the least recently used entry.
const patchFileDiffCache = MutableHashMap.empty<string, FileDiffMetadata>()

export function resolveFileDiff(diff: DiffSource) {
  if (typeof diff.patch === "string") return fileDiffFromPatch(diff.file, diff.patch)
  return fileDiffFromContent(
    diff.file,
    typeof diff.before === "string" ? diff.before : "",
    typeof diff.after === "string" ? diff.after : "",
  )
}

export function normalize(diff: ReviewDiff): ViewDiff {
  return {
    file: diff.file,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: resolveFileDiff(diff),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}

function fileDiffFromPatch(file: string, patch: string) {
  const key = `${file}\0${patch}`
  const hit = MutableHashMap.get(patchFileDiffCache, key)
  if (Option.isSome(hit)) {
    MutableHashMap.remove(patchFileDiffCache, key)
    MutableHashMap.set(patchFileDiffCache, key, hit.value)
    return hit.value
  }

  const value = Option.match(completePatchContents(patch), {
    onSome: (contents) => fileDiffFromContent(file, contents.before, contents.after),
    onNone: () =>
      patchInput(file, patch).pipe(
        Option.flatMap((input) => Option.fromNullishOr(parsePatchFiles(input)[0]?.files[0])),
        Option.getOrElse(() => emptyFileDiff(file)),
      ),
  })
  MutableHashMap.set(patchFileDiffCache, key, value)
  while (MutableHashMap.size(patchFileDiffCache) > diffCacheLimit) {
    const oldest = Iterable.head(MutableHashMap.keys(patchFileDiffCache))
    if (Option.isNone(oldest)) break
    MutableHashMap.remove(patchFileDiffCache, oldest.value)
  }
  return value
}

// parsePatch throws on a malformed patch. The lifted form returns None instead.
const parsePatchOption = Option.liftThrowable(parsePatch)

function firstPatch(patch: string) {
  return parsePatchOption(patch).pipe(Option.flatMap((patches) => Option.fromNullishOr(patches[0])))
}

function completePatchContents(patch: string): Option.Option<{ before: string; after: string }> {
  const first = firstPatch(patch)
  if (Option.isNone(first)) return Option.none()
  const parsed = first.value
  if (!parsed.index && !parsed.oldFileName && !parsed.newFileName) return Option.none()
  // Snapshot and VCS producers request full context. Tool patches use jsdiff's shorter default context.
  if (!patch.startsWith("diff --git ") && !/^--- [^\n]*\t\r?\n\+\+\+ [^\n]*\t(?:\r?\n|$)/m.test(patch)) return Option.none()
  // Full patches collapse into one leading hunk. Separated hunks omit ranges and must stay partial.
  if (parsed.hunks.length !== 1) return Option.none()

  const hunk = parsed.hunks[0]
  if (!hunk || hunk.oldStart > 1 || hunk.newStart > 1) return Option.none()

  const before: Array<{ text: string; newline: boolean }> = []
  const after: Array<{ text: string; newline: boolean }> = []
  let previous: "-" | "+" | " " | undefined

  for (const line of hunk.lines) {
    if (line.startsWith("\\")) {
      if (previous === "-" || previous === " ") {
        const value = before.at(-1)
        if (value) value.newline = false
      }
      if (previous === "+" || previous === " ") {
        const value = after.at(-1)
        if (value) value.newline = false
      }
      continue
    }
    if (line.startsWith("-")) {
      before.push({ text: line.slice(1), newline: true })
      previous = "-"
      continue
    }
    if (line.startsWith("+")) {
      after.push({ text: line.slice(1), newline: true })
      previous = "+"
      continue
    }
    if (!line.startsWith(" ")) return Option.none()
    before.push({ text: line.slice(1), newline: true })
    after.push({ text: line.slice(1), newline: true })
    previous = " "
  }

  const text = (lines: Array<{ text: string; newline: boolean }>) =>
    lines.map((line) => line.text + (line.newline ? "\n" : "")).join("")
  return Option.some({ before: text(before), after: text(after) })
}

function patchInput(file: string, patch: string): Option.Option<string> {
  return firstPatch(patch).pipe(
    Option.flatMap((parsed) => {
      if (parsed.index || parsed.oldFileName || parsed.newFileName) return Option.some(patch)
      if (!parsed.hunks.length) return Option.none()
      return Option.some(
        `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${patch}`,
      )
    }),
  )
}

function fileDiffFromContent(file: string, before: string, after: string) {
  if (!before && !after) return emptyFileDiff(file)
  return parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
}

function emptyFileDiff(file: string) {
  return parseDiffFromFile({ name: file, contents: "" }, { name: file, contents: "" })
}

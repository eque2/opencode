import { MutableHashMap, Option } from "effect"
import type { FileContent } from "@opencode-ai/sdk/v2"

const MAX_FILE_CONTENT_ENTRIES = 40
const MAX_FILE_CONTENT_BYTES = 20 * 1024 * 1024

const lru = MutableHashMap.empty<string, number>()
let total = 0

export function approxBytes(content: FileContent) {
  const patchBytes =
    content.patch?.hunks.reduce((sum, hunk) => {
      return sum + hunk.lines.reduce((lineSum, line) => lineSum + line.length, 0)
    }, 0) ?? 0

  return (content.content.length + (content.diff?.length ?? 0) + patchBytes) * 2
}

// MutableHashMap keeps insertion order for string keys, so removing and
// setting a path moves it to the most recently used end.
function setBytes(path: string, nextBytes: number) {
  const prev = MutableHashMap.get(lru, path)
  if (Option.isSome(prev)) total -= prev.value
  MutableHashMap.remove(lru, path)
  MutableHashMap.set(lru, path, nextBytes)
  total += nextBytes
}

function touch(path: string, bytes?: number) {
  const prev = MutableHashMap.get(lru, path)
  if (Option.isNone(prev) && bytes === undefined) return
  setBytes(path, bytes ?? Option.getOrElse(prev, () => 0))
}

function remove(path: string) {
  const prev = MutableHashMap.get(lru, path)
  if (Option.isNone(prev)) return
  MutableHashMap.remove(lru, path)
  total -= prev.value
}

function reset() {
  MutableHashMap.clear(lru)
  total = 0
}

export function evictContentLru(keep: Set<string> | undefined, evict: (path: string) => void) {
  const set = keep ?? new Set<string>()

  while (MutableHashMap.size(lru) > MAX_FILE_CONTENT_ENTRIES || total > MAX_FILE_CONTENT_BYTES) {
    const [path] = MutableHashMap.keys(lru)
    if (!path) return

    if (set.has(path)) {
      touch(path)
      if (MutableHashMap.size(lru) <= set.size) return
      continue
    }

    remove(path)
    evict(path)
  }
}

export function resetFileContentLru() {
  reset()
}

export function setFileContentBytes(path: string, bytes: number) {
  setBytes(path, bytes)
}

export function removeFileContentBytes(path: string) {
  remove(path)
}

export function touchFileContent(path: string, bytes?: number) {
  touch(path, bytes)
}

export function getFileContentBytesTotal() {
  return total
}

export function getFileContentEntryCount() {
  return MutableHashMap.size(lru)
}

export function hasFileContent(path: string) {
  return MutableHashMap.has(lru, path)
}

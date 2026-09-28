import path from "path"
import { Array as Arr, Option } from "effect"

// Strips a known prefix from an already-relative path. Callers should pass the
// path relative to the directory they scanned (e.g. `path.relative(dir, item)`)
// so the prefix match is anchored. Matching anywhere in an absolute path used
// to mis-key agents whose home/parent segments coincidentally contained one of
// the prefix names (see #25713).
function stripPrefix(relativePath: string, prefixes: string[]): Option.Option<string> {
  const normalized = relativePath.replaceAll("\\", "/")
  return Arr.findFirst(prefixes, (prefix) => normalized.startsWith(prefix)).pipe(
    Option.map((prefix) => normalized.slice(prefix.length)),
  )
}

export function configEntryNameFromPath(relativePath: string, prefixes: string[]) {
  const candidate = Option.getOrElse(stripPrefix(relativePath, prefixes), () => path.basename(relativePath))
  const ext = path.extname(candidate)
  return ext.length ? candidate.slice(0, -ext.length) : candidate
}

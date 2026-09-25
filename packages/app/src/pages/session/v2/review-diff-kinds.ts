import { HashMap, Option } from "effect"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Kind } from "@/components/file-tree-v2"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"

export type RenderDiff = FileDiffInfo | (SnapshotFileDiff & { file: string }) | VcsFileDiff

export function normalizePath(p: string) {
  return normalizeFileTreeV2Path(p)
}

export function filterRenderableDiff(value: FileDiffInfo | SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function reviewDiffNeedsLoad(diff: RenderDiff) {
  if (diff.additions === 0 && diff.deletions === 0) return false
  return !diff.patch || !/^@@ /m.test(diff.patch)
}

export function reviewRootDirectory(root: string) {
  return root === "/" || /^[A-Za-z]:[/\\]?$/.test(root) ? root : root.replace(/[/\\]+$/, "")
}

export function reviewDiffDirectory(root: string, file: string) {
  const path = normalizePath(file)
  const index = path.lastIndexOf("/")
  const separator = root.includes("\\") ? "\\" : "/"
  const base = reviewRootDirectory(root)
  if (index < 0) return base
  return `${base.endsWith(separator) ? base : base + separator}${path.slice(0, index).replaceAll("/", separator)}`
}

export function reviewDiffKinds(diffs: readonly RenderDiff[]): HashMap.HashMap<string, Kind> {
  const merge = (current: Option.Option<Kind>, kind: Kind): Kind =>
    Option.match(current, {
      onNone: () => kind,
      onSome: (value) => (value === kind ? value : "mix"),
    })

  return HashMap.mutate(HashMap.empty<string, Kind>(), (out) => {
    for (const diff of diffs) {
      const file = normalizePath(diff.file)
      const kind: Kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      HashMap.set(out, file, kind)

      const parts = file.split("/")
      parts.slice(0, -1).forEach((_, idx) => {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) return
        HashMap.set(out, dir, merge(HashMap.get(out, dir), kind))
      })
    }
  })
}

export function filterReviewFiles(files: string[], query: string) {
  const value = query.trim().toLowerCase()
  if (!value) return files
  return files.filter((file) => file.toLowerCase().includes(value))
}

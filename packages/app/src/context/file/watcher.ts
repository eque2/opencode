import { Option, Schema } from "effect"
import type { FileNode } from "@opencode-ai/sdk/v2"

type WatcherEvent = {
  type: string
  properties: unknown
}

const WatcherUpdate = Schema.Struct({ file: Schema.String, event: Schema.String }).annotate({
  identifier: "FileWatcher.Update",
})
const decodeWatcherUpdate = Schema.decodeUnknownOption(WatcherUpdate)

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => Option.Option<FileNode>
  isDirLoaded: (path: string) => boolean
  refreshDir: (path: string) => void
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type !== "file.watcher.updated") return
  const update = decodeWatcherUpdate(event.properties)
  if (Option.isNone(update)) return
  const rawPath = update.value.file
  const kind = update.value.event
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  if (!path) return
  if (path.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir =
      path === ""
        ? Option.some(path)
        : Option.liftPredicate(path, (p) => Option.exists(ops.node(p), (node) => node.type === "directory"))
    if (Option.isNone(dir)) return
    if (!ops.isDirLoaded(dir.value)) return
    ops.refreshDir(dir.value)
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = path.split("/").slice(0, -1).join("/")
  if (!ops.isDirLoaded(parent)) return

  ops.refreshDir(parent)
}

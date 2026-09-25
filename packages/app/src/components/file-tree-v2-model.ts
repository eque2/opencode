import { Array as Arr, Chunk, HashMap, MutableHashMap, Option } from "effect"
import type { FileNode } from "@opencode-ai/sdk/v2"

export type FileTreeV2Model = {
  children: HashMap.HashMap<string, readonly FileTreeV2Node[]>
  total: number
}

export type FileTreeV2Node = FileNode & { originalPath: string }

export type FileTreeV2Row = {
  node: FileTreeV2Node
  level: number
}

export function normalizeFileTreeV2Path(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

export function buildFileTreeV2Model(paths: readonly string[]): FileTreeV2Model {
  const nodes = MutableHashMap.empty<string, FileTreeV2Node>()

  paths.forEach((value) => {
    const file = normalizeFileTreeV2Path(value)
    if (!file) return

    const parts = file.split("/")
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/")
      if (MutableHashMap.has(nodes, path)) return
      MutableHashMap.set(nodes, path, {
        name,
        path,
        absolute: path,
        type: index === parts.length - 1 ? "file" : "directory",
        ignored: false,
        originalPath: index === parts.length - 1 ? value : path,
      })
    })
  })

  const siblings = Arr.groupBy(MutableHashMap.values(nodes), (node) => {
    const index = node.path.lastIndexOf("/")
    return index === -1 ? "" : node.path.slice(0, index)
  })
  const children = HashMap.fromIterable(
    Object.entries(siblings).map(
      ([parent, group]) =>
        [
          parent,
          group.toSorted((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
          }),
        ] as const,
    ),
  )

  return { children, total: MutableHashMap.size(nodes) }
}

export function flattenFileTreeV2(model: FileTreeV2Model, expanded: (path: string) => boolean) {
  let rows = Chunk.empty<FileTreeV2Row>()
  const stack = Option.getOrElse(HashMap.get(model.children, ""), () => [])
    .toReversed()
    .map((node) => ({ node, level: 0 }))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows = Chunk.append(rows, row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const children = Option.getOrElse(HashMap.get(model.children, row.node.path), () => [])
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index]!, level: row.level + 1 })
    }
  }

  return Chunk.toArray(rows)
}

export function flattenLiveFileTreeV2(
  children: (path: string) => readonly FileNode[],
  expanded: (path: string) => boolean,
) {
  let rows = Chunk.empty<FileTreeV2Row>()
  const stack = children("")
    .toReversed()
    .map((node) => ({ node: toLiveNode(node), level: 0 }))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows = Chunk.append(rows, row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const nested = children(row.node.originalPath)
    for (let index = nested.length - 1; index >= 0; index--) {
      stack.push({ node: toLiveNode(nested[index]!), level: row.level + 1 })
    }
  }

  return Chunk.toArray(rows)
}

function toLiveNode(node: FileNode): FileTreeV2Node {
  return {
    ...node,
    path: normalizeFileTreeV2Path(node.path),
    originalPath: node.path,
  }
}

// Paths branch softly through the screen,
// A quiet tree of changed designs;
// Each leaf remembers what has been,
// And waits where careful light aligns.

import { Array as Arr, HashMap, HashSet, MutableHashSet, Option, Order } from "effect"

export type FileTreeItem = {
  readonly file: string
  readonly status?: "added" | "deleted" | "modified"
}

export type FileTreeNode = {
  readonly id: number
  readonly name: string
  readonly parent: Option.Option<number>
  readonly children: readonly number[]
  readonly depth: number
  readonly kind: "directory" | "file"
  readonly fileIndex?: number
}

export type FileTree = {
  readonly roots: readonly number[]
  readonly nodes: readonly FileTreeNode[]
}

export type FileTreeRow = {
  readonly id: number
  readonly depth: number
  readonly kind: "directory" | "file"
  readonly name: string
  readonly fileIndex?: number
}

export type FileTreeFileSelection = {
  readonly highlightedNode: number
  readonly expandedNodes: readonly number[]
}

// One path segment of one changed file: a directory, or the file itself as the last segment.
type FileTreeEntry = {
  readonly path: string
  readonly parentPath: Option.Option<string>
  readonly name: string
  readonly depth: number
  readonly kind: "directory" | "file"
  readonly fileIndex?: number
}

export function buildFileTree(files: readonly FileTreeItem[]): FileTree {
  // Keep each directory where it first appears, so node ids follow the order in which the nodes first appear.
  const seenDirectories = MutableHashSet.empty<string>()
  const entries = files.flatMap(fileTreeEntries).filter((entry) => {
    if (entry.kind === "file") return true
    if (MutableHashSet.has(seenDirectories, entry.path)) return false
    MutableHashSet.add(seenDirectories, entry.path)
    return true
  })
  const directoryIds = HashMap.fromIterable(
    entries.flatMap(
      (entry, id): Array<readonly [string, number]> => (entry.kind === "directory" ? [[entry.path, id]] : []),
    ),
  )
  const order = fileTreeEntryOrder(entries)
  const childIds = Arr.groupBy(
    entries.flatMap((entry, id) => Option.toArray(Option.map(entry.parentPath, (parentPath) => ({ id, parentPath })))),
    (child) => child.parentPath,
  )
  const childrenOf = (entry: FileTreeEntry) =>
    entry.kind === "directory" && Object.hasOwn(childIds, entry.path)
      ? Arr.sort(
          childIds[entry.path].map((child) => child.id),
          order,
        )
      : []

  return {
    roots: Arr.sort(
      entries.flatMap((entry, id) => (Option.isNone(entry.parentPath) ? [id] : [])),
      order,
    ),
    nodes: entries.map((entry, id) => ({
      id,
      name: entry.name,
      parent: Option.flatMap(entry.parentPath, (parentPath) => HashMap.get(directoryIds, parentPath)),
      children: childrenOf(entry),
      depth: entry.depth,
      kind: entry.kind,
      ...(entry.fileIndex === undefined ? {} : { fileIndex: entry.fileIndex }),
    })),
  }
}

function fileTreeEntries(item: FileTreeItem, fileIndex: number): FileTreeEntry[] {
  const segments = item.file.split("/").filter(Boolean)
  return segments.map((name, depth): FileTreeEntry => {
    const path = segments.slice(0, depth + 1).join("/")
    const parentPath = depth === 0 ? Option.none<string>() : Option.some(segments.slice(0, depth).join("/"))
    return depth === segments.length - 1
      ? { path, parentPath, name, depth, kind: "file", fileIndex }
      : { path, parentPath, name, depth, kind: "directory" }
  })
}

// Directories come before files, then names sort by code unit, then the earlier node comes first.
function fileTreeEntryOrder(entries: ReadonlyArray<Pick<FileTreeEntry, "kind" | "name">>): Order.Order<number> {
  return Order.combineAll([
    Order.mapInput(Order.Boolean, (id: number) => entries[id].kind === "file"),
    Order.mapInput(Order.String, (id: number) => entries[id].name),
    Order.Number,
  ])
}

export function flattenFileTree(tree: FileTree, expanded?: HashSet.HashSet<number>): FileTreeRow[] {
  const visit = (id: number, depth: number): FileTreeRow[] => {
    const node = tree.nodes[id]
    if (node.kind === "file") {
      return [
        {
          id: node.id,
          depth,
          kind: node.kind,
          name: node.name,
          fileIndex: node.fileIndex,
        },
      ]
    }

    const chain = collapsedFileTreeDirectoryChain(tree, node.id)
    const row: FileTreeRow = {
      id: node.id,
      depth,
      kind: node.kind,
      name: chain.map((item) => item.name).join("/"),
      fileIndex: node.fileIndex,
    }
    if (expanded !== undefined && !HashSet.has(expanded, node.id)) return [row]
    return [row, ...Arr.lastNonEmpty(chain).children.flatMap((child) => visit(child, depth + 1))]
  }
  return tree.roots.flatMap((root) => visit(root, 0))
}

function collapsedFileTreeDirectoryChain(tree: FileTree, id: number): Arr.NonEmptyArray<FileTreeNode> {
  const node = tree.nodes[id]
  const onlyChild = node.children.length === 1 ? Arr.get(tree.nodes, node.children[0]) : Option.none<FileTreeNode>()
  return onlyChild.pipe(
    Option.filter((child) => child.kind === "directory"),
    Option.match({
      onNone: (): Arr.NonEmptyArray<FileTreeNode> => [node],
      onSome: (child): Arr.NonEmptyArray<FileTreeNode> => [node, ...collapsedFileTreeDirectoryChain(tree, child.id)],
    }),
  )
}

export function compareFileTreeNodes(tree: FileTree, left: number, right: number) {
  return fileTreeEntryOrder(tree.nodes)(left, right)
}

function rowIndex(rows: readonly FileTreeRow[], selected: Option.Option<number>) {
  return Option.flatMap(selected, (id) => Arr.findFirstIndex(rows, (row) => row.id === id))
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length - 1, index))
}

export function moveFileTreeSelection(
  rows: readonly FileTreeRow[],
  selected: Option.Option<number>,
  offset: number,
): Option.Option<number> {
  const index = Option.match(rowIndex(rows, selected), {
    onNone: () => 0,
    onSome: (current) => clampIndex(current + offset, rows.length),
  })
  return Option.map(Arr.get(rows, index), (row) => row.id)
}

export function moveFileTreeSelectionToFirstChild(
  rows: readonly FileTreeRow[],
  selected: Option.Option<number>,
): Option.Option<number> {
  return rowIndex(rows, selected).pipe(
    Option.filter((index) => rows[index].kind === "directory"),
    Option.flatMap((index) => Option.filter(Arr.get(rows, index + 1), (child) => child.depth > rows[index].depth)),
    Option.map((child) => child.id),
    Option.orElse(() => selected),
  )
}

export function moveFileTreeSelectionToParent(
  rows: readonly FileTreeRow[],
  selected: Option.Option<number>,
): Option.Option<number> {
  return rowIndex(rows, selected).pipe(
    Option.filter((index) => rows[index].depth !== 0),
    Option.flatMap((index) =>
      Arr.findLast(rows, (item, itemIndex) => itemIndex < index && item.depth < rows[index].depth),
    ),
    Option.map((parent) => parent.id),
    Option.orElse(() => selected),
  )
}

export function moveFileTreeSelectionToFile(
  rows: readonly FileTreeRow[],
  selected: Option.Option<number>,
  offset: number,
): Option.Option<number> {
  const fileRows = rows.flatMap((row, index) => (row.fileIndex === undefined ? [] : [{ id: row.id, index }]))
  const first = Arr.head(fileRows)
  const last = Arr.last(fileRows)
  const next = Option.match(rowIndex(rows, selected), {
    onNone: () => (offset < 0 ? last : first),
    onSome: (selectedIndex) =>
      (offset < 0
        ? Arr.findLast(fileRows, (row) => row.index < selectedIndex)
        : Arr.findFirst(fileRows, (row) => row.index > selectedIndex)
      ).pipe(Option.orElse(() => (offset < 0 ? first : last))),
  })
  return Option.map(next, (row) => row.id)
}

export function fileTreeFileSelection(tree: FileTree, fileIndex: number): Option.Option<FileTreeFileSelection> {
  return Arr.findFirst(tree.nodes, (item) => item.kind === "file" && item.fileIndex === fileIndex).pipe(
    Option.map((node) => ({
      highlightedNode: node.id,
      expandedNodes: fileTreeParentDirectories(tree, node.id),
    })),
  )
}

export function singlePatchFileIndex(
  selected: Option.Option<number>,
  active: Option.Option<number>,
  current: Option.Option<number>,
  first: Option.Option<number>,
): Option.Option<number> {
  return Option.firstSomeOf([selected, active, current, first])
}

export function orderedPatchFileIndexes(rows: readonly FileTreeRow[]) {
  return rows.flatMap((row) => (row.fileIndex === undefined ? [] : [row.fileIndex]))
}

export function showDiffViewerFileTree(showFileTree: boolean, fileCount: number) {
  return showFileTree && fileCount > 0
}

export function movePatchFileIndex(
  fileIndexes: readonly number[],
  current: Option.Option<number>,
  offset: number,
): Option.Option<number> {
  const index = Option.match(
    Option.flatMap(current, (value) => Arr.findFirstIndex(fileIndexes, (item) => item === value)),
    {
      onNone: () => 0,
      onSome: (currentIndex) => clampIndex(currentIndex + offset, fileIndexes.length),
    },
  )
  return Arr.get(fileIndexes, index)
}

export function allExpandedFileTreeDirectories(tree: FileTree): HashSet.HashSet<number> {
  return HashSet.fromIterable(tree.nodes.filter((node) => node.kind === "directory").map((node) => node.id))
}

function selectedDirectory(tree: FileTree, selected: Option.Option<number>) {
  return Option.filter(selected, (id) => Option.exists(Arr.get(tree.nodes, id), (node) => node.kind === "directory"))
}

export function toggleFileTreeDirectory(
  tree: FileTree,
  expanded: HashSet.HashSet<number>,
  selected: Option.Option<number>,
): HashSet.HashSet<number> {
  return Option.match(selectedDirectory(tree, selected), {
    onNone: () => expanded,
    onSome: (id) => (HashSet.has(expanded, id) ? HashSet.remove(expanded, id) : HashSet.add(expanded, id)),
  })
}

export function setFileTreeDirectoryExpanded(
  tree: FileTree,
  expanded: HashSet.HashSet<number>,
  selected: Option.Option<number>,
  value: boolean,
): HashSet.HashSet<number> {
  return Option.match(selectedDirectory(tree, selected), {
    onNone: () => expanded,
    onSome: (id) => (value ? HashSet.add(expanded, id) : HashSet.remove(expanded, id)),
  })
}

// The parent directories of a node, nearest first.
function fileTreeParentDirectories(tree: FileTree, id: number): number[] {
  const parentOf = (child: number) => Option.flatMap(Arr.get(tree.nodes, child), (node) => node.parent)
  return Arr.unfold(parentOf(id), (parent) =>
    Option.map(parent, (value): readonly [number, Option.Option<number>] => [value, parentOf(value)]),
  )
}

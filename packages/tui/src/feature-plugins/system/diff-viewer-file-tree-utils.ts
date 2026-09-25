// Paths branch softly through the screen,
// A quiet tree of changed designs;
// Each leaf remembers what has been,
// And waits where careful light aligns.

import { Array as Arr, HashSet, MutableHashMap, Option } from "effect"

export type FileTreeItem = {
  readonly file: string
  readonly status?: "added" | "deleted" | "modified"
}

export type FileTreeNode = {
  readonly id: number
  readonly name: string
  readonly parent: Option.Option<number>
  readonly children: number[]
  readonly depth: number
  readonly kind: "directory" | "file"
  readonly fileIndex?: number
}

export type FileTree = {
  readonly roots: number[]
  readonly nodes: FileTreeNode[]
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

export function buildFileTree(files: readonly FileTreeItem[]): FileTree {
  const roots: number[] = []
  const nodes: FileTreeNode[] = []
  const directoryByPath = MutableHashMap.empty<string, number>()

  files.forEach((file, fileIndex) => {
    const segments = file.file.split("/").filter(Boolean)
    if (segments.length === 0) return

    const parent = segments.slice(0, -1).reduce(
      (state, segment) => {
        const directoryPath = state.path ? `${state.path}/${segment}` : segment
        const existing = MutableHashMap.get(directoryByPath, directoryPath)
        if (Option.isSome(existing)) return { id: existing, path: directoryPath, depth: state.depth + 1 }

        const id = addFileTreeNode(nodes, roots, {
          name: segment,
          parent: state.id,
          depth: state.depth,
          kind: "directory",
        })
        MutableHashMap.set(directoryByPath, directoryPath, id)
        return { id: Option.some(id), path: directoryPath, depth: state.depth + 1 }
      },
      { id: Option.none<number>(), path: "", depth: 0 },
    )

    addFileTreeNode(nodes, roots, {
      name: segments[segments.length - 1],
      parent: parent.id,
      depth: parent.depth,
      kind: "file",
      fileIndex,
    })
  })

  const tree = { roots, nodes }
  tree.roots.sort((left, right) => compareFileTreeNodes(tree, left, right))
  tree.nodes.forEach((node) => node.children.sort((left, right) => compareFileTreeNodes(tree, left, right)))
  return tree
}

export function flattenFileTree(tree: FileTree, expanded?: HashSet.HashSet<number>): FileTreeRow[] {
  const rows: FileTreeRow[] = []
  const visit = (id: number, depth: number) => {
    const node = tree.nodes[id]
    if (node.kind === "file") {
      rows.push({
        id: node.id,
        depth,
        kind: node.kind,
        name: node.name,
        fileIndex: node.fileIndex,
      })
      return
    }

    const chain = collapsedFileTreeDirectoryChain(tree, node.id)
    const last = Arr.lastNonEmpty(chain)
    rows.push({
      id: node.id,
      depth,
      kind: node.kind,
      name: chain.map((item) => item.name).join("/"),
      fileIndex: node.fileIndex,
    })
    if (expanded === undefined || HashSet.has(expanded, node.id))
      last.children.forEach((child) => visit(child, depth + 1))
  }
  tree.roots.forEach((root) => visit(root, 0))
  return rows
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
  const leftNode = tree.nodes[left]
  const rightNode = tree.nodes[right]
  if (leftNode.kind !== rightNode.kind) return leftNode.kind === "directory" ? -1 : 1
  if (leftNode.name < rightNode.name) return -1
  if (leftNode.name > rightNode.name) return 1
  return left - right
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

function addFileTreeNode(nodes: FileTreeNode[], roots: number[], input: Omit<FileTreeNode, "id" | "children">) {
  const id = nodes.length
  nodes.push({ ...input, id, children: [] })
  if (Option.isNone(input.parent)) roots.push(id)
  else nodes[input.parent.value].children.push(id)
  return id
}

// The parent directories of a node, nearest first.
function fileTreeParentDirectories(tree: FileTree, id: number): number[] {
  const parentOf = (child: number) => Option.flatMap(Arr.get(tree.nodes, child), (node) => node.parent)
  return Arr.unfold(parentOf(id), (parent) =>
    Option.map(parent, (value): readonly [number, Option.Option<number>] => [value, parentOf(value)]),
  )
}

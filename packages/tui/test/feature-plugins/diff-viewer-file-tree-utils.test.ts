import { describe, expect, test } from "bun:test"
import { HashSet, Option } from "effect"
import {
  allExpandedFileTreeDirectories,
  buildFileTree,
  fileTreeFileSelection,
  flattenFileTree,
  moveFileTreeSelection,
  moveFileTreeSelectionToFirstChild,
  moveFileTreeSelectionToFile,
  moveFileTreeSelectionToParent,
  movePatchFileIndex,
  orderedPatchFileIndexes,
  setFileTreeDirectoryExpanded,
  showDiffViewerFileTree,
  singlePatchFileIndex,
  toggleFileTreeDirectory,
} from "../../src/feature-plugins/system/diff-viewer-file-tree-utils"

describe("diff viewer file tree utilities", () => {
  test("builds a nested tree with deduplicated directories and file indexes", () => {
    const tree = buildFileTree([
      { file: "src/config/tui.ts" },
      { file: "src/config/keybind.ts" },
      { file: "src/session/index.ts" },
    ])

    expect(tree.nodes.filter((node) => node.kind === "directory" && node.name === "src")).toHaveLength(1)
    expect(tree.nodes.filter((node) => node.kind === "directory" && node.name === "config")).toHaveLength(1)
    expect(tree.nodes.filter((node) => node.kind === "directory" && node.name === "session")).toHaveLength(1)
    expect(
      tree.nodes
        .filter((node) => node.kind === "file")
        .map((node) => ({ name: node.name, fileIndex: node.fileIndex, depth: node.depth })),
    ).toEqual([
      { name: "tui.ts", fileIndex: 0, depth: 2 },
      { name: "keybind.ts", fileIndex: 1, depth: 2 },
      { name: "index.ts", fileIndex: 2, depth: 2 },
    ])
  })

  test("sorts directories before files and alphabetically within each group", () => {
    const rows = flattenFileTree(
      buildFileTree([
        { file: "z-file.ts" },
        { file: "b/file.ts" },
        { file: "a/zeta.ts" },
        { file: "b/alpha.ts" },
        { file: "a/alpha.ts" },
      ]),
    )

    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.name}`)).toEqual([
      "directory:a",
      "  file:alpha.ts",
      "  file:zeta.ts",
      "directory:b",
      "  file:alpha.ts",
      "  file:file.ts",
      "file:z-file.ts",
    ])
  })

  test("sorts root-level files without creating directories", () => {
    const tree = buildFileTree([{ file: "zeta.ts" }, { file: "alpha.ts" }, { file: "beta.ts" }])

    expect(tree.nodes.every((node) => node.kind === "file")).toBe(true)
    expect(flattenFileTree(tree).map((row) => row.name)).toEqual(["alpha.ts", "beta.ts", "zeta.ts"])
  })

  test("collapses unary directory chains while flattening", () => {
    const rows = flattenFileTree(
      buildFileTree([{ file: "packages/opencode/src/cli/app.ts" }, { file: "packages/opencode/src/server/server.ts" }]),
    )

    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.name}`)).toEqual([
      "directory:packages/opencode/src",
      "  directory:cli",
      "    file:app.ts",
      "  directory:server",
      "    file:server.ts",
    ])
  })

  test("does not collapse a directory into a file row", () => {
    const rows = flattenFileTree(buildFileTree([{ file: "packages/opencode/src/app.ts" }]))

    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.name}`)).toEqual([
      "directory:packages/opencode/src",
      "  file:app.ts",
    ])
  })

  test("stops collapsing at branches", () => {
    const rows = flattenFileTree(
      buildFileTree([
        { file: "packages/opencode/src/cli/app.ts" },
        { file: "packages/opencode/src/server/server.ts" },
        { file: "packages/readme.md" },
      ]),
    )

    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.name}`)).toEqual([
      "directory:packages",
      "  directory:opencode/src",
      "    directory:cli",
      "      file:app.ts",
      "    directory:server",
      "      file:server.ts",
      "  file:readme.md",
    ])
  })

  test("keeps same directory names under different parents separate", () => {
    const rows = flattenFileTree(
      buildFileTree([{ file: "components/button.ts" }, { file: "docs/components/usage.md" }]),
    )

    expect(rows.map((row) => `${"  ".repeat(row.depth)}${row.kind}:${row.name}`)).toEqual([
      "directory:components",
      "  file:button.ts",
      "directory:docs/components",
      "  file:usage.md",
    ])
  })

  test("flattens all-expanded rows depth-first with depths and file references", () => {
    const rows = flattenFileTree(
      buildFileTree([{ file: "src/config/tui.ts" }, { file: "src/config/keybind.ts" }, { file: "README.md" }]),
    )

    expect(rows.map((row) => ({ name: row.name, kind: row.kind, depth: row.depth, fileIndex: row.fileIndex }))).toEqual(
      [
        { name: "src/config", kind: "directory", depth: 0, fileIndex: undefined },
        { name: "keybind.ts", kind: "file", depth: 1, fileIndex: 1 },
        { name: "tui.ts", kind: "file", depth: 1, fileIndex: 0 },
        { name: "README.md", kind: "file", depth: 0, fileIndex: 2 },
      ],
    )
  })

  test("collapses expanded unary children under the first visible directory id", () => {
    const tree = buildFileTree([
      { file: "packages/opencode/src/cli/app.ts" },
      { file: "packages/opencode/src/server/server.ts" },
    ])
    const packages = tree.nodes.find((node) => node.kind === "directory" && node.name === "packages")!

    expect(flattenFileTree(tree, HashSet.empty()).map((row) => row.name)).toEqual(["packages/opencode/src"])
    expect(flattenFileTree(tree, HashSet.make(packages.id)).map((row) => row.name)).toEqual([
      "packages/opencode/src",
      "cli",
      "server",
    ])
  })

  test("flattens only expanded directory descendants when expansion is provided", () => {
    const tree = buildFileTree([{ file: "src/config/tui.ts" }, { file: "src/session/index.ts" }, { file: "README.md" }])
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const config = tree.nodes.find((node) => node.kind === "directory" && node.name === "config")!

    expect(flattenFileTree(tree, HashSet.empty()).map((row) => row.name)).toEqual(["src", "README.md"])
    expect(flattenFileTree(tree, HashSet.make(src.id)).map((row) => row.name)).toEqual([
      "src",
      "config",
      "session",
      "README.md",
    ])
    expect(flattenFileTree(tree, HashSet.make(src.id, config.id)).map((row) => row.name)).toEqual([
      "src",
      "config",
      "tui.ts",
      "session",
      "README.md",
    ])
  })

  test("moves selection across visible rows and clamps to bounds", () => {
    const rows = flattenFileTree(buildFileTree([{ file: "src/config/tui.ts" }, { file: "README.md" }]))

    expect(moveFileTreeSelection(rows, Option.none(), 1)).toEqual(Option.some(rows[0].id))
    expect(moveFileTreeSelection(rows, Option.some(rows[0].id), 1)).toEqual(Option.some(rows[1].id))
    expect(moveFileTreeSelection(rows, Option.some(rows[1].id), 99)).toEqual(Option.some(rows[rows.length - 1].id))
    expect(moveFileTreeSelection(rows, Option.some(rows[1].id), -99)).toEqual(Option.some(rows[0].id))
    expect(moveFileTreeSelection([], Option.none(), 1)).toEqual(Option.none())
  })

  test("moves directory selection to first visible child", () => {
    const rows = flattenFileTree(buildFileTree([{ file: "src/config/tui.ts" }, { file: "src/session/index.ts" }]))
    const src = rows.find((row) => row.kind === "directory" && row.name === "src")!
    const config = rows.find((row) => row.kind === "directory" && row.name === "config")!
    const tui = rows.find((row) => row.name === "tui.ts")!

    expect(moveFileTreeSelectionToFirstChild(rows, Option.some(src.id))).toEqual(Option.some(config.id))
    expect(moveFileTreeSelectionToFirstChild(rows, Option.some(tui.id))).toEqual(Option.some(tui.id))
    expect(moveFileTreeSelectionToFirstChild(rows, Option.none())).toEqual(Option.none())
  })

  test("moves collapsed chain selection to first visible child", () => {
    const rows = flattenFileTree(
      buildFileTree([{ file: "packages/opencode/src/cli/app.ts" }, { file: "packages/opencode/src/server/server.ts" }]),
    )
    const packages = rows.find((row) => row.kind === "directory" && row.name === "packages/opencode/src")!
    const cli = rows.find((row) => row.kind === "directory" && row.name === "cli")!

    expect(moveFileTreeSelectionToFirstChild(rows, Option.some(packages.id))).toEqual(Option.some(cli.id))
  })

  test("moves file and collapsed directory selection to visible parent", () => {
    const rows = flattenFileTree(
      buildFileTree([{ file: "packages/opencode/src/cli/app.ts" }, { file: "packages/opencode/src/server/server.ts" }]),
    )
    const root = rows.find((row) => row.kind === "directory" && row.name === "packages/opencode/src")!
    const cli = rows.find((row) => row.kind === "directory" && row.name === "cli")!
    const app = rows.find((row) => row.name === "app.ts")!

    expect(moveFileTreeSelectionToParent(rows, Option.some(app.id))).toEqual(Option.some(cli.id))
    expect(moveFileTreeSelectionToParent(rows, Option.some(cli.id))).toEqual(Option.some(root.id))
    expect(moveFileTreeSelectionToParent(rows, Option.some(root.id))).toEqual(Option.some(root.id))
    expect(moveFileTreeSelectionToParent(rows, Option.none())).toEqual(Option.none())
  })

  test("moves file selection relative to the highlighted row", () => {
    const rows = flattenFileTree(
      buildFileTree([{ file: "src/config/tui.ts" }, { file: "src/session/index.ts" }, { file: "README.md" }]),
    )
    const config = rows.find((row) => row.kind === "directory" && row.name === "config")!
    const session = rows.find((row) => row.kind === "directory" && row.name === "session")!
    const tui = rows.find((row) => row.name === "tui.ts")!
    const index = rows.find((row) => row.name === "index.ts")!
    const readme = rows.find((row) => row.name === "README.md")!

    expect(moveFileTreeSelectionToFile(rows, Option.none(), 1)).toEqual(Option.some(tui.id))
    expect(moveFileTreeSelectionToFile(rows, Option.none(), -1)).toEqual(Option.some(readme.id))
    expect(moveFileTreeSelectionToFile(rows, Option.some(config.id), 1)).toEqual(Option.some(tui.id))
    expect(moveFileTreeSelectionToFile(rows, Option.some(session.id), -1)).toEqual(Option.some(tui.id))
    expect(moveFileTreeSelectionToFile(rows, Option.some(tui.id), 1)).toEqual(Option.some(index.id))
    expect(moveFileTreeSelectionToFile(rows, Option.some(index.id), -1)).toEqual(Option.some(tui.id))
    expect(moveFileTreeSelectionToFile(rows, Option.some(readme.id), 1)).toEqual(Option.some(readme.id))
  })

  test("selects a file tree node and expands its parents for a patch file", () => {
    const tree = buildFileTree([{ file: "src/config/tui.ts" }, { file: "src/session/index.ts" }, { file: "README.md" }])
    const selection = Option.getOrThrow(fileTreeFileSelection(tree, 1))
    const index = tree.nodes.find((node) => node.kind === "file" && node.name === "index.ts")!

    expect(selection.highlightedNode).toBe(index.id)
    expect([...selection.expandedNodes].map((id) => tree.nodes[id].name)).toEqual(["session", "src"])
    expect(fileTreeFileSelection(tree, 99)).toEqual(Option.none())
  })

  test("prefers the selected file when choosing the single patch file", () => {
    expect(singlePatchFileIndex(Option.some(2), Option.some(1), Option.some(0), Option.some(3))).toEqual(Option.some(2))
    expect(singlePatchFileIndex(Option.none(), Option.some(1), Option.some(0), Option.some(3))).toEqual(Option.some(1))
    expect(singlePatchFileIndex(Option.none(), Option.none(), Option.some(0), Option.some(3))).toEqual(Option.some(0))
    expect(singlePatchFileIndex(Option.none(), Option.none(), Option.none(), Option.some(3))).toEqual(Option.some(3))
  })

  test("orders patches by the flattened file tree order", () => {
    const rows = flattenFileTree(
      buildFileTree([
        { file: "src/dir-8/juniper-4.ts" },
        { file: "src/dir-8/harbor-94.ts" },
        { file: "src/dir-8/cedar-16.ts" },
      ]),
    )

    expect(orderedPatchFileIndexes(rows)).toEqual([2, 1, 0])
  })

  test("shows the diff viewer file tree only when enabled and files exist", () => {
    expect(showDiffViewerFileTree(true, 1)).toBe(true)
    expect(showDiffViewerFileTree(true, 0)).toBe(false)
    expect(showDiffViewerFileTree(false, 1)).toBe(false)
    expect(showDiffViewerFileTree(false, 0)).toBe(false)
  })

  test("moves patch selection through the ordered patch file indexes", () => {
    const fileIndexes = [2, 1, 0]

    expect(movePatchFileIndex(fileIndexes, Option.none(), 1)).toEqual(Option.some(2))
    expect(movePatchFileIndex(fileIndexes, Option.none(), -1)).toEqual(Option.some(2))
    expect(movePatchFileIndex(fileIndexes, Option.some(2), 1)).toEqual(Option.some(1))
    expect(movePatchFileIndex(fileIndexes, Option.some(1), -1)).toEqual(Option.some(2))
    expect(movePatchFileIndex(fileIndexes, Option.some(0), 1)).toEqual(Option.some(0))
    expect(movePatchFileIndex(fileIndexes, Option.some(99), 1)).toEqual(Option.some(2))
    expect(movePatchFileIndex(fileIndexes, Option.some(99), -1)).toEqual(Option.some(2))
    expect(movePatchFileIndex([], Option.none(), 1)).toEqual(Option.none())
  })

  test("toggles only selected directory expansion", () => {
    const tree = buildFileTree([{ file: "src/config/tui.ts" }, { file: "README.md" }])
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const readme = tree.nodes.find((node) => node.kind === "file" && node.name === "README.md")!
    const expanded = allExpandedFileTreeDirectories(tree)

    const collapsed = toggleFileTreeDirectory(tree, expanded, Option.some(src.id))
    expect(HashSet.has(collapsed, src.id)).toBe(false)
    expect(flattenFileTree(tree, collapsed).map((row) => row.name)).toEqual(["src/config", "README.md"])

    const reopened = toggleFileTreeDirectory(tree, collapsed, Option.some(src.id))
    expect(HashSet.has(reopened, src.id)).toBe(true)

    expect(toggleFileTreeDirectory(tree, reopened, Option.some(readme.id))).toBe(reopened)
    expect(toggleFileTreeDirectory(tree, reopened, Option.none())).toBe(reopened)
  })

  test("sets only selected directory expansion", () => {
    const tree = buildFileTree([{ file: "src/config/tui.ts" }, { file: "README.md" }])
    const src = tree.nodes.find((node) => node.kind === "directory" && node.name === "src")!
    const readme = tree.nodes.find((node) => node.kind === "file" && node.name === "README.md")!
    const expanded = allExpandedFileTreeDirectories(tree)

    const collapsed = setFileTreeDirectoryExpanded(tree, expanded, Option.some(src.id), false)
    expect(HashSet.has(collapsed, src.id)).toBe(false)

    const reopened = setFileTreeDirectoryExpanded(tree, collapsed, Option.some(src.id), true)
    expect(HashSet.has(reopened, src.id)).toBe(true)

    expect(setFileTreeDirectoryExpanded(tree, reopened, Option.some(readme.id), false)).toBe(reopened)
    expect(setFileTreeDirectoryExpanded(tree, reopened, Option.none(), false)).toBe(reopened)
  })
})

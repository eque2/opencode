import { expect, test } from "bun:test"
import { Chunk } from "effect"
import { FileTree, type FileTreeDirectoryHandle } from "@pierre/trees"

test("reports directory expansion changes", () => {
  let changes = Chunk.empty<{ path: string; expanded: boolean }>()
  const tree = new FileTree({
    paths: ["src/"],
    onExpansionChange: (change) => {
      changes = Chunk.append(changes, change)
    },
  })

  const src = tree.getItem("src/")
  if (!src || !src.isDirectory()) throw new Error("Expected src to be a directory")
  const directory = src as FileTreeDirectoryHandle

  directory.expand()
  directory.collapse()

  expect(Chunk.toReadonlyArray(changes)).toEqual([
    { path: "src/", expanded: true },
    { path: "src/", expanded: false },
  ])
  tree.cleanUp()
})

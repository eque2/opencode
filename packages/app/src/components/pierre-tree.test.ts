import { expect, test } from "bun:test"
import { Chunk, Data, Option } from "effect"
import { FileTree, type FileTreeDirectoryHandle, type FileTreeItemHandle } from "@pierre/trees"

// isDirectory() returns the literal true or false for each handle kind, but
// TypeScript does not narrow a union through a method call on its own.
const isDirectoryHandle = (item: FileTreeItemHandle): item is FileTreeDirectoryHandle => item.isDirectory()

class MissingDirectory extends Data.TaggedError("PierreTreeTest.MissingDirectory")<{ readonly message: string }> {}

test("reports directory expansion changes", () => {
  let changes = Chunk.empty<{ path: string; expanded: boolean }>()
  const tree = new FileTree({
    paths: ["src/"],
    onExpansionChange: (change) => {
      changes = Chunk.append(changes, change)
    },
  })

  const directory = Option.fromNullishOr(tree.getItem("src/")).pipe(
    Option.filter(isDirectoryHandle),
    Option.getOrThrowWith(() => new MissingDirectory({ message: "Expected src to be a directory" })),
  )

  directory.expand()
  directory.collapse()

  expect(Chunk.toReadonlyArray(changes)).toEqual([
    { path: "src/", expanded: true },
    { path: "src/", expanded: false },
  ])
  tree.cleanUp()
})

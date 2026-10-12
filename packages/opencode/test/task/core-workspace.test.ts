import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import path from "path"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"

// The git side of the in-core harness, on a scratch repository: a leaf's worktree and the merge of its verified head.

const it = testEffect(NodeServices.layer)
const limits = TaskLimits.scripted

const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, limits, ...args)

const repository = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  yield* git(root, "init", "-q", "-b", "main")
  yield* fs.writeFileString(path.join(root, ".gitignore"), "node_modules\n.opencode/\n")
  yield* git(root, "add", "-A")
  yield* git(root, "commit", "-q", "-m", "seed")
  return root
})

describe("the harness workspace", () => {
  it.live("merges the verified head into main, not a later commit on the branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const tree = yield* TaskWorkspace.ensureWorktree(root, "T1.1", limits)
      expect(tree.branch).toBe("task/T1.1")
      expect(tree.base).toBe(yield* TaskWorkspace.mainHead(root, limits))
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      // A commit made after task.ready, never proved.
      yield* fs.writeFileString(path.join(tree.worktree, "unproved.ts"), "export const unproved = 1\n")
      yield* TaskWorkspace.commitAll(tree.worktree, limits, "after ready")

      yield* TaskWorkspace.merge(root, limits, head)

      expect(yield* TaskWorkspace.merged(root, limits, head)).toBe(true)
      const files = (yield* git(root, "ls-tree", "--name-only", "refs/heads/main")).split("\n")
      expect(files).toContain("proved.ts")
      expect(files).not.toContain("unproved.ts")
    }),
  )

  it.live("reuses the worktree and its base on a later attempt", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const first = yield* TaskWorkspace.ensureWorktree(root, "T1.2", limits)
      const second = yield* TaskWorkspace.ensureWorktree(root, "T1.2", limits)
      expect(second).toEqual(first)
    }),
  )
})

import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Option } from "effect"
import path from "path"
import { TaskWorkspace } from "@/task/core/workspace"
import { TaskLimits } from "@/task/limits"
import { testEffect } from "../lib/effect"

// The git side of the task harness, on a scratch repository: a leaf's worktree, the merge of its verified head, and
// the base-branch checks that `/task` makes before a run. The repository's branch is `dev`, not `main`, as in a
// repository whose default branch is not `main`.

const it = testEffect(NodeServices.layer)
const limits = TaskLimits.scripted
const BASE = "dev"

const git = (cwd: string, ...args: ReadonlyArray<string>) => TaskWorkspace.git(cwd, limits, ...args)

const repository = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  yield* git(root, "init", "-q", "-b", BASE)
  yield* fs.writeFileString(path.join(root, ".gitignore"), "node_modules\n")
  yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 1\n")
  yield* git(root, "add", "-A")
  yield* git(root, "commit", "-q", "-m", "seed")
  return root
})

describe("the harness workspace", () => {
  it.live("merges the verified head into the base branch, not a later commit on the branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const tree = yield* TaskWorkspace.ensureWorktree(root, "T1.1", BASE, limits)
      expect(tree.branch).toBe("task/T1.1")
      expect(tree.base).toBe(yield* TaskWorkspace.baseHead(root, limits, BASE))
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      // A commit made after task.ready, never proved.
      yield* fs.writeFileString(path.join(tree.worktree, "unproved.ts"), "export const unproved = 1\n")
      yield* TaskWorkspace.commitAll(tree.worktree, limits, "after ready")

      yield* TaskWorkspace.merge(root, limits, BASE, head)

      expect(yield* TaskWorkspace.merged(root, limits, BASE, head)).toBe(true)
      const files = (yield* git(root, "ls-tree", "--name-only", `refs/heads/${BASE}`)).split("\n")
      expect(files).toContain("proved.ts")
      expect(files).not.toContain("unproved.ts")
    }),
  )

  it.live("refuses to merge while the root checkout is on another branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const tree = yield* TaskWorkspace.ensureWorktree(root, "T1.1", BASE, limits)
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      yield* git(root, "switch", "-q", "-c", "feature")

      const error = yield* TaskWorkspace.merge(root, limits, BASE, head).pipe(Effect.flip)

      expect(error.message).toContain("on feature, not the run's base branch dev")
      expect(yield* TaskWorkspace.merged(root, limits, BASE, head)).toBe(false)
    }),
  )

  it.live("names the checked-out branch, and none on a detached HEAD", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      expect(yield* TaskWorkspace.currentBranch(root, limits)).toEqual(Option.some(BASE))
      yield* git(root, "switch", "-q", "--detach", "HEAD")
      expect(yield* TaskWorkspace.currentBranch(root, limits)).toEqual(Option.none())
    }),
  )

  it.live("lists tracked changes, staged or not, and ignores the harness folder and untracked files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual([])

      yield* fs.makeDirectory(path.join(root, ".opencode", "task"), { recursive: true })
      yield* fs.writeFileString(path.join(root, ".opencode", "task", "status.json"), "{}\n")
      yield* fs.writeFileString(path.join(root, "notes.txt"), "untracked\n")
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual([])

      yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 2\n")
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual(["tracked.ts"])
      yield* git(root, "add", "tracked.ts")
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual(["tracked.ts"])
    }),
  )

  it.live("restores a checkout to its HEAD after a judge: changes and new files go, ignored files stay", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      yield* fs.writeFileString(path.join(root, ".gitignore"), "changed by a judge\n")
      yield* fs.makeDirectory(path.join(root, "out"))
      yield* fs.writeFileString(path.join(root, "out", "report.txt"), "left behind\n")
      yield* fs.makeDirectory(path.join(root, "node_modules"))
      yield* fs.writeFileString(path.join(root, "node_modules", "kept.js"), "ignored\n")
      yield* fs.makeDirectory(path.join(root, ".opencode", "task"), { recursive: true })
      yield* fs.writeFileString(path.join(root, ".opencode", "task", "status.json"), "{}\n")

      yield* TaskWorkspace.restore(root, limits)

      expect(yield* git(root, "status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).opencode")).toBe("")
      expect(yield* fs.readFileString(path.join(root, ".gitignore"))).toBe("node_modules\n")
      expect(yield* fs.exists(path.join(root, "out"))).toBe(false)
      expect(yield* fs.exists(path.join(root, "node_modules", "kept.js"))).toBe(true)
      expect(yield* fs.exists(path.join(root, ".opencode", "task", "status.json"))).toBe(true)
    }),
  )

  it.live("reuses the worktree and its base on a later attempt", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const first = yield* TaskWorkspace.ensureWorktree(root, "T1.2", BASE, limits)
      const second = yield* TaskWorkspace.ensureWorktree(root, "T1.2", BASE, limits)
      expect(second).toEqual(first)
    }),
  )
})

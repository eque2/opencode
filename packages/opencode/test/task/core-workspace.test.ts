import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem, Option, Result } from "effect"
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
const RUN = "task_0123456789abcdef"

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
      const tree = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.1", BASE, limits)
      expect(tree.branch).toBe("task/01234567/T1.1")
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
      const tree = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.1", BASE, limits)
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      yield* git(root, "switch", "-q", "-c", "feature")

      const error = yield* TaskWorkspace.merge(root, limits, BASE, head).pipe(Effect.flip)

      expect(error.message).toContain("on feature, not the run's base branch dev")
      expect(yield* TaskWorkspace.merged(root, limits, BASE, head)).toBe(false)
    }),
  )

  it.live("names the checked-out branch, none on a detached HEAD, and is not confused by a tag of the same name", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      expect(yield* TaskWorkspace.currentBranch(root, limits)).toEqual(Option.some(BASE))
      yield* git(root, "tag", BASE)
      expect(yield* TaskWorkspace.currentBranch(root, limits)).toEqual(Option.some(BASE))
      yield* git(root, "switch", "-q", "--detach", "HEAD")
      expect(yield* TaskWorkspace.currentBranch(root, limits)).toEqual(Option.none())
    }),
  )

  it.live("lists tracked changes, staged or not, and untracked files; ignores ignored files and the harness folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual([])

      // The harness folder does not count, even where a project tracks it.
      yield* fs.makeDirectory(path.join(root, ".opencode", "task"), { recursive: true })
      yield* fs.writeFileString(path.join(root, ".opencode", "task", "status.json"), "{}\n")
      yield* git(root, "add", "-f", ".opencode/task/status.json")
      yield* git(root, "commit", "-q", "-m", "a tracked status file")
      yield* fs.writeFileString(path.join(root, ".opencode", "task", "status.json"), "{\"changed\":true}\n")
      yield* fs.makeDirectory(path.join(root, "node_modules"))
      yield* fs.writeFileString(path.join(root, "node_modules", "ignored.js"), "ignored\n")
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual([])

      yield* fs.writeFileString(path.join(root, "notes.txt"), "untracked\n")
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual(["notes.txt"])
      yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 2\n")
      yield* git(root, "add", "tracked.ts")
      expect(yield* TaskWorkspace.uncommitted(root, limits)).toEqual(["tracked.ts", "notes.txt"])
    }),
  )

  it.live("checks the whole repository from a subfolder, excluding the subfolder's harness folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const sub = path.join(root, "app")
      yield* fs.makeDirectory(path.join(sub, ".opencode", "task"), { recursive: true })
      yield* fs.writeFileString(path.join(sub, ".opencode", "task", "status.json"), "{}\n")
      expect(yield* TaskWorkspace.uncommitted(sub, limits)).toEqual([])
      yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 3\n")
      expect(yield* TaskWorkspace.uncommitted(sub, limits)).toEqual(["tracked.ts"])
    }),
  )

  it.live("says why a checkout cannot take a run, or gives its base branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reason = (cwd: string) =>
        TaskWorkspace.readiness(cwd, limits).pipe(Effect.map((ready) => (Result.isFailure(ready) ? ready.failure : "")))

      const bare = yield* fs.makeTempDirectoryScoped()
      expect(yield* reason(bare)).toBe("the folder is not inside a git repository")
      yield* git(bare, "init", "-q", "-b", BASE)
      expect(yield* reason(bare)).toBe("the repository has no commit yet")

      const root = yield* repository()
      expect(yield* TaskWorkspace.readiness(root, limits)).toEqual(Result.succeed(BASE))
      yield* fs.writeFileString(path.join(root, "notes.txt"), "untracked\n")
      expect(yield* reason(root)).toBe("the checkout has uncommitted changes or untracked files: notes.txt")
      yield* fs.remove(path.join(root, "notes.txt"))

      // A conflicting merge stops half way and leaves MERGE_HEAD.
      yield* git(root, "switch", "-q", "-c", "other")
      yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 'other'\n")
      yield* git(root, "commit", "-q", "-am", "other")
      yield* git(root, "switch", "-q", BASE)
      yield* fs.writeFileString(path.join(root, "tracked.ts"), "export const tracked = 'base'\n")
      yield* git(root, "commit", "-q", "-am", "base")
      yield* TaskWorkspace.merge(root, limits, BASE, "other").pipe(Effect.ignore)
      yield* git(root, "merge", "--no-edit", "other").pipe(Effect.ignore)
      expect(yield* reason(root)).toBe("a merge is in progress in the checkout; finish it or run `git merge --abort`")
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

  it.live("gives two runs' leaves of the same id their own branches and worktrees", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const first = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.1", BASE, limits)
      const other = yield* TaskWorkspace.ensureWorktree(root, "task_fedcba9876543210", "T1.1", BASE, limits)
      expect(other.branch).toBe("task/fedcba98/T1.1")
      expect(other.branch).not.toBe(first.branch)
      expect(other.worktree).not.toBe(first.worktree)
    }),
  )

  it.live("restarts a leaf whose branch the base already holds from the base head", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* repository()
      const tree = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.1", BASE, limits)
      yield* fs.writeFileString(path.join(tree.worktree, "proved.ts"), "export const proved = 1\n")
      const head = yield* TaskWorkspace.commitAll(tree.worktree, limits, "T1.1: attempt 1")
      yield* TaskWorkspace.merge(root, limits, BASE, head)
      // The base moves on after the merge, as when other leaves land.
      yield* fs.writeFileString(path.join(root, "later.ts"), "export const later = 1\n")
      yield* git(root, "add", "later.ts")
      yield* git(root, "commit", "-q", "-m", "a later leaf")

      const again = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.1", BASE, limits)

      expect(again.base).toBe(yield* TaskWorkspace.baseHead(root, limits, BASE))
      expect(yield* fs.exists(path.join(again.worktree, "later.ts"))).toBe(true)
    }),
  )

  it.live("reuses the worktree and its base on a later attempt", () =>
    Effect.gen(function* () {
      const root = yield* repository()
      const first = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.2", BASE, limits)
      const second = yield* TaskWorkspace.ensureWorktree(root, RUN, "T1.2", BASE, limits)
      expect(second).toEqual(first)
    }),
  )
})

import { Duration, Effect, FileSystem, Option, Path, Schema } from "effect"
import { TaskProof } from "@/task/proof"
import type { TaskLimits } from "@/task/limits"

// The git side of the harness. Each leaf builds in its own worktree `<directory>/.opencode/task/worktrees/<id>` on
// the branch `task/<id>`, branched from the run's base branch; a trusted leaf's verified head merges into the base
// branch in the root checkout. The base is the branch the root checkout has checked out when `/task` starts
// (`currentBranch`), so a repository whose default branch is not `main` works as one that is. Every git call runs
// through `TaskProof.run`: bounded, in its own process group, killed with it on interruption.

/** A git call failed or did not finish. */
export class GitError extends Schema.TaggedError<GitError>()("TaskWorkspaceGitError", {
  message: Schema.String,
}) {}

// The harness commits and merges as itself, whatever the user's configuration says.
const IDENTITY = [
  "-c",
  "user.name=opencode task harness",
  "-c",
  "user.email=task-harness@opencode.invalid",
  "-c",
  "commit.gpgsign=false",
]

// A git call on a small repository is quick; the floor keeps the scripted 5 s proof timeout from cutting one short
// on a loaded machine.
const bounds = (limits: TaskLimits.Limits): TaskProof.Bounds => ({
  timeout: Duration.max(limits.proofTimeout, Duration.seconds(30)),
  cancelDeadline: limits.cancelDeadline,
})

const tail = (text: string) => {
  const trimmed = text.trim()
  return trimmed.length > 400 ? `…${trimmed.slice(-400)}` : trimmed
}

const call = Effect.fnUntraced(function* (cwd: string, limits: TaskLimits.Limits, args: ReadonlyArray<string>) {
  const command = `git ${args.join(" ")}`
  const result = yield* TaskProof.run("git", [...IDENTITY, ...args], { cwd, ...bounds(limits) }).pipe(
    Effect.mapError((error) => new GitError({ message: `${command}: ${error.message}` })),
  )
  if (result.timedOut) return yield* new GitError({ message: `${command}: timed out` })
  return { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
})

/** Runs git and returns its trimmed output; a non-zero exit fails. */
export const git = Effect.fnUntraced(function* (cwd: string, limits: TaskLimits.Limits, ...args: ReadonlyArray<string>) {
  const result = yield* call(cwd, limits, args)
  if (result.exitCode !== 0) {
    return yield* new GitError({
      message: `${result.command}: exit ${result.exitCode}: ${tail(result.stderr || result.stdout)}`,
    })
  }
  return result.stdout.trim()
})

/** The commit that a revision names. */
export const commit = (cwd: string, limits: TaskLimits.Limits, revision: string) =>
  git(cwd, limits, "rev-parse", "--verify", `${revision}^{commit}`)

/** The branch the checkout has checked out, or none on a detached HEAD. */
export const currentBranch = Effect.fnUntraced(function* (cwd: string, limits: TaskLimits.Limits) {
  const result = yield* call(cwd, limits, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  return result.exitCode === 0 && result.stdout.trim() !== "" ? Option.some(result.stdout.trim()) : Option.none<string>()
})

/**
 * The tracked paths that differ from HEAD in the checkout, staged or not; the harness's own `.opencode/task/` does
 * not count. Untracked files are left alone: a merge that would overwrite one refuses by itself.
 */
export const uncommitted = Effect.fnUntraced(function* (cwd: string, limits: TaskLimits.Limits) {
  const output = yield* git(cwd, limits, "diff", "--name-only", "HEAD", "--", ".", ":(exclude).opencode/task")
  return output.split("\n").filter((path) => path !== "")
})

/** The head of the base branch. */
export const baseHead = (root: string, limits: TaskLimits.Limits, base: string) =>
  commit(root, limits, `refs/heads/${base}`)

/** True when `ancestor` is already in the history of the base branch. */
export const merged = Effect.fnUntraced(function* (
  root: string,
  limits: TaskLimits.Limits,
  base: string,
  ancestor: string,
) {
  const result = yield* call(root, limits, ["merge-base", "--is-ancestor", ancestor, `refs/heads/${base}`])
  return result.exitCode === 0
})

const branchExists = Effect.fnUntraced(function* (root: string, limits: TaskLimits.Limits, branch: string) {
  const result = yield* call(root, limits, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  return result.exitCode === 0
})

export const worktreePath = (path: Path.Path, root: string, task: string) =>
  path.join(root, ".opencode", "task", "worktrees", task)

export const branchOf = (task: string) => `task/${task}`

export interface Worktree {
  readonly worktree: string
  readonly branch: string
  /** The base-branch commit the branch started from. */
  readonly base: string
}

/**
 * The task's worktree: made on its branch from the current head of the base branch, or reused when it already
 * exists (a later attempt or a resume). `node_modules` links to the root checkout's, so no install runs.
 */
export const ensureWorktree = Effect.fn("TaskWorkspace.ensureWorktree")(function* (
  root: string,
  task: string,
  base: string,
  limits: TaskLimits.Limits,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const worktree = worktreePath(path, root, task)
  const branch = branchOf(task)
  const present = yield* fs.exists(path.join(worktree, ".git")).pipe(Effect.orElseSucceed(() => false))
  const current = present
    ? yield* git(worktree, limits, "rev-parse", "--abbrev-ref", "HEAD").pipe(Effect.orElseSucceed(() => ""))
    : ""
  const reuse = current === branch
  if (!reuse) {
    yield* fs.remove(worktree, { recursive: true }).pipe(Effect.ignore)
    yield* git(root, limits, "worktree", "prune")
    yield* fs.makeDirectory(path.dirname(worktree), { recursive: true }).pipe(Effect.orDie)
    if (yield* branchExists(root, limits, branch)) yield* git(root, limits, "worktree", "add", worktree, branch)
    else yield* git(root, limits, "worktree", "add", "-b", branch, worktree, `refs/heads/${base}`)
  }
  const from = yield* git(root, limits, "merge-base", `refs/heads/${base}`, `refs/heads/${branch}`)
  const modules = path.join(root, "node_modules")
  const link = path.join(worktree, "node_modules")
  const linked = yield* fs.readLink(link).pipe(Effect.option)
  if ((yield* fs.exists(modules).pipe(Effect.orElseSucceed(() => false))) && Option.isNone(linked)) {
    yield* fs.symlink(modules, link).pipe(Effect.ignore)
  }
  return { worktree, branch, base: from } satisfies Worktree
})

/** Commits everything in the worktree (an empty commit is allowed) and returns the new head. */
export const commitAll = Effect.fn("TaskWorkspace.commitAll")(function* (
  worktree: string,
  limits: TaskLimits.Limits,
  message: string,
) {
  yield* git(worktree, limits, "add", "-A")
  yield* git(worktree, limits, "commit", "--allow-empty", "--no-verify", "-q", "-m", message)
  return yield* commit(worktree, limits, "HEAD")
})

/**
 * Puts a checkout back at its HEAD after a judge worked in it: every change and every untracked file goes, ignored
 * files stay, and so does the harness's own `.opencode/` folder even where it is not ignored.
 */
export const restore = Effect.fn("TaskWorkspace.restore")(function* (cwd: string, limits: TaskLimits.Limits) {
  yield* git(cwd, limits, "reset", "--hard", "-q", "HEAD")
  yield* git(cwd, limits, "clean", "-fd", "-q", "-e", ".opencode/")
})

/**
 * Merges a commit (a task's verified head) into the base branch in the root checkout; a failed merge is aborted and
 * fails. The root must still have the base branch checked out: a merge never lands on another branch.
 */
export const merge = Effect.fn("TaskWorkspace.merge")(function* (
  root: string,
  limits: TaskLimits.Limits,
  base: string,
  commit: string,
) {
  const current = yield* currentBranch(root, limits)
  if (Option.getOrUndefined(current) !== base) {
    return yield* new GitError({
      message: `git merge ${commit}: the root checkout is on ${Option.getOrElse(current, () => "a detached HEAD")}, not the run's base branch ${base}`,
    })
  }
  const result = yield* call(root, limits, ["merge", "--no-ff", "--no-edit", "--no-verify", commit])
  if (result.exitCode === 0) return yield* Effect.void
  yield* call(root, limits, ["merge", "--abort"]).pipe(Effect.ignore)
  return yield* new GitError({
    message: `git merge ${commit}: exit ${result.exitCode}: ${tail(result.stderr || result.stdout)}`,
  })
})

export * as TaskWorkspace from "./workspace"

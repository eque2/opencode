import { Duration, Effect, FileSystem, Option, Path, Schema } from "effect"
import { TaskProof } from "@/task/proof"
import type { TaskLimits } from "@/task/limits"

// The git side of the harness. Each leaf builds in its own worktree `<directory>/.opencode/task/worktrees/<id>` on
// the branch `task/<id>`, branched from `main`; a trusted leaf's branch merges into `main` in the root checkout.
// Every git call runs through `TaskProof.run`: bounded, in its own process group, killed with it on interruption.

/** The branch that the leaves branch from and merge into. */
export const MAIN = "main"

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

/** The head of `main`. */
export const mainHead = (root: string, limits: TaskLimits.Limits) => commit(root, limits, `refs/heads/${MAIN}`)

/** True when `ancestor` is already in the history of `main`. */
export const merged = Effect.fnUntraced(function* (root: string, limits: TaskLimits.Limits, ancestor: string) {
  const result = yield* call(root, limits, ["merge-base", "--is-ancestor", ancestor, `refs/heads/${MAIN}`])
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
  /** The `main` commit the branch started from. */
  readonly base: string
}

/**
 * The task's worktree: made on its branch from the current `main` head, or reused when it already exists (a later
 * attempt or a resume). `node_modules` links to the root checkout's, so no install runs.
 */
export const ensureWorktree = Effect.fn("TaskWorkspace.ensureWorktree")(function* (
  root: string,
  task: string,
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
    else yield* git(root, limits, "worktree", "add", "-b", branch, worktree, `refs/heads/${MAIN}`)
  }
  const base = yield* git(root, limits, "merge-base", `refs/heads/${MAIN}`, `refs/heads/${branch}`)
  const modules = path.join(root, "node_modules")
  const link = path.join(worktree, "node_modules")
  const linked = yield* fs.readLink(link).pipe(Effect.option)
  if ((yield* fs.exists(modules).pipe(Effect.orElseSucceed(() => false))) && Option.isNone(linked)) {
    yield* fs.symlink(modules, link).pipe(Effect.ignore)
  }
  return { worktree, branch, base } satisfies Worktree
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

/** Merges the branch into `main` in the root checkout; a failed merge is aborted and fails. */
export const merge = Effect.fn("TaskWorkspace.merge")(function* (
  root: string,
  limits: TaskLimits.Limits,
  branch: string,
) {
  const result = yield* call(root, limits, ["merge", "--no-ff", "--no-edit", "--no-verify", branch])
  if (result.exitCode === 0) return yield* Effect.void
  yield* call(root, limits, ["merge", "--abort"]).pipe(Effect.ignore)
  return yield* new GitError({
    message: `git merge ${branch}: exit ${result.exitCode}: ${tail(result.stderr || result.stdout)}`,
  })
})

export * as TaskWorkspace from "./workspace"

import { Option, Result } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Repository } from "@opencode-ai/core/repository"

// This module is the synchronous, throwing form of the core Repository module. Effect code should
// use Repository directly. Reading OPENCODE_REPO_CLONE_GITHUB_BASE_URL is an Effect
// (Repository.githubCloneBase), so a caller that needs the clone base passes it as an option.

export type RemoteReference = Repository.RemoteReference
export type FileReference = Repository.FileReference
export type Reference = Repository.Reference

export const InvalidRepositoryReferenceError = Repository.InvalidReferenceError
export type InvalidRepositoryReferenceError = Repository.InvalidReferenceError
export const UnsupportedLocalRepositoryError = Repository.UnsupportedLocalRepositoryError
export type UnsupportedLocalRepositoryError = Repository.UnsupportedLocalRepositoryError
export const InvalidRepositoryBranchError = Repository.InvalidBranchError
export type InvalidRepositoryBranchError = Repository.InvalidBranchError

export type RepositoryError = Repository.Error

export const isRepositoryError = Repository.isError
export const isFileRepositoryReference = Repository.isFile
export const isRemoteRepositoryReference = Repository.isRemote

/** Parses a repository reference. The result is null when the input is not a repository reference. */
export function parseRepositoryReference(input: string, options: Repository.ParseOptions = {}) {
  return Option.getOrNull(Repository.parse(input, options))
}

/** Parses a remote repository reference. It throws InvalidRepositoryReferenceError or UnsupportedLocalRepositoryError. */
export function parseRemoteRepositoryReference(input: string, options: Repository.ParseOptions = {}) {
  return Result.getOrThrow(Repository.parseRemote(input, options))
}

/** Checks a branch name. It throws InvalidRepositoryBranchError for an unsafe name. */
export function validateRepositoryBranch(branch: string): void {
  Result.getOrThrow(Repository.validateBranch(branch))
}

/** Reads the GitHub owner and repository from a git remote URL. The result is null for any other remote. */
export function parseGitHubRemote(input: string) {
  return Option.some(normalizeRepositoryInput(input)).pipe(
    Option.filter((cleaned) => cleaned.includes("://") || /^(?:[^@/\s]+@)?github\.com:/.test(cleaned)),
    Option.flatMap((cleaned) => Repository.parse(cleaned)),
    Option.filter((parsed) => parsed.host === "github.com" && parsed.segments.length === 2),
    Option.flatMap((parsed) =>
      Option.fromNullishOr(parsed.owner).pipe(Option.map((owner) => ({ owner, repo: parsed.repo }))),
    ),
    Option.getOrNull,
  )
}

export function repositoryCachePath(input: Reference) {
  return Repository.cachePath(Global.Path.repos, input)
}

export const repositoryCacheIdentity = Repository.cacheIdentity
export const sameRepositoryReference = Repository.same

function normalizeRepositoryInput(input: string) {
  return input
    .trim()
    .replace(/^git\+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
}

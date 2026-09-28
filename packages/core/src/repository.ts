import path from "path"
import { fileURLToPath } from "url"
import { Config, ConfigProvider, Effect, Option, Result, Schema } from "effect"

type BaseReference = {
  readonly host: string
  readonly path: string
  readonly segments: string[]
  readonly owner?: string
  readonly repo: string
  readonly remote: string
  readonly label: string
}

export type RemoteReference = BaseReference & {
  readonly protocol?: string
}

export type FileReference = BaseReference & {
  readonly host: "file"
  readonly protocol: "file:"
}

export type Reference = RemoteReference | FileReference

export class InvalidReferenceError extends Schema.TaggedError<InvalidReferenceError>()(
  "RepositoryInvalidReferenceError",
  {
    repository: Schema.String,
    message: Schema.String,
  },
) {}

export class UnsupportedLocalRepositoryError extends Schema.TaggedError<UnsupportedLocalRepositoryError>()(
  "RepositoryUnsupportedLocalRepositoryError",
  {
    repository: Schema.String,
    message: Schema.String,
  },
) {}

export class InvalidBranchError extends Schema.TaggedError<InvalidBranchError>()("RepositoryInvalidBranchError", {
  branch: Schema.String,
  message: Schema.String,
}) {}

export type Error = InvalidReferenceError | UnsupportedLocalRepositoryError | InvalidBranchError

export function isError(error: unknown): error is Error {
  return (
    error instanceof InvalidReferenceError ||
    error instanceof UnsupportedLocalRepositoryError ||
    error instanceof InvalidBranchError
  )
}

/** OPENCODE_REPO_CLONE_GITHUB_BASE_URL replaces https://github.com/ as the clone base for GitHub references. */
export const GithubCloneBase = Config.option(Config.String("OPENCODE_REPO_CLONE_GITHUB_BASE_URL"))

/**
 * Reads GithubCloneBase from a fresh snapshot of the process environment, so a value set
 * after startup still applies. An empty value counts as unset.
 */
export const githubCloneBase = Effect.suspend(() => GithubCloneBase.parse(ConfigProvider.fromEnv())).pipe(Effect.orDie)

export interface ParseOptions {
  /** The GitHub clone base (see githubCloneBase). Omitted or None clones from https://github.com/. */
  readonly githubCloneBase?: Option.Option<string>
}

export function parse(input: string, options: ParseOptions = {}): Option.Option<Reference> {
  const cleaned = normalizeInput(input)
  if (!cleaned) return Option.none()
  const base = options.githubCloneBase ?? Option.none()

  const githubPrefixed = cleaned.match(/^github:([^/\s]+)\/([^/\s]+)$/)
  if (githubPrefixed) return buildRemote({ host: "github.com", segments: [githubPrefixed[1], githubPrefixed[2]] }, base)

  if (!cleaned.includes("://")) {
    const scp = cleaned.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    if (scp) return buildRemote({ host: scp[1], segments: parts(scp[2]), remote: cleaned }, base)

    const direct = parts(cleaned)
    if (direct.length >= 2 && hostLike(direct[0]))
      return buildRemote({ host: direct[0], segments: direct.slice(1) }, base)
    if (direct.length === 2) return buildRemote({ host: "github.com", segments: direct }, base)
  }

  return Option.flatMap(parseUrl(cleaned), (url): Option.Option<Reference> => {
    if (url.protocol === "file:") return buildFile({ url, remote: cleaned })
    const segments = parts(url.pathname)
    return buildRemote(
      {
        host: url.host,
        segments,
        remote: url.host === "github.com" ? githubRemote(segments.join("/"), base) : cleaned,
        protocol: url.protocol,
      },
      base,
    )
  })
}

export function parseRemote(
  input: string,
  options: ParseOptions = {},
): Result.Result<RemoteReference, InvalidReferenceError | UnsupportedLocalRepositoryError> {
  return Option.match(parse(input, options), {
    onNone: () =>
      Result.fail(
        new InvalidReferenceError({
          repository: input,
          message: "Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand",
        }),
      ),
    onSome: (reference) =>
      isRemote(reference)
        ? Result.succeed(reference)
        : Result.fail(
            new UnsupportedLocalRepositoryError({
              repository: input,
              message: "Local file repositories are not supported",
            }),
          ),
  })
}

/** Succeeds with the branch when it is a safe Git branch name. */
export function validateBranch(branch: string): Result.Result<string, InvalidBranchError> {
  if (/^[A-Za-z0-9/_.-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..")) {
    return Result.succeed(branch)
  }
  return Result.fail(
    new InvalidBranchError({
      branch,
      message:
        "Branch must contain only alphanumeric characters, /, _, ., and -, and cannot start with - or contain ..",
    }),
  )
}

export function isFile(reference: Reference): reference is FileReference {
  return reference.protocol === "file:"
}

export function isRemote(reference: Reference): reference is RemoteReference {
  return !isFile(reference)
}

/**
 * Checkouts are keyed by remote and branch: a branch-specific reference gets
 * its own directory so branchless refreshes can never move it. The branch is
 * percent-encoded because valid branch names may contain `/`.
 */
export function cachePath(root: string, reference: Reference, branch?: string): string {
  const base = path.join(root, ...reference.host.split(":"), ...reference.segments)
  return branch ? `${base}@${encodeURIComponent(branch)}` : base
}

export function cacheIdentity(reference: Reference): string {
  return `${reference.host}/${reference.path}`
}

export function same(left: Reference, right: Reference): boolean {
  return cacheIdentity(left) === cacheIdentity(right)
}

function normalizeInput(input: string) {
  return input
    .trim()
    .replace(/^git\+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
}

function trimGitSuffix(input: string) {
  return input.replace(/\.git$/, "")
}

function parts(input: string) {
  return input
    .split("/")
    .map((item) => trimGitSuffix(item.trim()))
    .filter(Boolean)
}

function safeHost(input: string) {
  return Boolean(input) && !input.startsWith("-") && !/[\s/\\]/.test(input)
}

function safeSegment(input: string) {
  return input !== "." && input !== ".." && !input.includes(":") && !/[\s/\\]/.test(input)
}

function hostLike(input: string) {
  return input.includes(".") || input.includes(":") || input === "localhost"
}

function withSlash(input: string) {
  return input.endsWith("/") ? input : `${input}/`
}

function githubRemote(pathname: string, base: Option.Option<string>) {
  return Option.match(base, {
    onNone: () => `https://github.com/${pathname}.git`,
    onSome: (value) => new URL(`${pathname}.git`, withSlash(value)).href,
  })
}

// Input that is not an absolute URL has no URL form.
function parseUrl(input: string): Option.Option<URL> {
  return Result.getSuccess(Result.try(() => new URL(input)))
}

function buildRemote(
  input: { host: string; segments: string[]; remote?: string; protocol?: string },
  base: Option.Option<string>,
): Option.Option<RemoteReference> {
  const segments = input.segments.map(trimGitSuffix).filter(Boolean)
  if (!safeHost(input.host) || !segments.length || segments.some((segment) => !safeSegment(segment)))
    return Option.none()
  const repositoryPath = segments.join("/")
  const host = input.host.toLowerCase()
  return Option.some({
    host,
    path: repositoryPath,
    segments,
    ...(segments.length === 2 ? { owner: segments[0] } : {}),
    repo: segments[segments.length - 1],
    remote:
      input.remote ??
      (host === "github.com" ? githubRemote(repositoryPath, base) : `https://${host}/${repositoryPath}.git`),
    label: host === "github.com" && segments.length === 2 ? repositoryPath : `${host}/${repositoryPath}`,
    protocol: input.protocol,
  } satisfies RemoteReference)
}

function buildFile(input: { url: URL; remote: string }): Option.Option<FileReference> {
  const filePath = path.normalize(fileURLToPath(input.url))
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  if (!segments.length) return Option.none()
  return Option.some({
    host: "file",
    path: filePath,
    segments: segments.map((segment) => segment.replace(/:$/, "")),
    repo: trimGitSuffix(segments[segments.length - 1]),
    remote: input.remote,
    label: filePath,
    protocol: "file:",
  } satisfies FileReference)
}

export * as Repository from "./repository"

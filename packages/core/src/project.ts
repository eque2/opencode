export * as ProjectV2 from "./project"
export * as Project from "./project"

import { Array, Context, Effect, Layer, Option, Result, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "./schema"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { makeGlobalNode } from "./effect/app-node"
import { Hash } from "./util/hash"
import { ProjectDirectories } from "./project/directories"
import { ProjectSchema } from "./project/schema"

export const ID = ProjectSchema.ID
export type ID = ProjectSchema.ID

export const Vcs = ProjectSchema.Vcs
export type Vcs = ProjectSchema.Vcs

export class Info extends Schema.Class<Info>("Project.Info")({
  id: ID,
}) {}

export const DirectoriesInput = ProjectDirectories.ListInput
export type DirectoriesInput = typeof DirectoriesInput.Type

export const Directories = ProjectDirectories.ListOutput
export type Directories = typeof Directories.Type

export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
}

export interface Interface {
  readonly directories: (input: DirectoriesInput) => Effect.Effect<Directories>
  readonly resolve: (input: AbsolutePath) => Effect.Effect<Resolved>
  /**
   * Temporary bridge method for writing the resolved project ID to the repo-local cache.
   *
   * This exists while the old opencode project service and this core project
   * service work together: core resolves the ID, while the old service still owns
   * database migration and persistence. The old service should call this after it
   * finishes migrating from `resolve().previous` to `resolve().id`; once project
   * persistence moves into core, this separate bridge method can go away.
   */
  readonly commit: (input: { store: AbsolutePath; id: ID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectV2") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const projectDirectories = yield* ProjectDirectories.Service

    const directories = Effect.fn("Project.directories")(function* (input: DirectoriesInput) {
      return yield* projectDirectories.list(input.projectID)
    })

    const cached = Effect.fnUntraced(function* (dir: string) {
      return yield* fs.readFileString(path.join(dir, "opencode")).pipe(
        Effect.map((value) => Option.map(nonEmpty(value.trim()), (id) => ID.make(id))),
        Effect.catch(() => Effect.succeedNone),
      )
    })

    const remote = Effect.fnUntraced(function* (repo: Git.Repository) {
      const origin = Option.fromUndefinedOr(yield* git.remote.get(repo))
      return Option.map(Option.flatMap(origin, url), (normalized) => ID.make(Hash.fast(`git-remote:${normalized}`)))
    })

    // A URL remote keys on host and path; a file: URL has no remote identity; anything
    // that is not a URL is tried as an scp-style `user@host:path` remote.
    function url(input: string): Option.Option<string> {
      const value = input.trim()
      if (!value) return Option.none()
      return Option.match(Result.getSuccess(Result.try(() => new URL(value))), {
        onSome: (parsed) => (parsed.protocol === "file:" ? Option.none() : parts(parsed.hostname, parsed.pathname)),
        onNone: () => {
          const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
          return scp ? parts(scp[2], scp[3]) : Option.none()
        },
      })
    }

    function parts(host: string, name: string): Option.Option<string> {
      const pathname = name
        .replace(/^\/+/, "")
        .replace(/\.git\/?$/, "")
        .replace(/\/+$/, "")
      if (!host || !pathname) return Option.none()
      return Option.some(`${host.toLowerCase()}/${pathname}`)
    }

    const root = Effect.fnUntraced(function* (repo: Git.Repository) {
      return Option.map(Array.head(yield* git.history.rootCommits(repo)), (commit) => ID.make(commit))
    })

    const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
      const repo = yield* git.repo.discover(input)
      if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root) }

      const previous = yield* cached(repo.commonDirectory)
      // The remote identity wins, then the cached id, then the first root commit.
      const known = Option.orElse(yield* remote(repo), () => previous)
      const id = Option.isSome(known) ? known.value : Option.getOrElse(yield* root(repo), () => ID.global)
      return {
        ...(Option.isSome(previous) ? { previous: previous.value } : {}),
        id,
        directory: repo.worktree,
        vcs: { type: "git" as const, store: repo.commonDirectory },
      }
    })

    const commit = Effect.fn("Project.commit")(function* (input: { store: AbsolutePath; id: ID }) {
      yield* fs.writeFileString(path.join(input.store, "opencode"), input.id).pipe(Effect.ignore)
    })

    return Service.of({ directories, resolve, commit })
  }),
)

const nonEmpty = (value: string) => Option.liftPredicate(value, (text) => text.length > 0)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node],
})

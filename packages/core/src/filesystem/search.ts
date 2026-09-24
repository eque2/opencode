export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import { Context, Effect, Layer, MutableHashSet, Option, Schema, Scope } from "effect"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import type { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Flag } from "../flag/flag"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FileSystem/Search") {}

/** fff could not start for this location, so search answers with empty results. */
class FffInitError extends Schema.TaggedError<FffInitError>()("FileSystemSearch.FffInitError", {
  cause: Schema.Defect(),
}) {}

// A failed fff search is a defect: the Interface has no error channel.
const searched = <A>(found: Fff.Result<A>): Effect.Effect<A> =>
  found.ok ? Effect.succeed(found.value) : Effect.die(found.error)

export const ripgrepLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const scope = yield* Scope.Scope
    const state = {
      files: [] as string[],
      directories: [] as string[],
    }
    const directories = MutableHashSet.empty<string>()
    yield* ripgrep
      .find({
        cwd: location.directory,
        pattern: "*",
        limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
        onEntry: (entry) =>
          Effect.sync(() => {
            state.files.push(entry.path)
            const parts = entry.path.split("/")
            parts
              .slice(0, -1)
              .forEach((_, index) => MutableHashSet.add(directories, parts.slice(0, index + 1).join("/") + path.sep))
            state.directories = Array.from(directories)
          }),
      })
      .pipe(Effect.orDie, Effect.asVoid, Effect.forkIn(scope))
    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .glob({
              cwd,
              pattern: input.pattern,
              limit: input.limit ?? Number.MAX_SAFE_INTEGER,
            })
            .pipe(
              Effect.map((result) =>
                result.map((entry) =>
                  Entry.make({
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                    type: entry.type,
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      grep: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .grep({
              cwd,
              pattern: input.pattern,
              ...(info.type === "File" ? { file: path.basename(target) } : {}),
              include: input.include,
              limit: input.limit ?? Number.MAX_SAFE_INTEGER,
            })
            .pipe(
              Effect.map((result) =>
                result.map((match) =>
                  Match.make({
                    entry: Entry.make({
                      path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                      type: match.entry.type,
                    }),
                    line: match.line,
                    offset: match.offset,
                    text: match.text,
                    submatches: match.submatches,
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      find: (input) =>
        Effect.gen(function* () {
          const items =
            input.type === "file"
              ? state.files
              : input.type === "directory"
                ? state.directories
                : [...state.files, ...state.directories]
          return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
            const relative = item.target
            const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
            return Entry.make({
              path: RelativePath.make(relative),
              type,
            })
          })
        }),
    })
  }),
)

export const fffLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const picker = yield* Effect.try({
      try: () =>
        Fff.create({
          basePath: location.directory,
          aiMode: true,
          disableMmapCache: true,
          disableContentIndexing: true,
        }),
      catch: (cause) => new FffInitError({ cause }),
    }).pipe(
      Effect.flatMap((created) =>
        created.ok ? Effect.succeed(created.value) : Effect.fail(new FffInitError({ cause: created.error })),
      ),
      Effect.tapError((error) => Effect.logWarning("failed to initialize fff", { error: error.cause })),
      Effect.option,
    )
    if (Option.isNone(picker)) {
      return Service.of({
        find: () => Effect.succeed([]),
        glob: () => Effect.succeed([]),
        grep: () => Effect.succeed([]),
      })
    }
    const finder = picker.value
    yield* Effect.addFinalizer(() => Effect.sync(() => finder.destroy()).pipe(Effect.ignore))
    return Service.of({
      glob: (input) =>
        Effect.sync(() => {
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          return finder.glob(prefix ? `${prefix}/${input.pattern}` : input.pattern, {
            pageIndex: 0,
            pageSize: input.limit,
          })
        }).pipe(
          Effect.flatMap(searched),
          Effect.map((found) =>
            found.items.map((item) =>
              Entry.make({
                path: RelativePath.make(item.relativePath.replaceAll("\\", "/")),
                type: "file",
              }),
            ),
          ),
        ),
      grep: (input) =>
        Effect.sync(() => {
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          return finder.grep(
            [
              ...(prefix ? [`${prefix}/**`] : []),
              ...(input.include !== undefined ? [input.include] : []),
              input.pattern,
            ].join(" "),
            { mode: "regex", pageSize: input.limit, timeBudgetMs: 1_500 },
          )
        }).pipe(
          Effect.flatMap(searched),
          Effect.map((found) =>
            found.items.map((match) => {
              const bytes = Buffer.from(match.lineContent)
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(match.relativePath.replaceAll("\\", "/")),
                  type: "file",
                }),
                line: match.lineNumber,
                offset: match.byteOffset,
                text: match.lineContent.length > 2_000 ? match.lineContent.slice(0, 2_000) + "..." : match.lineContent,
                submatches: match.matchRanges.map(([start, end]) => ({
                  text: bytes.subarray(start, end).toString("utf8"),
                  start,
                  end,
                })),
              })
            }),
          ),
        ),
      find: (input) =>
        Effect.gen(function* () {
          const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
          const query = input.query.trim()
          const items =
            input.type === "file"
              ? yield* Effect.sync(() => finder.fileSearch(query, options)).pipe(
                  Effect.flatMap(searched),
                  Effect.map((found) =>
                    found.items.map((item, index) => ({
                      path: item.relativePath,
                      type: "file" as const,
                      score: found.scores[index]?.total ?? 0,
                    })),
                  ),
                )
              : input.type === "directory"
                ? yield* Effect.sync(() => finder.directorySearch(query, options)).pipe(
                    Effect.flatMap(searched),
                    Effect.map((found) =>
                      found.items.map((item, index) => ({
                        path: item.relativePath,
                        type: "directory" as const,
                        score: found.scores[index]?.total ?? 0,
                      })),
                    ),
                  )
                : yield* Effect.sync(() => finder.mixedSearch(query, options)).pipe(
                    Effect.flatMap(searched),
                    Effect.map((found) =>
                      found.items.map((item, index) => ({
                        path: item.item.relativePath,
                        type: item.type,
                        score: found.scores[index]?.total ?? 0,
                      })),
                    ),
                  )
          return items
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
            .map((item) => {
              const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
              return Entry.make({
                path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                type: item.type,
              })
            })
        }),
    })
  }),
)

const layer = Layer.unwrap(Effect.sync(() => (Flag.OPENCODE_DISABLE_FFF || !Fff.available() ? ripgrepLayer : fffLayer)))

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Location.node, Ripgrep.node] })

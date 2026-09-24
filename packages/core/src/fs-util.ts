import { dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from "path"
import { lookup } from "mime-types"
import { Context, Effect, FileSystem, Layer, Option, Predicate, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"
import { serviceUse } from "./effect/service-use"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"

export namespace FSUtil {
  export class FileSystemError extends Schema.TaggedError<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      const detail = Predicate.isError(this.cause)
        ? this.cause.message
        : Predicate.isString(this.cause)
          ? this.cause
          : ""
      return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
    }
  }

  export type Error = PlatformError | FileSystemError

  // JSON files hold any JSON value; callers decode the shape they expect.
  const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
  const encodeJsonText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    /**
     * The real path of `path`. A missing path resolves to its absolute form. Any other
     * realpath failure is a defect.
     */
    readonly resolve: (path: string) => Effect.Effect<string>
    /**
     * On Windows, the real path of `path`, so that equal paths compare equal. Any realpath
     * failure keeps the absolute form. Other platforms return `path` unchanged.
     */
    readonly normalizePath: (path: string) => Effect.Effect<string>
    /**
     * normalizePath for a permission pattern: a trailing `*` segment is kept, and the
     * folder before it is normalized. Other platforms return `pattern` unchanged.
     */
    readonly normalizePathPattern: (pattern: string) => Effect.Effect<string>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly scan: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

  export const use = serviceUse(Service)

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        // A missing or unreadable file is None; the Interface reports it as undefined.
        return yield* fs.readFileString(path).pipe(
          Effect.map(Option.some),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
          Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeedNone),
          Effect.map(Option.getOrUndefined),
        )
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      // stat follows symlinks, so a link is detected with readLink first. An entry that
      // cannot be stat'ed (removed while listing, or not accessible) is reported as "other".
      const entryType = Effect.fnUntraced(function* (entryPath: string) {
        if (Option.isSome(yield* Effect.option(fs.readLink(entryPath)))) return "symlink" as const
        const info = yield* Effect.option(fs.stat(entryPath))
        if (Option.isNone(info)) return "other" as const
        if (info.value.type === "Directory") return "directory" as const
        if (info.value.type === "File") return "file" as const
        return "other" as const
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        const names = yield* fs
          .readDirectory(dirPath)
          .pipe(Effect.mapError((cause) => new FileSystemError({ method: "readDirectoryEntries", cause })))
        return yield* Effect.forEach(
          names,
          (name) => entryType(join(dirPath, name)).pipe(Effect.map((type): DirEntry => ({ name, type }))),
          { concurrency: 16 },
        )
      })

      const resolve = Effect.fn("FileSystem.resolve")(function* (path: string) {
        const resolved = pathResolve(windowsPath(path))
        return yield* fs.realPath(resolved).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(resolved)),
          Effect.orDie,
        )
      })

      const normalizePath = Effect.fn("FileSystem.normalizePath")(function* (path: string) {
        if (process.platform !== "win32") return path
        const resolved = pathResolve(windowsPath(path))
        // Any realpath failure keeps the resolved path.
        return yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved))
      })

      const normalizePathPattern = Effect.fn("FileSystem.normalizePathPattern")(function* (pattern: string) {
        if (process.platform !== "win32") return pattern
        if (pattern === "*") return pattern
        const match = pattern.match(/^(.*)[\\/]\*$/)
        if (!match) return yield* normalizePath(pattern)
        const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
        return join(yield* normalizePath(dir), "*")
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* decodeJsonText(text).pipe(
          Effect.mapError((cause) => new FileSystemError({ method: "readJson", cause })),
        )
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = yield* encodeJsonText(data).pipe(
          Effect.mapError((cause) => new FileSystemError({ method: "writeJson", cause })),
        )
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true }).pipe(
          // Bun on Windows can throw EEXIST here despite recursive mode.
          // https://github.com/oven-sh/bun/issues/21901
          Effect.catchIf(
            (error) => error.reason._tag === "AlreadyExists",
            (error) => isDir(path).pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
          ),
        )
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const scan = Effect.fn("FileSystem.scan")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) result.push(search)
          }
          if (options.stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* scan(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          result.push(...matches)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        resolve,
        normalizePath,
        normalizePathPattern,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        scan,
        globMatch: Glob.match,
      })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [filesystem] })

  // Pure helpers that don't need Effect (path manipulation only). The realpath helpers
  // resolve, normalizePath and normalizePathPattern are Service methods.
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  export function overlaps(a: string, b: string) {
    return contains(a, b) || contains(b, a)
  }

  export function contains(parent: string, child: string) {
    const result = relative(parent, child)
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  }
}

import { Effect, FileSystem, Path, Result } from "effect"

// The `.spec` folder read into memory once, so every rule after the walk is a pure function. A read error is
// kept as data on the node it hit: the loader turns it into a rule failure and never fails itself.

export type Node = File | Folder | Other

export interface File {
  readonly kind: "file"
  readonly name: string
  readonly rel: string
  readonly text: Result.Result<string, string>
}

export interface Folder {
  readonly kind: "folder"
  readonly name: string
  readonly rel: string
  readonly entries: Result.Result<ReadonlyArray<Node>, string>
}

// Anything that is neither a regular file nor a folder: a socket, a device, a FIFO. `stat` follows symbolic links,
// so a link counts as what it points to, and a dangling link becomes a `File` whose text is the stat error.
export interface Other {
  readonly kind: "other"
  readonly name: string
  readonly rel: string
}

type Services = FileSystem.FileSystem | Path.Path

// Reads the folder at `dir`. The root node has the rel path "." and its entries have paths relative to it.
export const read = Effect.fnUntraced(function* (dir: string): Effect.fn.Return<Folder, never, Services> {
  const path = yield* Path.Path
  return {
    kind: "folder",
    name: path.basename(path.resolve(dir)),
    rel: ".",
    entries: yield* entriesOf(dir, ""),
  }
})

const entriesOf = Effect.fnUntraced(function* (
  dir: string,
  prefix: string,
): Effect.fn.Return<Result.Result<ReadonlyArray<Node>, string>, never, Services> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* Effect.result(fs.readDirectory(dir))
  if (Result.isFailure(names)) return Result.fail(names.failure.message)
  const nodes = yield* Effect.forEach(names.success.toSorted(), (name) =>
    nodeOf(path.join(dir, name), name, prefix === "" ? name : `${prefix}/${name}`),
  )
  return Result.succeed(nodes)
})

const nodeOf = Effect.fnUntraced(function* (
  location: string,
  name: string,
  rel: string,
): Effect.fn.Return<Node, never, Services> {
  const fs = yield* FileSystem.FileSystem
  const info = yield* Effect.result(fs.stat(location))
  if (Result.isFailure(info)) return { kind: "file", name, rel, text: Result.fail(info.failure.message) }
  if (info.success.type === "Directory") return { kind: "folder", name, rel, entries: yield* entriesOf(location, rel) }
  if (info.success.type !== "File") return { kind: "other", name, rel }
  const text = yield* Effect.result(fs.readFileString(location))
  return { kind: "file", name, rel, text: Result.mapError(text, (error) => error.message) }
})

export * as BlendTree from "./tree"

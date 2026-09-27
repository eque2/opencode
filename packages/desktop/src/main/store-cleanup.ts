import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Array as Arr, ByteSize, Clock, Data, Effect, FileSystem, Option, Predicate, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"

const EMPTY_STORE_MAX_BYTES = 128
const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DRAFT_KEEP_RECENT = 100

type StoreKind = "draft" | "workspace"
type StoreCandidate = {
  name: string
  path: string
  kind: StoreKind
  modified: number
  empty: boolean
}

class StoreFileError extends Data.TaggedError("StoreFileError")<{ readonly cause: unknown }> {}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export function cleanupStoreFiles(userDataPath: string, now?: number) {
  return Effect.runPromise(cleanupStores(userDataPath, now).pipe(Effect.provide(NodeFileSystem.layer)))
}

export function deleteStoreFileIfEmpty(userDataPath: string, name: string) {
  return Effect.runPromise(deleteEmptyStoreFile(userDataPath, name).pipe(Effect.provide(NodeFileSystem.layer)))
}

const cleanupStores = Effect.fnUntraced(function* (userDataPath: string, nowOverride?: number) {
  const fs = yield* FileSystem.FileSystem
  const now = nowOverride ?? (yield* Clock.currentTimeMillis)
  const names = yield* fs.readDirectory(userDataPath).pipe(Effect.orElseSucceed((): string[] => []))
  // storeCandidate keeps regular files only, through fileStats.
  const candidates = Arr.getSomes(
    yield* Effect.forEach(names, (name) => storeCandidate(userDataPath, name), { concurrency: "unbounded" }),
  )

  const expired = candidates.filter(
    (candidate) => candidate.empty || (candidate.kind === "draft" && now - candidate.modified > DRAFT_RETENTION_MS),
  )
  const overflow = candidates
    .filter((candidate) => candidate.kind === "draft" && !candidate.empty)
    .sort((a, b) => b.modified - a.modified)
    .slice(DRAFT_KEEP_RECENT)
  const stale = [...expired, ...overflow.filter((candidate) => !expired.includes(candidate))]

  const deleted = yield* Effect.forEach(
    stale,
    (candidate) => fs.remove(candidate.path, { force: true }).pipe(Effect.mapError(storeFileError), Effect.as(candidate.name)),
    { concurrency: "unbounded" },
  )

  return { scanned: candidates.length, deleted }
})

export const deleteEmptyStoreFile = Effect.fnUntraced(function* (userDataPath: string, name: string) {
  if (Option.isNone(storeKind(name))) return false

  const file = join(userDataPath, name)
  const stats = yield* fileStats(file)
  if (Option.isNone(stats)) return false
  if (!(yield* isEmptyStore(file, stats.value.size))) return false

  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(file, { force: true }).pipe(Effect.mapError(storeFileError))
  return true
})

const storeCandidate = Effect.fnUntraced(function* (userDataPath: string, name: string) {
  const kind = storeKind(name)
  if (Option.isNone(kind)) return Option.none<StoreCandidate>()

  const path = join(userDataPath, name)
  const stats = yield* fileStats(path)
  if (Option.isNone(stats)) return Option.none<StoreCandidate>()

  return Option.some({
    name,
    path,
    kind: kind.value,
    // Node.js always reports mtime, so the fallback only guards other backends.
    modified: Option.match(stats.value.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }),
    empty: yield* isEmptyStore(path, stats.value.size),
  })
})

function storeKind(name: string): Option.Option<StoreKind> {
  if (/^opencode\.draft\..+\.dat$/.test(name)) return Option.some("draft")
  if (/^opencode\.workspace\..+\.dat$/.test(name)) return Option.some("workspace")
  return Option.none()
}

const fileStats = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(file).pipe(Effect.option, Effect.map(Option.filter((stats) => stats.type === "File")))
})

const isEmptyStore = Effect.fnUntraced(function* (file: string, size: ByteSize.ByteSize) {
  if (Number(size) > EMPTY_STORE_MAX_BYTES) return false

  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(file, "utf8").pipe(Effect.option)
  return Option.match(raw, {
    onNone: () => false,
    onSome: (text) =>
      text.trim() === "" ||
      Option.exists(decodeJson(text), (parsed) => Predicate.isObject(parsed) && Object.keys(parsed).length === 0),
  })
})

// The rejected Promise keeps the Node.js error, which PlatformError keeps as its cause.
function storeFileError(error: PlatformError) {
  return new StoreFileError({ cause: error.cause ?? error })
}

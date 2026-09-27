import { readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { Array as Arr, Clock, Data, Effect, Option, Predicate, Schema } from "effect"

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
  return Effect.runPromise(cleanupStores(userDataPath, now))
}

export function deleteStoreFileIfEmpty(userDataPath: string, name: string) {
  return Effect.runPromise(deleteEmptyStoreFile(userDataPath, name))
}

const cleanupStores = Effect.fnUntraced(function* (userDataPath: string, nowOverride?: number) {
  const now = nowOverride ?? (yield* Clock.currentTimeMillis)
  const entries = yield* attempt(() => readdir(userDataPath, { withFileTypes: true })).pipe(
    Effect.orElseSucceed(() => []),
  )
  const candidates = Arr.getSomes(
    yield* Effect.forEach(
      entries.filter((entry) => entry.isFile()),
      (entry) => storeCandidate(userDataPath, entry.name),
      { concurrency: "unbounded" },
    ),
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
    (candidate) => attempt(() => rm(candidate.path, { force: true })).pipe(Effect.as(candidate.name)),
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

  yield* attempt(() => rm(file, { force: true }))
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
    modified: stats.value.mtimeMs,
    empty: yield* isEmptyStore(path, stats.value.size),
  })
})

function storeKind(name: string): Option.Option<StoreKind> {
  if (/^opencode\.draft\..+\.dat$/.test(name)) return Option.some("draft")
  if (/^opencode\.workspace\..+\.dat$/.test(name)) return Option.some("workspace")
  return Option.none()
}

function fileStats(file: string) {
  return attempt(() => stat(file)).pipe(Effect.option, Effect.map(Option.filter((stats) => stats.isFile())))
}

const isEmptyStore = Effect.fnUntraced(function* (file: string, size: number) {
  if (size > EMPTY_STORE_MAX_BYTES) return false

  const raw = yield* attempt(() => readFile(file, "utf8")).pipe(Effect.option)
  return Option.match(raw, {
    onNone: () => false,
    onSome: (text) =>
      text.trim() === "" ||
      Option.exists(decodeJson(text), (parsed) => Predicate.isObject(parsed) && Object.keys(parsed).length === 0),
  })
})

function attempt<A>(evaluate: () => Promise<A>) {
  return Effect.tryPromise({ try: evaluate, catch: (cause) => new StoreFileError({ cause }) })
}

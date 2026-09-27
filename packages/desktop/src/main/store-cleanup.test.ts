import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Array as Arr, DateTime, Effect, FileSystem, MutableHashSet, Order } from "effect"
import { cleanupStoreFiles, deleteStoreFileIfEmpty } from "./store-cleanup"

const roots = MutableHashSet.empty<string>()

// Runs one Node.js filesystem step. A test fixture failure is a defect.
const withFs = <A, E>(use: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>) =>
  FileSystem.FileSystem.pipe(Effect.flatMap(use), Effect.orDie, Effect.provide(NodeFileSystem.layer))

const tempRoot = Effect.fnUntraced(function* () {
  const root = yield* withFs((fs) => fs.makeTempDirectory({ prefix: "opencode-store-cleanup-" }))
  MutableHashSet.add(roots, root)
  return root
})

const writeStore = Effect.fnUntraced(function* (
  root: string,
  name: string,
  value: string,
  modified: DateTime.DateTime,
) {
  yield* withFs((fs) => fs.writeFileString(join(root, name), value))
  yield* withFs((fs) => fs.utimes(join(root, name), DateTime.toDate(modified), DateTime.toDate(modified)))
})

const listRoot = (root: string) => withFs((fs) => fs.readDirectory(root))

afterEach(() => {
  const pending = [...roots]
  MutableHashSet.clear(roots)
  return Effect.runPromise(
    Effect.forEach(pending, (root) => withFs((fs) => fs.remove(root, { recursive: true, force: true })), {
      concurrency: "unbounded",
      discard: true,
    }),
  )
})

describe("store cleanup", () => {
  test("removes empty scoped stores and leaves global stores alone", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* tempRoot()
        const now = DateTime.makeUnsafe("2026-07-01T00:00:00.000Z")
        yield* writeStore(root, "opencode.draft.empty.dat", "{}", now)
        yield* writeStore(root, "opencode.workspace.empty.dat", "{\n}", now)
        yield* writeStore(root, "opencode.global.dat", "{}", now)
        yield* writeStore(root, "opencode.workspace.empty.dat.json", "{}", now)

        const result = yield* Effect.promise(() => cleanupStoreFiles(root, DateTime.toEpochMillis(now)))

        expect(Arr.sort(result.deleted, Order.String)).toEqual([
          "opencode.draft.empty.dat",
          "opencode.workspace.empty.dat",
        ])
        expect((yield* listRoot(root)).sort()).toEqual(["opencode.global.dat", "opencode.workspace.empty.dat.json"])
      }),
    ))

  test("removes stale drafts by age without removing non-empty workspace stores", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* tempRoot()
        const now = DateTime.makeUnsafe("2026-07-01T00:00:00.000Z")
        yield* writeStore(
          root,
          "opencode.draft.old.dat",
          '{"draft:prompt":"hello"}',
          DateTime.makeUnsafe("2026-05-01T00:00:00.000Z"),
        )
        yield* writeStore(root, "opencode.draft.recent.dat", '{"draft:prompt":"hello"}', now)
        yield* writeStore(
          root,
          "opencode.workspace.old.dat",
          '{"workspace:layout":"wide"}',
          DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"),
        )
        yield* writeStore(root, "opencode.workspace.recent.dat", '{"workspace:layout":"wide"}', now)

        const result = yield* Effect.promise(() => cleanupStoreFiles(root, DateTime.toEpochMillis(now)))

        expect(result.deleted).toEqual(["opencode.draft.old.dat"])
        expect((yield* listRoot(root)).sort()).toEqual([
          "opencode.draft.recent.dat",
          "opencode.workspace.old.dat",
          "opencode.workspace.recent.dat",
        ])
      }),
    ))

  test("caps scoped stores by recency", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* tempRoot()
        const now = DateTime.makeUnsafe("2026-07-01T00:00:00.000Z")
        yield* Effect.forEach(
          Array.from({ length: 102 }, (_, index) => index),
          (index) =>
            writeStore(
              root,
              `opencode.draft.${index}.dat`,
              '{"draft:prompt":"hello"}',
              DateTime.subtract(now, { seconds: index }),
            ),
          { concurrency: "unbounded", discard: true },
        )

        const result = yield* Effect.promise(() => cleanupStoreFiles(root, DateTime.toEpochMillis(now)))

        const remaining = yield* listRoot(root)

        expect(Arr.sort(result.deleted, Order.String)).toEqual(["opencode.draft.100.dat", "opencode.draft.101.dat"])
        expect(remaining).toHaveLength(100)
      }),
    ))

  test("removes a scoped store immediately when it becomes empty", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const root = yield* tempRoot()
        yield* writeStore(root, "opencode.draft.empty.dat", "{}", DateTime.makeUnsafe("2026-07-01T00:00:00.000Z"))
        yield* writeStore(root, "opencode.global.dat", "{}", DateTime.makeUnsafe("2026-07-01T00:00:00.000Z"))

        expect(yield* Effect.promise(() => deleteStoreFileIfEmpty(root, "opencode.draft.empty.dat"))).toBe(true)
        expect(yield* Effect.promise(() => deleteStoreFileIfEmpty(root, "opencode.global.dat"))).toBe(false)
        expect(yield* listRoot(root)).toEqual(["opencode.global.dat"])
      }),
    ))
})

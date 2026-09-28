import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Exit, FileSystem } from "effect"
import {
  AttachmentPickerError,
  assertAttachmentBudget,
  createPickedFileAuthorizations,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
} from "./attachment-picker"

const withTempDirectory = <A, E>(use: (directory: string, fs: FileSystem.FileSystem) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-attachment-" }).pipe(Effect.orDie)
    return yield* use(directory, fs)
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))

describe("assertAttachmentBudget", () => {
  test("accepts selections within the media ingest limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          assertAttachmentBudget([{ size: MAX_ATTACHMENT_BYTES / 2 }, { size: MAX_ATTACHMENT_BYTES / 2 }]),
        )
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ))

  test("rejects the selection before files are read when its total exceeds the limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(assertAttachmentBudget([{ size: MAX_ATTACHMENT_BYTES }, { size: 1 }]))
        expect(error.message).toContain("20 MB limit")
      }),
    ))

  test("reads an approved file through a bounded buffer", () =>
    Effect.runPromise(
      withTempDirectory((directory, fs) =>
        Effect.gen(function* () {
          const file = join(directory, "example.txt")
          yield* fs.writeFileString(file, "lorem ipsum").pipe(Effect.orDie)
          expect(new TextDecoder().decode(yield* readAttachment(file))).toBe("lorem ipsum")
        }),
      ),
    ))

  test("rejects an oversized file before allocating its contents", () =>
    Effect.runPromise(
      withTempDirectory((directory, fs) =>
        Effect.gen(function* () {
          const file = join(directory, "oversized.txt")
          yield* fs.writeFileString(file, "").pipe(Effect.orDie)
          yield* fs.truncate(file, MAX_ATTACHMENT_BYTES + 1).pipe(Effect.orDie)
          const error = yield* Effect.flip(readAttachment(file))
          expect(error.message).toContain("20 MB limit")
        }),
      ),
    ))
})

describe("picked file authorizations", () => {
  const read = (path: string) => Effect.succeed(new TextEncoder().encode(path).buffer)

  test("keeps concurrent picker selections isolated", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authorizations = createPickedFileAuthorizations(read)
        const first = authorizations.add(1, ["a.txt", "b.txt"])
        const second = authorizations.add(1, ["c.txt"])

        expect(new TextDecoder().decode(yield* authorizations.read(1, first, "a.txt"))).toBe("a.txt")
        expect(new TextDecoder().decode(yield* authorizations.read(1, second, "c.txt"))).toBe("c.txt")
        expect(new TextDecoder().decode(yield* authorizations.read(1, first, "b.txt"))).toBe("b.txt")
      }),
    ))

  test("releases unread files for one picker without affecting another", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authorizations = createPickedFileAuthorizations(read)
        const first = authorizations.add(1, ["a.txt"])
        const second = authorizations.add(1, ["b.txt"])
        authorizations.release(1, first)

        const error = yield* Effect.flip(authorizations.read(1, first, "a.txt"))
        expect(error.message).toContain("not selected")
        expect(new TextDecoder().decode(yield* authorizations.read(1, second, "b.txt"))).toBe("b.txt")
      }),
    ))

  test("keeps picker tokens scoped to their renderer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authorizations = createPickedFileAuthorizations(read)
        const token = authorizations.add(1, ["a.txt"])

        const error = yield* Effect.flip(authorizations.read(2, token, "a.txt"))
        expect(error.message).toContain("not selected")
      }),
    ))

  test("charges actual reads against the selection budget", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authorizations = createPickedFileAuthorizations(
          (_path, maxBytes) =>
            6 > maxBytes
              ? Effect.fail(new AttachmentPickerError({ message: "budget exceeded" }))
              : Effect.succeed(new ArrayBuffer(6)),
          10,
        )
        const token = authorizations.add(1, ["a.txt", "b.txt"])

        yield* authorizations.read(1, token, "a.txt")
        const error = yield* Effect.flip(authorizations.read(1, token, "b.txt"))
        expect(error.message).toContain("budget exceeded")
      }),
    ))
})

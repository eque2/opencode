import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import {
  AttachmentPickerError,
  assertAttachmentBudget,
  createPickedFileAuthorizations,
  MAX_ATTACHMENT_BYTES,
  readAttachment,
} from "./attachment-picker"

const withTempDirectory = <A, E>(use: (directory: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "opencode-attachment-"))),
    use,
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )

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
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const file = join(directory, "example.txt")
          yield* Effect.promise(() => writeFile(file, "lorem ipsum"))
          expect(new TextDecoder().decode(yield* readAttachment(file))).toBe("lorem ipsum")
        }),
      ),
    ))

  test("rejects an oversized file before allocating its contents", () =>
    Effect.runPromise(
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const file = join(directory, "oversized.txt")
          yield* Effect.promise(() => writeFile(file, ""))
          yield* Effect.promise(() => truncate(file, MAX_ATTACHMENT_BYTES + 1))
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

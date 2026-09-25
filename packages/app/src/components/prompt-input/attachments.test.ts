import { describe, expect, test } from "bun:test"
import { Data, Effect, Option } from "effect"
import { attachmentMime, pickAttachmentFiles } from "./files"
import { pasteMode } from "./paste"

class PickerUnavailableError extends Data.TaggedError("PickerUnavailableError")<{ readonly message: string }> {}

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
        expect(Option.getOrUndefined(yield* attachmentMime(file))).toBe("application/pdf")
      }),
    ))

  test("normalizes structured text types to text/plain", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
        expect(Option.getOrUndefined(yield* attachmentMime(file))).toBe("text/plain")
      }),
    ))

  test("accepts text files even with a misleading browser mime", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
        expect(Option.getOrUndefined(yield* attachmentMime(file))).toBe("text/plain")
      }),
    ))

  test("rejects binary files", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
        expect(Option.getOrUndefined(yield* attachmentMime(file))).toBeUndefined()
      }),
    ))
})

describe("pickAttachmentFiles", () => {
  test("reads the current project directory for every native picker invocation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let paths: ReadonlyArray<string> = []
        let files: ReadonlyArray<File> = []
        const file = new File(["hello"], "hello.txt", { type: "text/plain" })
        let directory = "C:\\Projects\\LoremIpsum"
        const picker = (options?: { defaultPath?: string }, onFile?: (file: File) => Promise<unknown>) =>
          Effect.runPromise(
            Effect.gen(function* () {
              paths = [...paths, options?.defaultPath ?? ""]
              if (onFile) yield* Effect.promise(() => onFile(file))
            }),
          )

        pickAttachmentFiles({
          picker,
          directory: () => directory,
          fallback: () => {},
          onFile: (selected) =>
            Effect.runPromise(
              Effect.sync(() => {
                files = [...files, selected]
              }),
            ),
          onError: () => {},
        })
        yield* Effect.yieldNow
        directory = "C:\\Projects\\DolorSit"
        pickAttachmentFiles({
          picker,
          directory: () => directory,
          fallback: () => {},
          onFile: (selected) =>
            Effect.runPromise(
              Effect.sync(() => {
                files = [...files, selected]
              }),
            ),
          onError: () => {},
        })
        yield* Effect.yieldNow
        expect(files).toEqual([file, file])
        expect(paths).toEqual(["C:\\Projects\\LoremIpsum", "C:\\Projects\\DolorSit"])
      }),
    ))

  test("uses the browser file input when no native picker exists", () => {
    let fallback = 0
    pickAttachmentFiles({
      directory: () => "/projects/consectetur-adipiscing",
      fallback: () => {
        fallback += 1
      },
      onFile: () => Effect.runPromise(Effect.void),
      onError: () => {},
    })
    expect(fallback).toBe(1)
  })

  test("reports native picker failures without rejecting", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = new PickerUnavailableError({ message: "picker unavailable" })
        let errors: ReadonlyArray<unknown> = []
        const handled = Promise.withResolvers<void>()
        pickAttachmentFiles({
          picker: () => Effect.runPromise(Effect.fail(error)),
          directory: () => "C:\\Projects\\LoremIpsum",
          fallback: () => {},
          onFile: () => Effect.runPromise(Effect.void),
          onError: (cause) => {
            errors = [...errors, cause]
            handled.resolve()
          },
        })
        yield* Effect.promise(() => handled.promise)
        expect(errors).toEqual([error])
      }),
    ))
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})

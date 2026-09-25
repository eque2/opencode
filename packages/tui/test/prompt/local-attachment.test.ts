import { describe, expect, test } from "bun:test"
import { Data, Effect, Option } from "effect"
import path from "node:path"
import { readLocalAttachment, readLocalAttachmentWith } from "../../src/component/prompt/local-attachment"
import type { LocalFiles } from "../../src/component/prompt/local-attachment"
import { tmpdir } from "../fixture/fixture"

class ReadFailed extends Data.TaggedError("ReadFailed")<{ readonly path: string }> {}

function files(input: { mime: string; text?: string; bytes?: Uint8Array }): LocalFiles {
  return {
    mime: () => Effect.succeed(input.mime),
    readText: () => Effect.succeed(input.text ?? ""),
    readBytes: () => Effect.succeed(input.bytes ?? new Uint8Array()),
  }
}

function read(local: LocalFiles, file: string) {
  return Effect.runPromise(readLocalAttachmentWith(local, file).pipe(Effect.map(Option.getOrUndefined)))
}

describe("prompt local attachments", () => {
  test("reads SVG attachments as text", async () => {
    expect(await read(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "text",
      mime: "image/svg+xml",
      content: "<svg />",
    })
  })

  test("reads image and PDF attachments as bytes", async () => {
    const content = new Uint8Array([1, 2, 3])
    expect(await read(files({ mime: "application/pdf", bytes: content }), "/tmp/file.pdf")).toEqual({
      type: "binary",
      mime: "application/pdf",
      content,
    })
  })

  test("ignores unsupported and unreadable local files", async () => {
    expect(await read(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()
    expect(
      await read(
        {
          ...files({ mime: "image/png" }),
          readBytes: (file) => Effect.fail(new ReadFailed({ path: file })),
        },
        "/tmp/missing.png",
      ),
    ).toBeUndefined()
  })

  test("reads local files from disk", async () => {
    await using tmp = await tmpdir()
    const svg = path.join(tmp.path, "image.svg")
    const png = path.join(tmp.path, "image.PNG")
    const bytes = new Uint8Array([137, 80, 78, 71])
    await Bun.write(svg, "<svg />")
    await Bun.write(png, bytes)

    expect(await readLocalAttachment(svg)).toEqual({ type: "text", mime: "image/svg+xml", content: "<svg />" })
    expect(await readLocalAttachment(png)).toEqual({ type: "binary", mime: "image/png", content: bytes })
    expect(await readLocalAttachment(path.join(tmp.path, "missing.png"))).toBeUndefined()
    expect(await readLocalAttachment(path.join(tmp.path, "notes.txt"))).toBeUndefined()
  })
})

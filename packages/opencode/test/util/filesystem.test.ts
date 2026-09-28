// The cases of the retired util/filesystem module, run against its FSUtil replacements.
// The core FSUtil suite does not cover these behaviours.
import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Exit, Schema, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

// A scoped temp directory at its real path, as the tmpdir fixture gives it.
const tmpdir = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "opencode-test-" }))
})

const encoder = new TextEncoder()

// A Web ReadableStream that emits each chunk, then closes.
function webStream(chunks: ReadonlyArray<Uint8Array>) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    },
  })
}

// Writes a Web stream to a file as the LSP download does: ensureDir, then the FSUtil sink.
const writeStream = Effect.fnUntraced(function* (file: string, stream: ReadableStream<Uint8Array>, mode?: number) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(path.dirname(file))
  yield* Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }).pipe(
    Stream.run(fs.sink(file)),
  )
  if (mode) yield* fs.chmod(file, mode)
})

const decodeConfig = Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.String, version: Schema.Number }))

describe("filesystem", () => {
  describe("existsSafe()", () => {
    it.live("returns true for existing file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.txt")
        yield* fs.writeFileString(filepath, "content")

        expect(yield* fs.existsSafe(filepath)).toBe(true)
      }),
    )

    it.live("returns false for non-existent file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "does-not-exist.txt")

        expect(yield* fs.existsSafe(filepath)).toBe(false)
      }),
    )

    it.live("returns true for existing directory", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const dirpath = path.join(yield* tmpdir, "subdir")
        yield* fs.makeDirectory(dirpath)

        expect(yield* fs.existsSafe(dirpath)).toBe(true)
      }),
    )
  })

  describe("isDir()", () => {
    it.live("returns true for directory", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const dirpath = path.join(yield* tmpdir, "testdir")
        yield* fs.makeDirectory(dirpath)

        expect(yield* fs.isDir(dirpath)).toBe(true)
      }),
    )

    it.live("returns false for file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.txt")
        yield* fs.writeFileString(filepath, "content")

        expect(yield* fs.isDir(filepath)).toBe(false)
      }),
    )

    it.live("returns false for non-existent path", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "does-not-exist")

        expect(yield* fs.isDir(filepath)).toBe(false)
      }),
    )
  })

  describe("stat().size", () => {
    it.live("returns file size", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.txt")
        const content = "Hello, World!"
        yield* fs.writeFileString(filepath, content)

        expect(Number((yield* fs.stat(filepath)).size)).toBe(content.length)
      }),
    )

    // Filesystem.size returned 0 for a missing file. FSUtil.stat fails, so each caller picks its fallback.
    it.live("fails for non-existent file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "does-not-exist.txt")

        expect(Exit.isFailure(yield* Effect.exit(fs.stat(filepath)))).toBe(true)
      }),
    )

    it.live("returns directory size", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const dirpath = path.join(yield* tmpdir, "testdir")
        yield* fs.makeDirectory(dirpath)

        // Directories have size on some systems
        const size = Number((yield* fs.stat(dirpath)).size)
        expect(typeof size).toBe("number")
      }),
    )
  })

  describe("findUp() and up()", () => {
    it.live("keeps previous nearest-first behavior for single target", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const root = yield* tmpdir
        const parent = path.join(root, "parent")
        const child = path.join(parent, "child")
        yield* fs.makeDirectory(child, { recursive: true })
        yield* fs.writeFileString(path.join(root, "marker"), "root")
        yield* fs.writeFileString(path.join(parent, "marker"), "parent")

        const result = yield* fs.findUp("marker", child, root)

        expect(result).toEqual([path.join(parent, "marker"), path.join(root, "marker")])
      }),
    )

    it.live("respects stop boundary", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const root = yield* tmpdir
        const parent = path.join(root, "parent")
        const child = path.join(parent, "child")
        yield* fs.makeDirectory(child, { recursive: true })
        yield* fs.writeFileString(path.join(root, "marker"), "root")
        yield* fs.writeFileString(path.join(parent, "marker"), "parent")

        const result = yield* fs.findUp("marker", child, parent)

        expect(result).toEqual([path.join(parent, "marker")])
      }),
    )

    it.live("supports multiple targets with nearest-first default ordering", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const root = yield* tmpdir
        const parent = path.join(root, "parent")
        const child = path.join(parent, "child")
        yield* fs.makeDirectory(child, { recursive: true })

        yield* fs.writeFileString(path.join(parent, "cfg.jsonc"), "{}")
        yield* fs.writeFileString(path.join(root, "cfg.json"), "{}")
        yield* fs.writeFileString(path.join(root, "cfg.jsonc"), "{}")

        const result = yield* fs.up({ targets: ["cfg.json", "cfg.jsonc"], start: child, stop: root })

        expect(result).toEqual([
          path.join(parent, "cfg.jsonc"),
          path.join(root, "cfg.json"),
          path.join(root, "cfg.jsonc"),
        ])
      }),
    )
  })

  describe("readFileString()", () => {
    it.live("reads file content", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.txt")
        const content = "Hello, World!"
        yield* fs.writeFileString(filepath, content)

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )

    it.live("fails for non-existent file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "does-not-exist.txt")

        expect(yield* Effect.flip(fs.readFileString(filepath))).toBeInstanceOf(Error)
      }),
    )

    it.live("reads UTF-8 content correctly", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "unicode.txt")
        const content = "Hello 世界 🌍"
        yield* fs.writeFileString(filepath, content)

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )
  })

  describe("readJson()", () => {
    it.live("reads and parses JSON", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.json")
        const data = { key: "value", nested: { array: [1, 2, 3] } }
        yield* fs.writeFileString(filepath, '{"key":"value","nested":{"array":[1,2,3]}}')

        expect(yield* fs.readJson(filepath)).toEqual(data)
      }),
    )

    it.live("fails for invalid JSON", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "invalid.json")
        yield* fs.writeFileString(filepath, "{ invalid json")

        expect(yield* Effect.flip(fs.readJson(filepath))).toBeInstanceOf(Error)
      }),
    )

    it.live("fails for non-existent file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "does-not-exist.json")

        expect(yield* Effect.flip(fs.readJson(filepath))).toBeInstanceOf(Error)
      }),
    )

    it.live("returns typed data after a Schema decode", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "typed.json")
        yield* fs.writeFileString(filepath, '{"name":"test","version":1}')

        const result = yield* decodeConfig(yield* fs.readJson(filepath))
        expect(result.name).toBe("test")
        expect(result.version).toBe(1)
      }),
    )
  })

  describe("readFile()", () => {
    it.live("reads file as bytes", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.txt")
        const content = "Hello, World!"
        yield* fs.writeFileString(filepath, content)

        const bytes = yield* fs.readFile(filepath)
        expect(bytes).toBeInstanceOf(Uint8Array)
        expect(Buffer.from(bytes).toString("utf-8")).toBe(content)
      }),
    )

    it.live("fails for non-existent file", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "does-not-exist.bin")

        expect(yield* Effect.flip(fs.readFile(filepath))).toBeInstanceOf(Error)
      }),
    )
  })

  describe("writeWithDirs()", () => {
    it.live("writes text content", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.txt")
        const content = "Hello, World!"

        yield* fs.writeWithDirs(filepath, content)

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )

    it.live("writes buffer content", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "test.bin")
        const content = Buffer.from([0x00, 0x01, 0x02, 0x03])

        yield* fs.writeWithDirs(filepath, content)

        expect(Buffer.from(yield* fs.readFile(filepath))).toEqual(content)
      }),
    )

    it.live("writes with permissions", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "protected.txt")

        yield* fs.writeWithDirs(filepath, "secret", 0o600)

        const stats = yield* fs.stat(filepath)
        // Check permissions on Unix
        if (process.platform !== "win32") {
          expect(stats.mode & 0o777).toBe(0o600)
        }
      }),
    )

    it.live("creates parent directories", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "nested", "deep", "file.txt")
        const content = "nested content"

        yield* fs.writeWithDirs(filepath, content)

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )
  })

  describe("writeJson()", () => {
    it.live("writes JSON data", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "data.json")
        const data = { key: "value", number: 42 }

        yield* fs.writeJson(filepath, data)

        expect(yield* fs.readJson(filepath)).toEqual(data)
      }),
    )

    it.live("writes formatted JSON", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "pretty.json")

        yield* fs.writeJson(filepath, { key: "value" })

        const content = yield* fs.readFileString(filepath)
        expect(content).toContain("\n")
        expect(content).toContain("  ")
      }),
    )

    it.live("writes with permissions", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "config.json")

        yield* fs.writeJson(filepath, { secret: "data" }, 0o600)

        const stats = yield* fs.stat(filepath)
        if (process.platform !== "win32") {
          expect(stats.mode & 0o777).toBe(0o600)
        }
      }),
    )
  })

  describe("mimeType()", () => {
    test("returns correct MIME type for JSON", () => {
      expect(FSUtil.mimeType("test.json")).toContain("application/json")
    })

    test("returns correct MIME type for JavaScript", () => {
      expect(FSUtil.mimeType("test.js")).toContain("javascript")
    })

    test("returns MIME type for TypeScript (or video/mp2t due to extension conflict)", () => {
      const mime = FSUtil.mimeType("test.ts")
      // .ts is ambiguous: TypeScript vs MPEG-2 TS video
      expect(mime === "video/mp2t" || mime === "application/typescript" || mime === "text/typescript").toBe(true)
    })

    test("returns correct MIME type for images", () => {
      expect(FSUtil.mimeType("test.png")).toContain("image/png")
      expect(FSUtil.mimeType("test.jpg")).toContain("image/jpeg")
    })

    test("returns default for unknown extension", () => {
      expect(FSUtil.mimeType("test.unknown")).toBe("application/octet-stream")
    })

    test("handles files without extension", () => {
      expect(FSUtil.mimeType("Makefile")).toBe("application/octet-stream")
    })
  })

  describe("windowsPath()", () => {
    test("converts Git Bash paths", () => {
      if (process.platform === "win32") {
        expect(FSUtil.windowsPath("/c/Users/test")).toBe("C:/Users/test")
        expect(FSUtil.windowsPath("/d/dev/project")).toBe("D:/dev/project")
      } else {
        expect(FSUtil.windowsPath("/c/Users/test")).toBe("/c/Users/test")
      }
    })

    test("converts Cygwin paths", () => {
      if (process.platform === "win32") {
        expect(FSUtil.windowsPath("/cygdrive/c/Users/test")).toBe("C:/Users/test")
        expect(FSUtil.windowsPath("/cygdrive/x/dev/project")).toBe("X:/dev/project")
      } else {
        expect(FSUtil.windowsPath("/cygdrive/c/Users/test")).toBe("/cygdrive/c/Users/test")
      }
    })

    test("converts WSL paths", () => {
      if (process.platform === "win32") {
        expect(FSUtil.windowsPath("/mnt/c/Users/test")).toBe("C:/Users/test")
        expect(FSUtil.windowsPath("/mnt/z/dev/project")).toBe("Z:/dev/project")
      } else {
        expect(FSUtil.windowsPath("/mnt/c/Users/test")).toBe("/mnt/c/Users/test")
      }
    })

    test("ignores normal Windows paths", () => {
      expect(FSUtil.windowsPath("C:/Users/test")).toBe("C:/Users/test")
      expect(FSUtil.windowsPath("D:\\dev\\project")).toBe("D:\\dev\\project")
    })
  })

  describe("sink() stream writes", () => {
    it.live("writes from Web ReadableStream", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "streamed.txt")
        const content = "Hello from stream!"

        yield* writeStream(filepath, webStream([encoder.encode(content)]))

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )

    it.live("writes from Node.js Readable stream", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "node-streamed.txt")
        const content = "Hello from Node stream!"
        const { Readable } = yield* Effect.promise(() => import("stream"))

        yield* fs.ensureDir(path.dirname(filepath))
        yield* Stream.fromAsyncIterable(Readable.from([encoder.encode(content)]), (cause) => cause).pipe(
          Stream.run(fs.sink(filepath)),
        )

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )

    it.live("writes binary data from Web ReadableStream", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "binary.dat")
        const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff])

        yield* writeStream(filepath, webStream([binaryData]))

        expect(Buffer.from(yield* fs.readFile(filepath))).toEqual(Buffer.from(binaryData))
      }),
    )

    it.live("writes large content in chunks", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "large.txt")
        const chunks = ["chunk1", "chunk2", "chunk3", "chunk4", "chunk5"]

        yield* writeStream(filepath, webStream(chunks.map((chunk) => encoder.encode(chunk))))

        expect(yield* fs.readFileString(filepath)).toBe(chunks.join(""))
      }),
    )

    it.live("creates parent directories", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "nested", "deep", "streamed.txt")
        const content = "nested stream content"

        yield* writeStream(filepath, webStream([encoder.encode(content)]))

        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )

    it.live("writes with permissions", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "protected-stream.txt")

        yield* writeStream(filepath, webStream([encoder.encode("secret stream content")]), 0o600)

        const stats = yield* fs.stat(filepath)
        if (process.platform !== "win32") {
          expect(stats.mode & 0o777).toBe(0o600)
        }
      }),
    )

    it.live("writes executable with permissions", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const filepath = path.join(yield* tmpdir, "script.sh")
        const content = "#!/bin/bash\necho hello"

        yield* writeStream(filepath, webStream([encoder.encode(content)]), 0o755)

        const stats = yield* fs.stat(filepath)
        if (process.platform !== "win32") {
          expect(stats.mode & 0o777).toBe(0o755)
        }
        expect(yield* fs.readFileString(filepath)).toBe(content)
      }),
    )
  })

  describe("resolve()", () => {
    it.live("resolves slash-prefixed drive paths on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const forward = tmp.replaceAll("\\", "/")
        expect(yield* fs.resolve(`/${forward}`)).toBe(yield* fs.normalizePath(tmp))
      }),
    )

    it.live("resolves slash-prefixed drive roots on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const drive = (yield* tmpdir)[0].toUpperCase()
        expect(yield* fs.resolve(`/${drive}:`)).toBe(yield* fs.resolve(`${drive}:/`))
      }),
    )

    it.live("resolves Git Bash and MSYS2 paths on Windows", () =>
      Effect.gen(function* () {
        // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const drive = tmp[0].toLowerCase()
        const rest = tmp.slice(2).replaceAll("\\", "/")
        expect(yield* fs.resolve(`/${drive}${rest}`)).toBe(yield* fs.normalizePath(tmp))
      }),
    )

    it.live("resolves Git Bash and MSYS2 drive roots on Windows", () =>
      Effect.gen(function* () {
        // Git Bash and MSYS2 both use /<drive> paths on Windows.
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const drive = (yield* tmpdir)[0].toLowerCase()
        expect(yield* fs.resolve(`/${drive}`)).toBe(yield* fs.resolve(`${drive.toUpperCase()}:/`))
      }),
    )

    it.live("resolves Cygwin paths on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const drive = tmp[0].toLowerCase()
        const rest = tmp.slice(2).replaceAll("\\", "/")
        expect(yield* fs.resolve(`/cygdrive/${drive}${rest}`)).toBe(yield* fs.normalizePath(tmp))
      }),
    )

    it.live("resolves Cygwin drive roots on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const drive = (yield* tmpdir)[0].toLowerCase()
        expect(yield* fs.resolve(`/cygdrive/${drive}`)).toBe(yield* fs.resolve(`${drive.toUpperCase()}:/`))
      }),
    )

    it.live("resolves WSL mount paths on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const drive = tmp[0].toLowerCase()
        const rest = tmp.slice(2).replaceAll("\\", "/")
        expect(yield* fs.resolve(`/mnt/${drive}${rest}`)).toBe(yield* fs.normalizePath(tmp))
      }),
    )

    it.live("resolves WSL mount roots on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const drive = (yield* tmpdir)[0].toLowerCase()
        expect(yield* fs.resolve(`/mnt/${drive}`)).toBe(yield* fs.resolve(`${drive.toUpperCase()}:/`))
      }),
    )

    it.live("resolves symlinked directory to canonical path", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const target = path.join(tmp, "real")
        yield* fs.makeDirectory(target)
        const link = path.join(tmp, "link")
        yield* fs.symlink(target, link)
        expect(yield* fs.resolve(link)).toBe(yield* fs.resolve(target))
      }),
    )

    it.live("returns unresolved path when target does not exist", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const missing = path.join(yield* tmpdir, "does-not-exist")
        expect(yield* fs.resolve(missing)).toBe(yield* fs.normalizePath(path.resolve(missing)))
      }),
    )

    it.live("dies with ELOOP on symlink cycle", () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const a = path.join(tmp, "a")
        const b = path.join(tmp, "b")
        yield* fs.symlink(b, a)
        yield* fs.symlink(a, b)
        expect(Exit.hasDies(yield* Effect.exit(fs.resolve(a)))).toBe(true)
      }),
    )

    // Windows: chmod(0o000) is a no-op, so EACCES cannot be triggered
    it.live("dies with EACCES on permission-denied symlink target", () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        if (process.getuid?.() === 0) return // skip when running as root
        const fs = yield* FSUtil.Service
        const tmp = yield* tmpdir
        const dir = path.join(tmp, "restricted")
        yield* fs.makeDirectory(dir)
        const link = path.join(tmp, "link")
        yield* fs.symlink(dir, link)
        const exit = yield* Effect.acquireUseRelease(
          fs.chmod(dir, 0o000),
          () => Effect.exit(fs.resolve(path.join(link, "child"))),
          () => fs.chmod(dir, 0o755).pipe(Effect.orDie),
        )
        expect(Exit.hasDies(exit)).toBe(true)
      }),
    )

    // Windows: traversing through a file throws ENOENT (not ENOTDIR),
    // which resolve() catches as a fallback instead of dying
    it.live("dies on non-ENOENT errors", () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const fs = yield* FSUtil.Service
        const file = path.join(yield* tmpdir, "not-a-directory")
        yield* fs.writeFileString(file, "x")
        expect(Exit.hasDies(yield* Effect.exit(fs.resolve(path.join(file, "child"))))).toBe(true)
      }),
    )
  })

  describe("normalizePathPattern()", () => {
    it.live("preserves drive root globs on Windows", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const fs = yield* FSUtil.Service
        const root = path.parse(yield* tmpdir).root
        expect(yield* fs.normalizePathPattern(path.join(root, "*"))).toBe(path.join(root, "*"))
      }),
    )
  })
})

import { describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(dir, "../..")

const html = (name: string) => Effect.promise(() => Bun.file(join(dir, name)).text())

/**
 * Packaged Electron windows load renderer HTML via the privileged `oc://`
 * protocol. Root-relative asset paths like `src="/foo.js"` would resolve from
 * the protocol origin root instead of relative to the current HTML entrypoint.
 *
 * All local resource references must use relative paths (`./`).
 */
describe("electron renderer html", () => {
  for (const name of ["index.html"]) {
    describe(name, () => {
      test("script src attributes use relative paths", () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const content = yield* html(name)
            const srcs = [...content.matchAll(/\bsrc=["']([^"']+)["']/g)].map((m) => m[1])
            for (const src of srcs) {
              expect(src).not.toMatch(/^\/[^/]/)
            }
          }),
        ))

      test("link href attributes use relative paths", () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const content = yield* html(name)
            const hrefs = [...content.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1])
            for (const href of hrefs) {
              expect(href).not.toMatch(/^\/[^/]/)
            }
          }),
        ))

      test("no web manifest link (not applicable in Electron)", () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const content = yield* html(name)
            expect(content).not.toContain('rel="manifest"')
          }),
        ))
    })
  }
})

/**
 * Vite resolves `publicDir` relative to `root`, not the config file.
 * This test reads the actual values from electron.vite.config.ts to catch
 * regressions where the publicDir path no longer resolves correctly
 * after the renderer root is accounted for.
 */
describe("electron vite publicDir", () => {
  test("configured publicDir resolves to a directory with oc-theme-preload.js", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* Effect.promise(() => Bun.file(join(root, "electron.vite.config.ts")).text())
        const pub = config.match(/publicDir:\s*["']([^"']+)["']/)
        const rendererRoot = config.match(/root:\s*["']([^"']+)["']/)
        expect(pub).not.toBeNull()
        expect(rendererRoot).not.toBeNull()
        const resolved = resolve(root, rendererRoot![1], pub![1])
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(resolved)).toBe(true)
        expect(yield* fs.exists(join(resolved, "oc-theme-preload.js"))).toBe(true)
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    ))
})

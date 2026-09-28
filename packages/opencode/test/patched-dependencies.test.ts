import { describe, expect, test } from "bun:test"
import path from "path"
import { Schema } from "effect"

// Bun applies a patch only to the exact `name@version` named in
// `patchedDependencies`. Bumping the dependency without regenerating the patch
// does not fail `bun install`; the patch just stops applying and the runtime
// silently loses whatever the patch fixed. This pins the two together for the
// packages that ship in the CLI.
const root = path.resolve(import.meta.dir, "../../..")
const workspaces = ["packages/opencode", "packages/core"]
const decodeRoot = Schema.decodeUnknownSync(
  Schema.Struct({ patchedDependencies: Schema.Record(Schema.String, Schema.String) }),
)
const decodeInstalled = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))
const patched = decodeRoot(await Bun.file(path.join(root, "package.json")).json()).patchedDependencies

describe("patched dependencies", () => {
  for (const key of Object.keys(patched)) {
    const at = key.lastIndexOf("@")
    const name = key.slice(0, at)
    const version = key.slice(at + 1)

    test(`${key} matches the installed version`, async () => {
      expect(await Bun.file(path.join(root, patched[key])).exists()).toBe(true)
      for (const workspace of workspaces) {
        const file = Bun.file(path.join(root, workspace, "node_modules", name, "package.json"))
        if (!(await file.exists())) continue
        const installed = decodeInstalled(await file.json()).version
        expect(installed, `${workspace} resolves ${name}@${installed}; patch is for ${version}`).toBe(version)
      }
    })
  }
})

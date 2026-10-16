import { NodeServices } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import path from "path"
import { Blend } from "@/task/blend"
import { testEffect } from "../lib/effect"

// Scenario VF3 (spec task-harness-feedback, D11): a VERIFY.md with no ensures fails rule R3.
//
//   Given a leaf VERIFY.md that has no ensures key
//   When the spec loads
//   Then R3 reports that ensures is a required property
//   And the JSON schema of VERIFY.md also lists ensures as required
//   And the release-notes and provider-ordering-admin specs still load with no failure
//
// The spec is a temp copy of task-formats/blend/release-notes.spec whose leaf T1.2 VERIFY.md has its whole `ensures`
// block removed and nothing else changed. It loads through the real `Blend.load`. The JSON schema is the committed
// task-formats/blend/schema/verify.schema.json, read from disk. The two committed specs load from task-formats/blend.

const it = testEffect(NodeServices.layer)

const FORMAT = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const T12_VERIFY = "T1-release-notes.task/T1.2-version-bump.task/VERIFY.md"
const REQUIRED = "(root): 'ensures' is a required property"

// A temp copy of release-notes.spec with `change` applied to the leaf T1.2 VERIFY.md.
const copyWith = (change: (text: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const spec = path.join(yield* fs.makeTempDirectoryScoped(), "release-notes.spec")
    yield* fs.copy(path.join(FORMAT, "release-notes.spec"), spec)
    const file = path.join(spec, T12_VERIFY)
    const before = yield* fs.readFileString(file)
    const after = change(before)
    yield* fs.writeFileString(file, after)
    return { spec, before, after }
  })

// The `ensures` key and every indented line under it.
const dropEnsures = (text: string) => text.replace(/^ensures:\n(?: {2,}.*\n)+/m, "")

it.live("[VF3] a leaf VERIFY.md with no ensures key fails the load with the one R3 line 'ensures' is required", () =>
  Effect.gen(function* () {
    const { spec, before, after } = yield* copyWith(dropEnsures)

    // Given: the leaf's front matter keeps its other keys and has no `ensures` key at all.
    expect(before).toMatch(/^ensures:$/m)
    expect(after).not.toContain("ensures")
    expect(after).toMatch(/^hint: /m)
    expect(after).toMatch(/^gates: /m)
    expect(after.startsWith("---\n")).toBe(true)
    // T1.2 is a leaf: it has no child task folder.
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(path.join(spec, path.dirname(T12_VERIFY)))
    expect(entries.filter((entry) => entry.endsWith(".task"))).toEqual([])

    // When the spec loads.
    const loaded = yield* Blend.load(spec)

    // Then: rule R3 at that VERIFY.md says ensures is a required property, and nothing else fails.
    expect(loaded.failures).toEqual([{ rule: "R3", path: T12_VERIFY, message: REQUIRED }])
    expect(loaded.spec).toBeUndefined()
  }),
)

it.live("[VF3] the JSON schema of VERIFY.md lists ensures as required, at the top level", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const schema: {
      readonly required?: ReadonlyArray<string>
      readonly properties?: Readonly<Record<string, unknown>>
      readonly title?: string
    } = JSON.parse(yield* fs.readFileString(path.join(FORMAT, "schema", "verify.schema.json")))

    expect(schema.title).toBe("VERIFY.md front matter")
    expect(schema.required).toEqual(["ensures"])
    expect(Object.keys(schema.properties ?? {})).toContain("ensures")
  }),
)

it.live("[VF3] the release-notes and provider-ordering-admin specs still load with no failure", () =>
  Effect.gen(function* () {
    for (const name of ["release-notes.spec", "provider-ordering-admin.spec"]) {
      const loaded = yield* Blend.load(path.join(FORMAT, name))
      expect({ name, failures: loaded.failures }).toEqual({ name, failures: [] })
      expect(loaded.spec).toBeDefined()
      expect(loaded.spec?.tasks.length ?? 0).toBeGreaterThan(0)
      // Every VERIFY.md of the spec has ensures: each task holds at least one obligation.
      for (const task of loaded.spec?.tasks ?? [])
        expect({
          name,
          task: task.id,
          obligations: loaded.spec?.obligations.some((item) => item.task === task.id),
        }).toEqual({ name, task: task.id, obligations: true })
    }
  }),
)

it.live("[VF3] control: the same copy with its ensures block kept loads with no failure", () =>
  Effect.gen(function* () {
    const { spec, before, after } = yield* copyWith((text) => text)
    expect(after).toBe(before)
    expect((yield* Blend.load(spec)).failures).toEqual([])
  }),
)

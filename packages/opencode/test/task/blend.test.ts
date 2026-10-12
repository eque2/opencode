import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Schema } from "effect"
import { readdirSync } from "node:fs"
import path from "path"
import { Blend } from "@/task/blend"
import { BlendDocument } from "@/task/blend/document"
import { testEffect } from "../lib/effect"

const it = testEffect(NodeServices.layer)

// The golden model is read-only: every case works on a copy in a scoped temp folder.
const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const goldenSpec = path.join(formatDir, "provider-ordering-admin.spec")
const goldenModel = path.join(formatDir, "golden/provider-ordering-admin.model.json")
const goldenCheck = path.join(formatDir, "golden/provider-ordering-admin.check.txt")
const negativeDir = path.join(formatDir, "golden/negative")
const negativeCases = readdirSync(negativeDir).toSorted()

const NegativeCase = Schema.fromJsonString(
  Schema.Struct({
    rule: Schema.String,
    name: Schema.String,
    exit: Schema.Number,
    delete: Schema.Array(Schema.String),
  }),
)
const GoldenModel = Schema.fromJsonString(Schema.Unknown)

const ruleIds = (failures: ReadonlyArray<Blend.Failure>): string[] =>
  [...new Set(failures.map((failure) => failure.rule))].toSorted()

// A copy of the golden T2 spec, named `<slug>.spec` like the original.
const copyGolden = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const target = path.join(yield* fs.makeTempDirectoryScoped(), "provider-ordering-admin.spec")
  yield* fs.copy(goldenSpec, target)
  return target
})

// golden/README.md: copy the spec, delete each `delete` path, then copy `files/` over it.
const rebuild = Effect.fnUntraced(function* (caseDir: string) {
  const fs = yield* FileSystem.FileSystem
  const target = yield* copyGolden()
  const meta = yield* Schema.decodeUnknownEffect(NegativeCase)(
    yield* fs.readFileString(path.join(caseDir, "case.json")),
  )
  yield* Effect.forEach(meta.delete, (rel) => fs.remove(path.join(target, rel), { recursive: true }))
  const files = path.join(caseDir, "files")
  if (yield* fs.exists(files)) yield* fs.copy(files, target, { overwrite: true })
  return target
})

describe("Blend.load", () => {
  it.live("accepts the golden T2 spec and derives its model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const result = yield* Blend.load(goldenSpec)
      expect(result.failures).toEqual([])
      expect(result.spec).toBeDefined()
      const spec = result.spec
      if (!spec) return
      expect(spec.tasks).toHaveLength(7)
      expect(spec.obligations).toHaveLength(61)
      expect(spec.scenarios).toHaveLength(26)

      const check = (yield* fs.readFileString(goldenCheck)).trim().split("\n")
      expect(result.notes).toEqual([check[1]])

      const task = (id: string) => spec.tasks.find((each) => each.id === id)
      expect(task("T2")?.children).toEqual(["T2.1", "T2.2", "T2.3", "T2.4", "T2.5", "T2.6"])
      expect(task("T2.6")?.afterEffective).toEqual(["T1.1", "T2.4"])
      expect(task("T2.4")?.supports).toEqual(["S8", "S9", "S10", "S42", "S53"])
      expect(task("T2.4")?.policy.judges.test).toEqual(["runner", "verifier", "human"])
      expect(spec.obligations.find((each) => each.id === "T2.4.c5")?.judges).toEqual(["runner", "verifier", "human"])
      expect(spec.obligations.find((each) => each.id === "T2.2.p4")?.proof).toEqual({ kind: "test", tag: "T2.2.c3" })

      // The whole parse target, unit hashes included, equals the reference checker's output.
      const golden = yield* Schema.decodeUnknownEffect(GoldenModel)(yield* fs.readFileString(goldenModel))
      expect(golden).toEqual(spec)
    }),
  )

  for (const name of negativeCases) {
    it.live(`refuses negative case ${name} with the expected rules`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const caseDir = path.join(negativeDir, name)
        const result = yield* Blend.load(yield* rebuild(caseDir))
        const expected = (yield* fs.readFileString(path.join(caseDir, "expected.txt")))
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => line.split(" ")[0])
        expect(ruleIds(result.failures)).toEqual([...new Set(expected)].toSorted())
        expect(result.spec).toBeUndefined()
      }),
    )
  }

  it.live("refuses leaves that are after each other and names the cycle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const target = yield* copyGolden()
      // T2.2 is already after T2.1; T2.1 after T2.3 and T2.3 after T2.2 close the ring.
      const edit = (rel: string, from: string, to: string) =>
        Effect.gen(function* () {
          const file = path.join(target, rel)
          const text = yield* fs.readFileString(file)
          expect(text).toContain(from)
          yield* fs.writeFileString(file, text.replace(from, to))
        })
      yield* edit(
        "T2-services.task/T2.1-database-source.task/TASK.md",
        "after: [T1.2, T1.3]",
        "after: [T1.2, T1.3, T2.3]",
      )
      yield* edit(
        "T2-services.task/T2.3-serve-nothing-routing.task/TASK.md",
        "after: [T1.3, T1.6]",
        "after: [T1.3, T1.6, T2.2]",
      )
      const result = yield* Blend.load(target)
      expect(ruleIds(result.failures)).toEqual(["R7"])
      expect(result.failures).toContainEqual({
        rule: "R7",
        path: "T2-services.task/T2.1-database-source.task/TASK.md",
        message: "order has a cycle: T2.1 → T2.3 → T2.2 → T2.1",
      })
      expect(result.spec).toBeUndefined()
    }),
  )

  // The spike's fixture tree (D5): 6 tasks, 31 obligations, 13 scenarios, two preconditions.
  it.live("accepts the release-notes fixture tree", () =>
    Effect.gen(function* () {
      const result = yield* Blend.load(path.join(formatDir, "release-notes.spec"))
      expect(result.failures).toEqual([])
      const spec = result.spec
      if (!spec) return
      expect(spec.tasks).toHaveLength(6)
      expect(spec.obligations).toHaveLength(31)
      expect(spec.scenarios).toHaveLength(13)
      expect(Object.keys(spec.outside)).toEqual(["T8", "T9"])
      expect(spec.tasks.find((each) => each.id === "T1.5")?.afterEffective).toEqual(["T1.3", "T1.4", "T9"])
      expect(spec.scenarios.find((each) => each.id === "S13")?.environment?.kind).toBe("deployed")
    }),
  )
})

describe("BlendDocument.duplicateKeys", () => {
  const rows: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    [
      "block scalar with repeated key-like lines",
      ["text: |", "  note: one", "  note: two", "rejects:", "  c1:", "    - |", "      note: one", "      note: two"].join(
        "\n",
      ),
      [],
    ],
    [
      "multi-line quoted scalar with key-like lines",
      ['text: "first', "  note: one", '  note: two"', "items:", "  - 'start", "    note: one", "    note: two'"].join(
        "\n",
      ),
      [],
    ],
    [
      "nested-mapping duplicate",
      ["policy:", "  judges:", "    test: [runner]", "    test: [human]"].join("\n"),
      ["YAML line 4: duplicate key 'test'"],
    ],
    [
      "duplicate inside one sequence item",
      ["touches:", "  - path: a", "    change: new", "    path: b"].join("\n"),
      ["YAML line 4: duplicate key 'path'"],
    ],
    [
      "two sequence items with the same keys",
      ["touches:", "  - path: a", "    change: new", "  - path: b", "    change: update"].join("\n"),
      [],
    ],
  ]
  for (const [name, yaml, problems] of rows) {
    test(name, () => {
      expect(BlendDocument.duplicateKeys(yaml.split("\n"), 1)).toEqual(problems)
    })
  }
})

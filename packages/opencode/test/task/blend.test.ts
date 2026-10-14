import { NodeServices } from "@effect/platform-node"
import { describe, expect, test } from "bun:test"
import { Effect, FileSystem, Schema } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
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
// Case folders only: a stray file such as .DS_Store is not a case.
const negativeCases = readdirSync(negativeDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .toSorted()

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

// Replaces `from` with `to` in one file of a copied spec. `from` must be in the file.
const edit = Effect.fnUntraced(function* (target: string, rel: string, from: string, to: string) {
  const fs = yield* FileSystem.FileSystem
  const file = path.join(target, rel)
  const text = yield* fs.readFileString(file)
  expect(text).toContain(from)
  yield* fs.writeFileString(file, text.replace(from, to))
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
      // Typed `unknown`, the model accepts the decoded JSON as its expected value; toStrictEqual also refuses
      // undefined keys.
      const actual: unknown = spec
      expect(actual).toStrictEqual(golden)
    }),
  )

  test("reads every negative case of the golden model", () => {
    expect(negativeCases).toHaveLength(38)
  })

  for (const name of negativeCases) {
    it.live(`refuses negative case ${name} with the expected failures`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const caseDir = path.join(negativeDir, name)
        const result = yield* Blend.load(yield* rebuild(caseDir))
        // expected.txt is the checker's stdout: one line per failure, each ended by a newline.
        const expected = (yield* fs.readFileString(path.join(caseDir, "expected.txt"))).replace(/\n$/, "")
        const actual = result.failures
          .map((failure) => `${failure.rule} ${failure.path}: ${failure.message}`)
          .join("\n")
        expect(actual).toBe(expected)
        expect(result.spec).toBeUndefined()
      }),
    )
  }

  it.live("refuses leaves that are after each other and names the cycle", () =>
    Effect.gen(function* () {
      const target = yield* copyGolden()
      // T2.2 is already after T2.1; T2.1 after T2.3 and T2.3 after T2.2 close the ring.
      yield* edit(
        target,
        "T2-services.task/T2.1-database-source.task/TASK.md",
        "after: [T1.2, T1.3]",
        "after: [T1.2, T1.3, T2.3]",
      )
      yield* edit(
        target,
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

  it.live("applies a task's lower budget to its effective policy", () =>
    Effect.gen(function* () {
      const target = yield* copyGolden()
      yield* edit(
        target,
        "T2-services.task/T2.4-gateway-dry-run.task/VERIFY.md",
        "    test: [runner, verifier, human]\n",
        "    test: [runner, verifier, human]\n  budgets: {taskAttempts: 2}\n",
      )
      const result = yield* Blend.load(target)
      expect(result.failures).toEqual([])
      const task = result.spec?.tasks.find((each) => each.id === "T2.4")
      expect(task?.policy.budgets).toStrictEqual({ taskAttempts: 2, retries: 3 })
      expect(task?.policyOverride?.budgets).toStrictEqual({ taskAttempts: 2 })
    }),
  )

  // The release-notes fixture tree: 6 tasks, 31 obligations, 13 scenarios, two preconditions.
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

// The two live-check folders (D15): small valid specs that target the demo seed, so a paid run is short and its
// outcome does not depend on a model's judgement.
describe("live-check folders", () => {
  const seedDir = path.resolve(import.meta.dir, "../task-harness/release-notes-repo")
  const load = (name: string) =>
    Effect.gen(function* () {
      const result = yield* Blend.load(path.join(formatDir, name))
      expect(result.failures).toEqual([])
      if (!result.spec) return yield* Effect.die(`${name} did not load`)
      return result.spec
    })
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )

  for (const name of ["example-scenarios.spec", "example-cascade.spec"]) {
    it.live(`${name} has a title, ensures in every VERIFY.md, no source file, and touches that fit the seed`, () =>
      Effect.gen(function* () {
        const spec = yield* load(name)
        expect(spec.title.length).toBeGreaterThan(0)
        const all = files(path.join(formatDir, name))
        expect(all.filter((file) => file.endsWith(".ts"))).toEqual([])
        const verifies = all.filter((file) => path.basename(file) === "VERIFY.md")
        expect(verifies).toHaveLength(spec.tasks.length)
        for (const task of spec.tasks)
          expect(spec.obligations.filter((item) => item.task === task.id && item.kind === "ensures").length).toBeGreaterThan(0)
        for (const touch of spec.tasks.flatMap((task) => task.touches))
          expect(existsSync(path.join(seedDir, touch.path))).toBe(touch.change !== "new")
      }),
    )
  }

  it.live("example-scenarios has a parent T1, one leaf and scenario S1 proved by a [S1] test", () =>
    Effect.gen(function* () {
      const spec = yield* load("example-scenarios.spec")
      expect(spec.tasks.map((task) => task.id)).toEqual(["T1", "T1.1"])
      expect(spec.tasks[1]?.parent).toBe("T1")
      expect(spec.obligations.map((item) => [item.id, item.proof.kind])).toEqual([
        ["T1.e1", "review"],
        ["T1.1.c1", "test"],
      ])
      expect(spec.scenarios.map((scenario) => [scenario.id, scenario.needs])).toEqual([["S1", ["T1.1"]]])
      expect(spec.outside).toEqual({})
    }),
  )

  it.live("example-cascade has T1.1 proved only by a failing gate with one attempt, T1.2 after it, T1.3 free", () =>
    Effect.gen(function* () {
      const spec = yield* load("example-cascade.spec")
      const task = (id: string) => spec.tasks.find((each) => each.id === id)
      expect(spec.tasks.map((each) => each.id)).toEqual(["T1", "T1.1", "T1.2", "T1.3"])
      expect(spec.obligations.filter((item) => item.task === "T1").map((item) => item.proof.kind)).toEqual(["review"])
      const gated = spec.obligations.filter((item) => item.task === "T1.1")
      expect(gated.length).toBeGreaterThan(0)
      expect(gated.every((item) => item.proof.kind === "gate")).toBe(true)
      expect(task("T1.1")?.policy.budgets.taskAttempts).toBe(1)
      expect(task("T1.2")?.after).toEqual(["T1.1"])
      expect(task("T1.3")?.after).toEqual([])
      expect(spec.scenarios).toEqual([])
    }),
  )

  it.live("example-cascade's gate exits 1 on every run and names no file", () =>
    Effect.gen(function* () {
      const spec = yield* load("example-cascade.spec")
      const gates = spec.obligations.flatMap((item) => (item.proof.kind === "gate" ? [item.proof.gate] : []))
      for (const gate of new Set(gates)) {
        const command = spec.gates[gate]?.command ?? ""
        // A builder can edit only files, so a gate that names none cannot be made to pass.
        const words = command.split(/[\s'"]+/).filter((word) => word.length > 0)
        expect(words.filter((word) => /[/.]/.test(word) || existsSync(path.join(seedDir, word)))).toEqual([])
        for (const _ of [1, 2]) expect(spawnSync("sh", ["-c", command], { cwd: seedDir }).status).toBe(1)
      }
    }),
  )
})

describe("BlendDocument.duplicateKeys", () => {
  const rows: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    [
      "block scalar with repeated key-like lines",
      [
        "text: |",
        "  note: one",
        "  note: two",
        "rejects:",
        "  c1:",
        "    - |",
        "      note: one",
        "      note: two",
      ].join("\n"),
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

import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import { spawnSync } from "node:child_process"
import path from "path"
import { Blend } from "@/task/blend"
import type { BlendModel } from "@/task/blend/model"
import { TaskLimits } from "@/task/limits"
import { TaskProof } from "@/task/proof"
import { testEffect } from "../lib/effect"

// Scenario VF15 (spec task-harness-feedback, D11, D15, T1.15, T3.7): the two live-check folders load, before and
// after ensures becomes required.
//
//   Given the example-scenarios and example-cascade spec folders, built in phase 1
//   When each loads in phase 1, and again once ensures is required
//   Then each has no failure
//   And example-scenarios has a parent T1, one leaf and scenario S1 proved by a test titled with [S1]
//   And example-cascade has a parent T1, T1.1 proved only by a gate that always exits 1 with a budget of one
//     attempt, T1.2 after T1.1, and T1.3 with no after
//
// "Phase 1" is the goal-branch commit that the phase-1 checkpoint merge brought into dev (c30fc83bb0, "Merge
// goal/task-harness-feedback: phase 1, one run machine"). "Loads in phase 1" runs the real phase-1 loader, the seven
// files of src/task/blend read from that commit with `git show` into a scoped temp folder (no file of the worktree is
// written), on the two folders as they were at that commit. "Again once ensures is required" runs today's `Blend.load`
// on the folders on disk. A control proves the two loaders are the two phases: a leaf with no `ensures` gives the
// required-ensures R3 only under today's loader.

const it = testEffect(NodeServices.layer)

const packageDir = path.resolve(import.meta.dir, "../..")
const repoRoot = path.resolve(packageDir, "../..")
const formatDir = path.join(repoRoot, "task-formats/blend")
const FOLDERS = ["example-scenarios.spec", "example-cascade.spec"] as const
const PHASE1 = "e90cddeff4"
const LOADER = "packages/opencode/src/task/blend"
const REQUIRED = "(root): 'ensures' is a required property"

type Load = typeof Blend.load

const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = spawnSync("git", args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout
}

// The files of a tree path at a commit, relative to the repository root.
const filesAt = (commit: string, dir: string) =>
  git(repoRoot, "ls-tree", "-r", "--name-only", commit, "--", dir)
    .toString()
    .split("\n")
    .filter((line) => line !== "")

// Every file under a folder on disk, relative to it.
const filesOn = (dir: string): ReadonlyArray<string> =>
  Array.from(new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })).toSorted()

const isLoader = (value: unknown): value is { readonly Blend: { readonly load: Load } } =>
  typeof value === "object" &&
  value !== null &&
  "Blend" in value &&
  typeof value.Blend === "object" &&
  value.Blend !== null &&
  "load" in value.Blend &&
  typeof value.Blend.load === "function"

// The phase-1 tree in a scoped temp folder: the loader's seven files under `blend/`, a `node_modules` link so that
// `effect` resolves to the same module as in this package, and the two folders under `specs/`.
const phase1 = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped()
  const write = Effect.fnUntraced(function* (file: string, target: string) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFile(target, git(repoRoot, "show", `${PHASE1}:${file}`))
  })
  const loaderFiles = filesAt(PHASE1, LOADER)
  for (const file of loaderFiles) yield* write(file, path.join(root, "blend", path.basename(file)))
  yield* fs.symlink(path.join(packageDir, "node_modules"), path.join(root, "node_modules"))
  for (const folder of FOLDERS)
    for (const file of filesAt(PHASE1, `task-formats/blend/${folder}`))
      yield* write(file, path.join(root, "specs", path.relative("task-formats/blend", file)))
  const module: unknown = yield* Effect.promise(() => import(path.join(root, "blend", "index.ts")))
  if (!isLoader(module)) return yield* Effect.die("the phase-1 loader has no Blend.load")
  return { load: module.Blend.load, specs: path.join(root, "specs"), loaderFiles }
})

const loaded = (result: BlendModel.LoadResult, name: string) => {
  expect(result.failures).toEqual([])
  if (!result.spec) throw new Error(`${name} did not load`)
  return result.spec
}

// example-scenarios: a parent T1, one leaf T1.1, and scenario S1 needing T1.1, proved by the tests titled [S1]
// (the spec's proof binding is title-tag: a scenario has no proof key of its own).
const expectScenarios = (spec: BlendModel.Spec) => {
  expect(spec.tasks.map((task) => [task.id, task.parent ?? null, task.children])).toEqual([
    ["T1", null, ["T1.1"]],
    ["T1.1", "T1", []],
  ])
  expect(spec.tasks.filter((task) => task.children.length === 0).map((task) => task.id)).toEqual(["T1.1"])
  expect(spec.obligations.map((item) => [item.id, item.proof])).toEqual([
    ["T1.e1", { kind: "review" }],
    ["T1.1.c1", { kind: "test", tag: "T1.1.c1" }],
  ])
  expect(spec.scenarios.map((scenario) => [scenario.id, scenario.needs])).toEqual([["S1", ["T1.1"]]])
  expect(spec.policy.proofBinding).toBe("title-tag")
  expect(spec.outside).toEqual({})
}

// example-cascade: a parent T1; T1.1 proved only by the gate BUILD-1 with a budget of one attempt (the spec allows
// two); T1.2 after T1.1; T1.3 with no after.
const expectCascade = (spec: BlendModel.Spec) => {
  const task = (id: string) => spec.tasks.find((each) => each.id === id)
  expect(spec.tasks.map((each) => [each.id, each.parent ?? null, each.children, each.after])).toEqual([
    ["T1", null, ["T1.1", "T1.2", "T1.3"], []],
    ["T1.1", "T1", [], []],
    ["T1.2", "T1", [], ["T1.1"]],
    ["T1.3", "T1", [], []],
  ])
  expect(task("T1.3")?.afterEffective).toEqual([])
  expect(task("T1.2")?.afterEffective).toEqual(["T1.1"])
  expect(spec.obligations.filter((item) => item.task === "T1.1").map((item) => [item.id, item.proof])).toEqual([
    ["T1.1.c1", { kind: "gate", gate: "BUILD-1" }],
  ])
  expect(task("T1.1")?.gates).toEqual([])
  expect(task("T1.1")?.hint).toBeUndefined()
  expect(spec.policy.budgets.taskAttempts).toBe(2)
  expect(task("T1.1")?.policy.budgets.taskAttempts).toBe(1)
  expect(spec.scenarios).toEqual([])
  expect(spec.outside).toEqual({})
}

// The gate's command exits 1 on every run and names no file, so no edit by a builder can make it pass.
const expectFailingGate = (spec: BlendModel.Spec) => {
  const command = spec.gates["BUILD-1"]?.command ?? ""
  expect(command).not.toBe("")
  const words = command.split(/[\s'"]+/).filter((word) => word.length > 0)
  expect(words.filter((word) => /[/.]/.test(word))).toEqual([])
  for (const _ of [1, 2, 3]) expect(spawnSync("sh", ["-c", command], { cwd: repoRoot }).status).toBe(1)
}

// A scoped git repository with one committed test file; its head.
const repoWith = Effect.fnUntraced(function* (title: string) {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  yield* fs.makeDirectory(path.join(dir, "test"))
  yield* fs.writeFileString(
    path.join(dir, "test", "slug.test.ts"),
    [
      'import { expect, test } from "bun:test"',
      "",
      `test(${JSON.stringify(title)}, () => {`,
      '  expect("Release 2.0: Faster Notes!".toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).toBe(',
      '    "release-2-0-faster-notes",',
      "  )",
      "})",
      "",
    ].join("\n"),
  )
  git(dir, "init", "-q", "-b", "main")
  git(dir, "add", "-A")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "seed")
  return { dir, head: git(dir, "rev-parse", "HEAD").toString().trim() }
})

describe("[VF15] the two live-check folders load, before and after ensures becomes required", () => {
  it.live("[VF15] the two folders were built in phase 1: the phase-1 commit holds them as they are on disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // The phase-1 commit is in this branch's history, and the folders' only later history is none.
      expect(spawnSync("git", ["merge-base", "--is-ancestor", PHASE1, "HEAD"], { cwd: repoRoot }).status).toBe(0)
      for (const folder of FOLDERS) {
        const dir = `task-formats/blend/${folder}`
        const atPhase1 = filesAt(PHASE1, dir)
        expect(atPhase1.length).toBeGreaterThan(0)
        expect(atPhase1.map((file) => path.relative(dir, file)).toSorted()).toEqual([
          ...filesOn(path.join(formatDir, folder)),
        ])
        for (const file of atPhase1)
          expect(
            Buffer.from(yield* fs.readFile(path.join(repoRoot, file))).equals(
              git(repoRoot, "show", `${PHASE1}:${file}`),
            ),
          ).toBe(true)
      }
    }),
  )

  it.live(
    "[VF15] each folder loads with no failure in phase 1 and again once ensures is required, to the same model",
    () =>
      Effect.gen(function* () {
        const old = yield* phase1
        expect(old.loaderFiles.map((file) => path.basename(file)).toSorted()).toEqual([
          "document.ts",
          "draft.ts",
          "index.ts",
          "model.ts",
          "rules.ts",
          "schema.ts",
          "tree.ts",
        ])
        for (const [folder, expectShape] of [
          ["example-scenarios.spec", expectScenarios],
          ["example-cascade.spec", expectCascade],
        ] as const) {
          // When each loads in phase 1: the phase-1 loader on the phase-1 folder.
          const before = loaded(yield* old.load(path.join(old.specs, folder)), `${folder} (phase 1)`)
          // And again once ensures is required: today's loader on the folder on disk.
          const after = loaded(yield* Blend.load(path.join(formatDir, folder)), folder)
          // The required key changed nothing these folders give: both loads are the same model.
          expect(after).toEqual(before)
          expectShape(before)
          expectShape(after)
          // Every task of both folders has an ensures obligation, which today's loader requires.
          for (const task of after.tasks)
            expect(after.obligations.some((item) => item.task === task.id && item.kind === "ensures")).toBe(true)
        }
      }),
  )

  it.live(
    "[VF15] control: a leaf with no ensures loads with no failure in phase 1 but fails the required-ensures R3 today",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const old = yield* phase1
        for (const [folder, leaf] of [
          ["example-scenarios.spec", "T1-slugs.task/T1.1-slugify.task"],
          ["example-cascade.spec", "T1-numbers.task/T1.2-mean.task"],
        ] as const) {
          const copy = path.join(yield* fs.makeTempDirectoryScoped(), folder)
          yield* fs.copy(path.join(formatDir, folder), copy)
          const file = path.join(copy, leaf, "VERIFY.md")
          const text = yield* fs.readFileString(file)
          const stripped = text.replace(/^ensures:\n(?: {2}.*\n)+/m, "")
          expect(stripped).not.toContain("ensures:")
          yield* fs.writeFileString(file, stripped)
          // Phase 1 did not require ensures: the copy loads with no failure.
          const before = yield* old.load(copy)
          expect(before.failures).toEqual([])
          expect(before.spec).toBeDefined()
          const after = yield* Blend.load(copy)
          expect(after.failures).toEqual([{ rule: "R3", path: `${leaf}/VERIFY.md`, message: REQUIRED }])
          expect(after.spec).toBeUndefined()
        }
      }),
  )

  it.live("[VF15] example-cascade's T1.1 gate BUILD-1 exits 1 on every run and names no file", () =>
    Effect.gen(function* () {
      const old = yield* phase1
      expectFailingGate(loaded(yield* old.load(path.join(old.specs, "example-cascade.spec")), "example-cascade.spec"))
      expectFailingGate(loaded(yield* Blend.load(path.join(formatDir, "example-cascade.spec")), "example-cascade.spec"))
    }),
  )

  it.live(
    // The title names the tag without its brackets: the reporter reads a bracketed id in a title as a scenario tag.
    "[VF15] example-scenarios' S1 is proved by a test whose title starts with the S1 tag, and by no test without it",
    () =>
      Effect.gen(function* () {
        const spec = loaded(yield* Blend.load(path.join(formatDir, "example-scenarios.spec")), "example-scenarios.spec")
        const scenario = spec.scenarios[0]
        if (!scenario) throw new Error("example-scenarios.spec has no scenario")
        const limits = TaskLimits.scripted
        const tagged = yield* repoWith("[S1] a release title becomes its slug")
        const proof = yield* TaskProof.proveScenario({ scenario, cwd: tagged.dir, head: tagged.head, limits })
        expect(proof.scenario).toBe("S1")
        expect(proof.result).toEqual({ status: "passed" })
        const untagged = yield* repoWith("S1 a release title becomes its slug")
        const none = yield* TaskProof.proveScenario({ scenario, cwd: untagged.dir, head: untagged.head, limits })
        expect(none.result).toEqual({ status: "failed", reason: "no test titled [S1]" })
      }),
    60_000,
  )
})

import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "path"
import { Blend } from "@/task/blend"
import { testEffect } from "../lib/effect"

// Scenario VF16 (spec task-harness-feedback, D15, AC 17, T3.10): the demo seed copies every example folder.
//
//   Given an empty demo folder
//   When task-demo.sh seeds it
//   Then the seeded spec folder holds every example spec folder beside the release-notes and provider-ordering-admin
//     specs
//   And the printed instructions name the two live-check commands
//
// The real script runs with TASK_DEMO_NO_EXEC=1: it seeds the folder and commits the seed, then stops before
// `bun install --frozen-lockfile` and `exec bun dev`, so the test needs no network and starts no TUI. Git runs with no
// user or system config and a fixed identity.

const it = testEffect(NodeServices.layer)

const script = path.resolve(import.meta.dir, "../../script/task-demo.sh")
const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const LIVE = ["example-scenarios.spec", "example-cascade.spec"] as const
const FAULTS = [
  "example-cycle.spec",
  "example-format-faults.spec",
  "example-no-ensures.spec",
  "example-outside-run.spec",
  "example-self-after.spec",
  "example-unknown-after.spec",
] as const
const TIMEOUT = 120_000

const env = {
  ...process.env,
  TASK_DEMO_NO_EXEC: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
}

const run = (cwd: string, ...command: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([...command], { cwd, env })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

// Every file under a folder, relative to it.
const filesOf = (dir: string): ReadonlyArray<string> =>
  Array.from(new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })).toSorted()

// The demo folder: empty when given, removed when the test ends.
const demoFolder = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "verify-vf16-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

describe("[VF16] the demo seed copies every example folder", () => {
  it.live(
    "[VF16] task-demo.sh seeds an empty folder with every example spec folder beside release-notes and provider-ordering-admin, and prints both live-check commands",
    () =>
      Effect.gen(function* () {
        // Given an empty demo folder.
        const demo = yield* demoFolder
        expect(readdirSync(demo)).toEqual([])
        const examples = readdirSync(formatDir)
          .filter((name) => /^example-.*\.spec$/.test(name) && statSync(path.join(formatDir, name)).isDirectory())
          .toSorted()
        expect(examples).toEqual([...LIVE, ...FAULTS].toSorted())

        // When task-demo.sh seeds it.
        const seeded = run(demo, "bash", script)
        expect(seeded.err).toBe("")
        expect(seeded.code).toBe(0)

        // Then the seeded spec folder holds every example spec folder beside the two shipped specs, and nothing else.
        const specs = path.join(demo, "task-formats/blend")
        expect(readdirSync(specs).toSorted()).toEqual(
          ["provider-ordering-admin.spec", "release-notes.spec", ...examples].toSorted(),
        )
        // Each is a copy of its source folder: the same files with the same bytes.
        for (const name of ["provider-ordering-admin.spec", "release-notes.spec", ...examples]) {
          const files = filesOf(path.join(formatDir, name))
          expect(files.length).toBeGreaterThan(0)
          expect(filesOf(path.join(specs, name))).toEqual(files)
          for (const file of files)
            expect(
              readFileSync(path.join(specs, name, file)).equals(readFileSync(path.join(formatDir, name, file))),
            ).toBe(true)
        }
        // The seed is one clean commit "seed" that tracks every example folder.
        expect(run(demo, "git", "log", "--format=%s").out.trim()).toBe("seed")
        expect(run(demo, "git", "status", "--porcelain").out).toBe("")
        const tracked = run(demo, "git", "ls-files", "task-formats/blend").out.split("\n")
        for (const name of examples)
          expect(tracked.some((file) => file.startsWith(`task-formats/blend/${name}/`))).toBe(true)

        // And the printed instructions name the two live-check commands.
        const lines = seeded.out.split("\n")
        for (const name of LIVE) {
          const command = `/task task-formats/blend/${name}`
          expect(lines.some((line) => line.startsWith("task-demo:") && line.includes(command))).toBe(true)
        }
        // The release-notes instructions stay.
        expect(seeded.out).toContain("/task trust T9")
        expect(seeded.out).toContain("/task task-formats/blend/release-notes.spec")
        // Each printed live-check path is a spec folder in the demo that loads with no failure.
        for (const name of LIVE) {
          const result = yield* Blend.load(path.join(demo, "task-formats/blend", name))
          expect(result.failures).toEqual([])
          expect(result.spec?.id).toBe(name.replace(/\.spec$/, ""))
        }
      }),
    TIMEOUT,
  )

  it.live(
    "[VF16] a demo folder that is not empty and not an earlier demo is refused and left as it was",
    () =>
      Effect.gen(function* () {
        const demo = yield* demoFolder
        writeFileSync(path.join(demo, "notes.md"), "mine\n")
        const seeded = run(demo, "bash", script)
        expect(seeded.code).toBe(1)
        expect(seeded.err).toContain("is not empty and is not an earlier demo")
        expect(readdirSync(demo)).toEqual(["notes.md"])
      }),
    TIMEOUT,
  )
})

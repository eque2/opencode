import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "path"

// script/task-demo.sh (D15, AC 17), run with TASK_DEMO_NO_EXEC=1: it seeds the folder and commits it, but skips the
// dependency install and the TUI start, so the test needs no network.

const script = path.resolve(import.meta.dir, "../../script/task-demo.sh")
const formatDir = path.resolve(import.meta.dir, "../../../../task-formats/blend")
const TIMEOUT = 120_000

// A git with no user or system config and a fixed identity.
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

const folder = () => mkdtempSync(path.join(os.tmpdir(), "task-demo-"))

describe("task-demo.sh", () => {
  test(
    "seeds every example folder beside the two shipped specs, commits a clean seed, and names both live checks",
    () => {
      const target = folder()
      try {
        const demo = run(target, "bash", script)
        expect(demo.err).toBe("")
        expect(demo.code).toBe(0)
        const examples = readdirSync(formatDir).filter((name) => /^example-.*\.spec$/.test(name))
        expect(examples.length).toBeGreaterThanOrEqual(8)
        expect(readdirSync(path.join(target, "task-formats/blend")).toSorted()).toEqual(
          ["provider-ordering-admin.spec", "release-notes.spec", ...examples].toSorted(),
        )
        expect(demo.out).toContain("/task task-formats/blend/example-scenarios.spec")
        expect(demo.out).toContain("/task task-formats/blend/example-cascade.spec")
        expect(demo.out).toContain("/task task-formats/blend/release-notes.spec")
        expect(run(target, "git", "log", "--format=%s").out.trim()).toBe("seed")
        expect(run(target, "git", "status", "--porcelain").out).toBe("")
      } finally {
        rmSync(target, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  test(
    "refuses to wipe a folder whose first commit is not seed",
    () => {
      const target = folder()
      try {
        writeFileSync(path.join(target, "notes.md"), "mine\n")
        run(target, "git", "init", "-q", "-b", "main")
        run(target, "git", "add", "-A")
        run(target, "git", "commit", "-q", "-m", "first")
        const demo = run(target, "bash", script)
        expect(demo.code).toBe(1)
        expect(demo.err).toContain("is not empty and is not an earlier demo")
        expect(readdirSync(target).toSorted()).toEqual([".git", "notes.md"])
      } finally {
        rmSync(target, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

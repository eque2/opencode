import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import * as Workspace from "../task-harness/arms/workspace"
import { Scripted } from "./lib/scripted"

// Scenario VF17 (spec task-harness-feedback, D2, D3, D15, SD-11, T3.9): a scripted run of the cascade folder ends with
// a cascade and finished independent work.
//
//   Given the example-cascade spec in a repository seeded as task-demo.sh seeds the demo folder, with the scripted
//     model
//   When /task runs on it
//   Then T1.1 is budget exhausted after one attempt
//   And T1.2 and the parent T1 are blocked with the reason "blocked by T1.1: budget exhausted"
//   And T1.3 is trusted
//   And the run ends budget exhausted only after T1.3 ends, with reason lines for T1.1, then T1 and T1.2 blocked by
//     T1.1
//
// `Scripted.start` (test/task/lib/scripted.ts) commits the release-notes seed, the two shipped specs and the folder in
// a fresh git repository, starts a real `opencode serve` of this tree with a scripted model, and types
// `/task task-formats/blend/example-cascade.spec`: the real command, run supervisor, workers, proofs and merges run.
// The scripted model writes each leaf's files and calls `task_ready`, and trusts every id a verifier or reviewer is
// asked to judge. T1.3's first builder request is answered only once T1.1 is budget exhausted (or after two
// minutes), so the run is seen with T1.1 dead while T1.3 is still in work.

const TIMEOUT = 300_000
const RUN_MS = 240_000
const FOLDER = "example-cascade.spec"
const BLOCKED = "blocked by T1.1: budget exhausted"
const script = path.resolve(import.meta.dir, "../../script/task-demo.sh")

const demoEnv = {
  ...process.env,
  TASK_DEMO_NO_EXEC: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
}

// `git ls-tree -r` lines (mode, type, blob, path) of a commit, sorted.
const treeOf = (repo: string, commit: string) => Workspace.git(repo, "ls-tree", "-r", commit).split("\n").toSorted()

// The tree that the real task-demo.sh commits as its seed, with only `folder` of the example folders.
const demoTree = (folder: string) => {
  const demo = mkdtempSync(path.join(os.tmpdir(), "verify-vf17-demo-"))
  try {
    const seeded = Bun.spawnSync(["bash", script], { cwd: demo, env: demoEnv })
    if (seeded.exitCode !== 0) throw new Error(`task-demo.sh failed: ${seeded.stderr.toString()}`)
    return treeOf(demo, "HEAD").filter((line) => {
      const file = line.split("\t")[1] ?? ""
      const example = /^task-formats\/blend\/(example-[^/]+\.spec)\//.exec(file)?.[1]
      return example === undefined || example === folder
    })
  } finally {
    rmSync(demo, { recursive: true, force: true })
  }
}

describe("[VF17] a scripted run of the cascade folder", () => {
  test(
    "[VF17] /task on example-cascade with the scripted model: T1.1 budget exhausted after one attempt, T1.2 and T1 blocked by it, T1.3 trusted, and the run ends budget exhausted only after T1.3 ends",
    async () => {
      await using run = await Scripted.start({
        folder: FOLDER,
        leaves: {
          "T1.1": {
            "src/sum.ts":
              "export const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)\n",
          },
          "T1.3": {
            "src/clamp.ts":
              "export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))\n",
            "test/clamp.test.ts": [
              'import { expect, test } from "bun:test"',
              'import { clamp } from "../src/clamp"',
              "",
              'test("[T1.3.c1] clamp keeps a number inside its range", () => {',
              "  expect(clamp(5, 0, 3)).toBe(3)",
              "  expect(clamp(-1, 0, 3)).toBe(0)",
              "  expect(clamp(2, 0, 3)).toBe(2)",
              "})",
              "",
            ].join("\n"),
          },
        },
        hold: { unit: "T1.3", until: (s) => s?.tasks["T1.1"]?.state === "budget_exhausted" },
      })

      // While T1.1 is dead and T1.3 is still in work, the run has not ended.
      const middle = await run.until("T1.1 budget exhausted", RUN_MS, (s) =>
        s?.tasks["T1.1"]?.state === "budget_exhausted" ? s : undefined,
      )
      expect(["building", "proving", "verifying"]).toContain(middle.tasks["T1.3"]?.state ?? "")
      expect(middle.run.state).toBe("running")

      const end = await run.until("the run ends", RUN_MS, (s) =>
        s && Scripted.ENDS.includes(s.run.state) ? s : undefined,
      )

      // Given: the repository the run used holds the tree that task-demo.sh seeds, with this example folder.
      const added = Workspace.git(run.repo, "log", "--all", "--format=%H %s")
        .split("\n")
        .find((line) => line.endsWith(` add ${FOLDER}`))
        ?.split(" ")[0]
      if (!added) throw new Error(`the run repository has no "add ${FOLDER}" commit`)
      expect(Workspace.git(run.repo, "log", "--format=%s", `${added}~1`)).toBe("seed")
      expect(treeOf(run.repo, added)).toEqual(demoTree(FOLDER))
      // With the scripted model: every model request of the run was a harness turn answered by the script.
      expect(run.requests.length).toBeGreaterThan(0)

      // Then T1.1 is budget exhausted after one attempt: one attempt counted, and its builder never had a second.
      expect(end.tasks["T1.1"]).toMatchObject({ state: "budget_exhausted", attempts: 1 })
      const builds = run.requests.filter((r) => r.role === "builder" && r.unit === "T1.1")
      expect(builds.length).toBeGreaterThan(0)
      expect(new Set(builds.map((r) => r.attempt))).toEqual(new Set([1]))
      expect(end.history.filter((entry) => entry.unit === "T1.1" && entry.to === "budget_exhausted")).toHaveLength(1)

      // And T1.2 and the parent T1 are blocked with the reason "blocked by T1.1: budget exhausted".
      expect(end.tasks["T1.2"]).toMatchObject({ state: "blocked", reason: BLOCKED })
      expect(end.tasks["T1"]).toMatchObject({ state: "blocked", reason: BLOCKED })
      expect(run.requests.some((r) => r.role === "builder" && r.unit === "T1.2")).toBe(false)

      // And T1.3 is trusted.
      expect(end.tasks["T1.3"]?.state).toBe("trusted")
      expect(end.obligations["T1.3.c1"]?.state).toBe("trusted")

      // And the run ends budget exhausted only after T1.3 ends, with the reason lines in that order.
      expect(end.run.state).toBe("budget_exhausted")
      expect(end.run.reason?.split("\n")).toEqual([
        "T1.1 budget exhausted",
        "T1 blocked by T1.1",
        "T1.2 blocked by T1.1",
      ])
      const trusted = end.history.findIndex((entry) => entry.unit === "T1.3" && entry.to === "trusted")
      const ended = end.history.findIndex((entry) => entry.unit === "run" && entry.to === "budget_exhausted")
      expect(trusted).toBeGreaterThan(-1)
      expect(ended).toBeGreaterThan(trusted)
      expect(end.history[ended]?.at ?? 0).toBeGreaterThanOrEqual(end.history[trusted]?.at ?? Infinity)
      expect(end.history.filter((entry) => entry.unit === "run" && entry.to === "budget_exhausted")).toHaveLength(1)
    },
    TIMEOUT,
  )
})

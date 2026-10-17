import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "path"
import * as Workspace from "../task-harness/arms/workspace"
import { Scripted } from "./lib/scripted"

// Scenario VF18 (spec task-harness-feedback, D3, D15, D20, SD-11, T3.9, owner ruling 1): a scripted run of the
// scenarios folder runs its scenario.
//
//   Given the example-scenarios spec in a repository seeded as task-demo.sh seeds the demo folder, with the scripted
//     model
//   When /task runs on it
//   Then T1.1 is trusted, and the parent T1 is trusted by its review
//   And S1 is proved by its [S1] test and trusted by the verifier
//   And the run ends done
//
// `Scripted.start` (test/task/lib/scripted.ts) commits the release-notes seed, the two shipped specs and the folder in
// a fresh git repository, starts a real `opencode serve` of this tree with a scripted model, and types
// `/task task-formats/blend/example-scenarios.spec`: the real command, run supervisor, workers, proofs and merges run.
// The scripted builder of T1.1 writes the slug function and its tests, one titled with T1.1.c1's tag and one with S1's
// tag, then calls `task_ready`; a verifier, reviewer or scenario judge trusts every id it is asked to judge.

const TIMEOUT = 300_000
const RUN_MS = 240_000
const FOLDER = "example-scenarios.spec"
const S1_TEST = "[S1] a release title becomes its slug"
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
  const demo = mkdtempSync(path.join(os.tmpdir(), "verify-vf18-demo-"))
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

describe("[VF18] a scripted run of the scenarios folder", () => {
  test(
    "[VF18] /task on example-scenarios with the scripted model: T1.1 trusted, T1 trusted by its review, S1 proved by its tagged test and trusted by the verifier, and the run ends done",
    async () => {
      await using run = await Scripted.start({
        folder: FOLDER,
        leaves: {
          "T1.1": {
            "src/slug.ts": [
              "export const slugify = (title: string): string =>",
              '  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")',
              "",
            ].join("\n"),
            "test/slug.test.ts": [
              'import { expect, test } from "bun:test"',
              'import { slugify } from "../src/slug"',
              "",
              'test("[T1.1.c1] slugify gives the slug of a title", () => {',
              '  expect(slugify("Hello, World!")).toBe("hello-world")',
              '  expect(slugify(" v1.2.0 ")).toBe("v1-2-0")',
              '  expect(slugify("!!!")).toBe("")',
              "})",
              "",
              `test(${JSON.stringify(S1_TEST)}, () => {`,
              '  expect(slugify("Release 2.0: Faster Notes!")).toBe("release-2-0-faster-notes")',
              "})",
              "",
            ].join("\n"),
          },
        },
      })
      const end = await run.until("the run ends", RUN_MS, (s) =>
        s && Scripted.ENDS.includes(s.run.state) ? s : undefined,
      )
      const entry = (unit: string, to: string) => end.history.findIndex((item) => item.unit === unit && item.to === to)

      // Given: the repository the run used holds the tree that task-demo.sh seeds, with this example folder.
      const added = Workspace.git(run.repo, "log", "--all", "--format=%H %s")
        .split("\n")
        .find((line) => line.endsWith(` add ${FOLDER}`))
        ?.split(" ")[0]
      if (!added) throw new Error(`the run repository has no "add ${FOLDER}" commit`)
      expect(Workspace.git(run.repo, "log", "--format=%s", `${added}~1`)).toBe("seed")
      expect(treeOf(run.repo, added)).toEqual(demoTree(FOLDER))
      expect(run.requests.length).toBeGreaterThan(0)

      // Then T1.1 is trusted.
      expect(end.tasks["T1.1"]).toMatchObject({ state: "trusted", attempts: 1 })
      expect(end.obligations["T1.1.c1"]?.state).toBe("trusted")
      // And the parent T1 is trusted by its review: a reviewer judged T1's review obligation, which is trusted, and
      // T1 became trusted after T1.1.
      expect(end.tasks["T1"]?.state).toBe("trusted")
      expect(end.obligations["T1.e1"]?.state).toBe("trusted")
      expect(run.requests.some((r) => r.role === "reviewer" && r.unit === "T1" && r.judges.includes("T1.e1"))).toBe(
        true,
      )
      expect(entry("T1", "trusted")).toBeGreaterThan(entry("T1.1", "trusted"))
      expect(entry("T1.1", "trusted")).toBeGreaterThan(-1)

      // And S1 is proved by its tagged test: the scenario proof's bun test run passed the test titled with S1's tag,
      // and S1 logged its proof (a verifying scenario logs as pending) before it was trusted.
      const proofLog = readFileSync(path.join(run.repo, ".opencode", "task", "proofs", "scenarios.log"), "utf8")
      expect(proofLog).toContain(S1_TEST)
      expect(proofLog.split("\n").some((line) => line.includes("(pass)") && line.includes(S1_TEST))).toBe(true)
      const proved = entry("S1", "pending")
      const trusted = entry("S1", "trusted")
      expect(proved).toBeGreaterThan(-1)
      expect(trusted).toBeGreaterThan(proved)
      // And trusted by the verifier: a verifier scenario-judge request judged S1 after its proof, and S1 is trusted.
      const judged = run.requests.filter((r) => r.scenario && r.role === "verifier" && r.unit === "S1")
      expect(judged.some((r) => r.judges.includes("S1"))).toBe(true)
      expect(Math.min(...judged.map((r) => r.at))).toBeGreaterThanOrEqual(end.history[proved]?.at ?? Infinity)
      expect(end.scenarios["S1"]?.state).toBe("trusted")

      // And the run ends done, after S1 is trusted.
      expect(end.run.state).toBe("done")
      expect(entry("run", "done")).toBeGreaterThan(trusted)
    },
    TIMEOUT,
  )
})

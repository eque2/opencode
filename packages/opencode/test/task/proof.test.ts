import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { NodeFileSystem } from "@effect/platform-node"
import { Clock, Duration, Effect } from "effect"
import { TaskLimits } from "@/task/limits"
import { TaskProof } from "@/task/proof"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Each test builds a small git repository: a base commit, then the task's commit on top of it. The proof
// runner runs `bun test`, the gates, the `unchanged` checks and the structural rule between the two.

const it = testEffect(NodeFileSystem.layer)
const limits = TaskLimits.scripted

// The runner signals a process group with kill(-pgid), which Windows does not have.
const groupIt = process.platform === "win32" ? it.live.skip : it.live

// The bun test timeout of a test that runs a proof: far above the scripted bounds of one proof.
const proveTimeout = 30_000

const spec: TaskProof.Spec = {
  gates: {
    "BUILD-1": { title: "Always passes", command: "exit 0" },
    "BUILD-2": { title: "The feature file exists", command: "test -f src/feature.ts" },
  },
  obligations: [
    { id: "T1.1.c1", task: "T1.1", proof: { kind: "test", tag: "T1.1.c1" } },
    { id: "T1.1.c2", task: "T1.1", proof: { kind: "test", tag: "T1.1.c2" } },
    { id: "T1.1.p1", task: "T1.1", proof: { kind: "test", tag: "T1.1.c1" } },
    { id: "T1.1.p2", task: "T1.1", proof: { kind: "gate", gate: "BUILD-2" } },
    { id: "T1.1.f1", task: "T1.1", proof: { kind: "unchanged", path: "docs/frozen.md" } },
    { id: "T1.1.p3", task: "T1.1", proof: { kind: "review" } },
    { id: "T1.2.c1", task: "T1.2", proof: { kind: "test", tag: "T1.2.c1" } },
  ],
}

const task: TaskProof.Task = {
  id: "T1.1",
  touches: [{ path: "src/feature.ts", change: "new", what: "the answer" }],
  gates: ["BUILD-1"],
}

const testsOf = (...cases: string[]) =>
  [`import { expect, test } from "bun:test"`, `import { answer } from "../src/feature"`, ...cases, ""].join("\n")

const passing = (tag: string) => `test("[${tag}] holds", () => { expect(answer).toBe(42) })`

const otherTaskTests = [
  `import { expect, test } from "bun:test"`,
  `test("[T1.2.c1] the other task holds", () => { expect(1).toBe(1) })`,
  "",
].join("\n")

const baseFiles = {
  "docs/frozen.md": "# Frozen\n",
  "test/other.test.ts": otherTaskTests,
}

const feature = { "src/feature.ts": "export const answer = 42\n" }

const write = async (dir: string, files: Record<string, string>) => {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, content)
  }
}

const commit = async (dir: string, message: string) => {
  await $`git add -A`.cwd(dir).quiet()
  await $`git commit -m ${message}`.cwd(dir).quiet()
  return (await $`git rev-parse HEAD`.cwd(dir).quiet().text()).trim()
}

// A repository with the base commit and the task's commit, removed when the test's scope closes.
const taskRepo = (head: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir({ git: true })
      await write(tmp.path, baseFiles)
      const base = await commit(tmp.path, "base")
      await write(tmp.path, head)
      return { tmp, dir: tmp.path, base, head: await commit(tmp.path, "task") }
    }),
    (repo) => Effect.promise(() => repo.tmp[Symbol.asyncDispose]()),
  )

const prove = (repo: { dir: string; base: string; head: string }) =>
  TaskProof.proveTask({ spec, task, cwd: repo.dir, base: repo.base, head: repo.head, limits })

const resultOf = (proof: TaskProof.TaskProof, id: string) => proof.obligations.find((result) => result.id === id)

const reasonOf = (proof: TaskProof.TaskProof, id: string) => {
  const result = resultOf(proof, id)
  return result?.status === "failed" ? result.reason : ""
}

const statusOf = (proof: TaskProof.TaskProof, id: string) => resultOf(proof, id)?.status

describe("TaskLimits", () => {
  it.live("selects the scripted bounds only for OPENCODE_TASK_LIMITS=scripted", () =>
    Effect.gen(function* () {
      expect(TaskLimits.select("scripted")).toBe(TaskLimits.scripted)
      expect(TaskLimits.select("live")).toBe(TaskLimits.live)
      expect(TaskLimits.select("")).toBe(TaskLimits.live)
      expect(Duration.toSeconds(TaskLimits.scripted.proofTimeout)).toBe(5)
      expect(Duration.toSeconds(TaskLimits.live.proofTimeout)).toBe(600)
    }),
  )

  it.live("load reads OPENCODE_TASK_LIMITS from the environment", () => {
    const previous = process.env[TaskLimits.variable]
    const restore = Effect.sync(() => {
      if (previous === undefined) delete process.env[TaskLimits.variable]
      else process.env[TaskLimits.variable] = previous
    })
    return Effect.gen(function* () {
      process.env[TaskLimits.variable] = "scripted"
      expect(yield* TaskLimits.load).toBe(TaskLimits.scripted)
      process.env[TaskLimits.variable] = "anything else"
      expect(yield* TaskLimits.load).toBe(TaskLimits.live)
    }).pipe(Effect.ensuring(restore))
  })
})

describe("TaskProof", () => {
  groupIt("all green: test, gate and unchanged obligations pass, a review obligation needs review", () =>
    Effect.gen(function* () {
      const repo = yield* taskRepo({
        ...feature,
        "test/feature.test.ts": testsOf(passing("T1.1.c1"), passing("T1.1.c2"), passing("S1")),
      })
      const proof = yield* prove(repo)
      expect(proof.obligations).toEqual([
        { id: "T1.1.c1", proof: "test", status: "passed" },
        { id: "T1.1.c2", proof: "test", status: "passed" },
        { id: "T1.1.p1", proof: "test", status: "passed" },
        { id: "T1.1.p2", proof: "gate", status: "passed" },
        { id: "T1.1.f1", proof: "unchanged", status: "passed" },
        { id: "T1.1.p3", proof: "review", status: "needs-review" },
      ])
      expect(proof.structural).toEqual({ rule: "touches-plus-tests", status: "passed", violations: [] })
      expect(proof.gates.map((gate) => [gate.gate, gate.status])).toEqual([
        ["BUILD-1", "passed"],
        ["BUILD-2", "passed"],
      ])
      expect(proof.evidence.exitCode).toBe(0)
      expect(proof.evidence.counts).toEqual({ pass: 4, fail: 0, skip: 0 })
      expect(proof.evidence.commit).toBe(repo.head)
      expect(proof.evidence.runId).toMatch(/^proof-/)

      const scenario = yield* TaskProof.proveScenario({ scenario: { id: "S1" }, cwd: repo.dir, head: repo.head, limits })
      expect(scenario.result).toEqual({ status: "passed" })
      expect(scenario.evidence.commit).toBe(repo.head)
    }),
    proveTimeout,
  )

  groupIt("failing tag: that obligation fails with the message, the others keep their result", () =>
    Effect.gen(function* () {
      const repo = yield* taskRepo({
        ...feature,
        "test/feature.test.ts": testsOf(
          passing("T1.1.c1"),
          `test("[T1.1.c2] breaks", () => { throw new Error("deliberate failure 4242") })`,
        ),
      })
      const proof = yield* prove(repo)
      expect(statusOf(proof, "T1.1.c2")).toBe("failed")
      expect(reasonOf(proof, "T1.1.c2")).toContain("[T1.1.c2] breaks")
      expect(reasonOf(proof, "T1.1.c2")).toContain("deliberate failure 4242")
      expect(statusOf(proof, "T1.1.c1")).toBe("passed")
      expect(statusOf(proof, "T1.1.p1")).toBe("passed")
      expect(statusOf(proof, "T1.1.p2")).toBe("passed")
      expect(statusOf(proof, "T1.1.f1")).toBe("passed")
      expect(proof.evidence.exitCode).not.toBe(0)
      expect(proof.evidence.counts).toEqual({ pass: 2, fail: 1, skip: 0 })
    }),
    proveTimeout,
  )

  groupIt("missing tag: an obligation with no test fails with 'no test titled [id]'", () =>
    Effect.gen(function* () {
      const repo = yield* taskRepo({ ...feature, "test/feature.test.ts": testsOf(passing("T1.1.c1")) })
      const proof = yield* prove(repo)
      expect(resultOf(proof, "T1.1.c2")).toEqual({
        id: "T1.1.c2",
        proof: "test",
        status: "failed",
        reason: "no test titled [T1.1.c2]",
      })
      expect(statusOf(proof, "T1.1.c1")).toBe("passed")

      const scenario = yield* TaskProof.proveScenario({ scenario: { id: "S1" }, cwd: repo.dir, head: repo.head, limits })
      expect(scenario.result).toEqual({ status: "failed", reason: "no test titled [S1]" })
    }),
    proveTimeout,
  )

  groupIt("hung test: the tag fails as timed out within the bound, and no process of the group survives", () =>
    Effect.gen(function* () {
      // A unique duration names this test's grandchild for pgrep. Bun kills the `sh` that it spawned
      // when the test times out; the backgrounded `sleep` stays in the group until the runner kills it.
      const seconds = 900000 + Math.floor(Math.random() * 99999)
      const repo = yield* taskRepo({
        ...feature,
        "test/feature.test.ts": testsOf(
          passing("T1.1.c1"),
          `test("[T1.1.c2] waits for a child that never ends", async () => {`,
          `  await Bun.spawn(["sh", "-c", "sleep ${seconds} & echo $! > sleep.pid; wait"]).exited`,
          `})`,
        ),
      })
      const started = yield* Clock.currentTimeMillis
      const proof = yield* prove(repo)
      const elapsed = (yield* Clock.currentTimeMillis) - started

      expect(statusOf(proof, "T1.1.c2")).toBe("failed")
      expect(reasonOf(proof, "T1.1.c2")).toContain("timed out")
      expect(statusOf(proof, "T1.1.c1")).toBe("passed")
      expect(elapsed).toBeLessThan(Duration.toMillis(TaskProof.testRunBound(limits)) + 5000)

      const pid = Number((yield* Effect.promise(() => Bun.file(path.join(repo.dir, "sleep.pid")).text())).trim())
      expect(pid).toBeGreaterThan(1)
      yield* pollWithTimeout(
        Effect.promise(async () => {
          const found = await $`pgrep -f ${`^sleep ${seconds}$`}`.quiet().nothrow()
          return found.exitCode === 1 ? true : undefined
        }),
        `a 'sleep ${seconds}' survived the group kill`,
        limits.cancelDeadline,
      )
      expect(yield* Effect.sync(() => isAlive(pid))).toBe(false)
    }),
    proveTimeout,
  )

  groupIt("tampering: a test file holding another task's tag is a structural violation", () =>
    Effect.gen(function* () {
      const repo = yield* taskRepo({
        ...feature,
        "test/feature.test.ts": testsOf(passing("T1.1.c1"), passing("T1.1.c2")),
        "test/other.test.ts": otherTaskTests.replace("expect(1).toBe(1)", "expect(true).toBe(true)"),
      })
      const proof = yield* prove(repo)
      expect(proof.structural.status).toBe("failed")
      expect(proof.structural.violations.map((violation) => violation.path)).toEqual(["test/other.test.ts"])
      expect(proof.structural.violations[0]?.reason).toContain("[T1.2.c1]")
      for (const id of ["T1.1.c1", "T1.1.c2", "T1.1.p1"]) {
        expect(resultOf(proof, id)).toEqual({
          id,
          proof: "test",
          status: "failed",
          reason: "structural: test/other.test.ts",
        })
      }
      expect(statusOf(proof, "T1.1.p2")).toBe("passed")
      expect(statusOf(proof, "T1.1.f1")).toBe("passed")
    }),
    proveTimeout,
  )

  groupIt("unchanged broken: a change to a forbidden path fails the unchanged obligation", () =>
    Effect.gen(function* () {
      const repo = yield* taskRepo({
        ...feature,
        "test/feature.test.ts": testsOf(passing("T1.1.c1"), passing("T1.1.c2")),
        "docs/frozen.md": "# Frozen\n\nEdited by the task.\n",
      })
      const proof = yield* prove(repo)
      expect(resultOf(proof, "T1.1.f1")).toEqual({
        id: "T1.1.f1",
        proof: "unchanged",
        status: "failed",
        reason: "changed between base and head: docs/frozen.md",
      })
      expect(proof.structural.violations.map((violation) => violation.path)).toEqual(["docs/frozen.md"])
    }),
    proveTimeout,
  )

  groupIt("run: when the leader exits, the runner kills the processes that it left in its group", () =>
    Effect.gen(function* () {
      const result = yield* TaskProof.run("sh", ["-c", "sleep 600 & echo $!"], {
        cwd: process.cwd(),
        timeout: limits.proofTimeout,
        cancelDeadline: limits.cancelDeadline,
      })
      expect(result.exitCode).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.groupCleared).toBe(true)
      expect(isAlive(Number(result.stdout.trim()))).toBe(false)
    }),
  )

  groupIt("run: a command that passes its timeout reports exit 124 and leaves no process", () =>
    Effect.gen(function* () {
      const result = yield* TaskProof.run("sh", ["-c", "sleep 600"], {
        cwd: process.cwd(),
        timeout: "300 millis",
        cancelDeadline: limits.cancelDeadline,
      })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).toBe(TaskProof.timedOutExitCode)
      expect(result.exitCode).toBe(124)
      expect(result.groupCleared).toBe(true)
    }),
  )

  groupIt("run: a group member that ignores SIGTERM dies by SIGKILL after the cancel deadline", () =>
    Effect.gen(function* () {
      // `trap '' TERM` makes the shell ignore SIGTERM, and the backgrounded `sleep` inherits that.
      const started = yield* Clock.currentTimeMillis
      const result = yield* TaskProof.run("sh", ["-c", "trap '' TERM; sleep 600 & echo $!; wait"], {
        cwd: process.cwd(),
        timeout: "300 millis",
        cancelDeadline: limits.cancelDeadline,
      })
      const elapsed = (yield* Clock.currentTimeMillis) - started
      expect(result.timedOut).toBe(true)
      expect(result.groupCleared).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(Duration.toMillis(limits.cancelDeadline))
      const pid = Number(result.stdout.trim())
      expect(pid).toBeGreaterThan(1)
      expect(isAlive(pid)).toBe(false)
    }),
  )
})

// True when a process with this pid exists. Signal 0 checks without sending anything.
function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

#!/usr/bin/env bun
// Conformance runner for the task-harness spike.
//
//   bun run script/task-conformance.ts --arm <baseline|o1|o2|o3> --runs 5 [--live] [--baseline <json>] [--out <json>]
//
// Each run executes test/task-harness/conformance.test.ts once for the arm and scores it: the share of the
// 17 checks (H1-H16 scripted, L1 live) that passed, in percent. The runner prints the statistics as JSON so no
// number in the findings is computed by hand.
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { CHECKS, compare, readChecks, round, stats, type Baseline, type CheckStatus } from "../test/task-harness/stats"

const args = parseArgs(process.argv.slice(2))
const arm = args.arm ?? "baseline"
const runs = Number(args.runs ?? "5")
const live = args.live === "true"
const only = args.checks?.split(",")
const packageDir = path.resolve(import.meta.dir, "..")
const runsRoot = path.resolve(packageDir, "../../.spike-runs")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

if (!["baseline", "o1", "o2", "o3"].includes(arm)) throw new Error(`unknown arm ${arm}`)

const results: RunResult[] = []
for (let run = 1; run <= runs; run++) {
  const waited = await waitForQuietMachine()
  const load = os.loadavg()
  const runId = `${arm}-${stamp}-r${run}`
  const dir = path.join(runsRoot, "conformance", runId)
  fs.mkdirSync(dir, { recursive: true })
  const junit = path.join(dir, "junit.xml")
  const started = Date.now()
  const env: Record<string, string | undefined> = {
    ...process.env,
    TASK_HARNESS_ARM: arm,
    TASK_HARNESS_RUN_ID: runId,
    TASK_HARNESS_RUN_DIR: dir,
    TASK_HARNESS_LIVE: live && arm !== "baseline" ? "1" : "0",
  }
  if (only) env.TASK_HARNESS_CHECKS = only.join(",")
  // The test preload deletes provider keys from the environment, so the live key travels under a prefixed name to
  // the L1 server. Nothing reads, prints or logs its value.
  if (live && arm !== "baseline")
    for (const name of ["OPENAI_API_KEY"]) if (process.env[name]) env[`TASK_HARNESS_LIVE_${name}`] = process.env[name]
  const child = Bun.spawn(
    ["bun", "test", "test/task-harness/conformance.test.ts", "--timeout", "2400000", "--reporter=junit", `--reporter-outfile=${junit}`],
    // The child's stdout goes to stderr (fd 2), so the runner's own stdout carries only the JSON.
    { cwd: packageDir, env, stdout: 2, stderr: "inherit" },
  )
  const exitCode = await child.exited
  const checks = readChecks(fs.existsSync(junit) ? fs.readFileSync(junit, "utf8") : undefined)
  // The baseline exposes no state, so L1 cannot pass for it: scored failed without a run (D8).
  if (arm === "baseline") checks.L1 = "not-runnable"
  const passed = CHECKS.filter((c) => checks[c] === "passed").length
  results.push({
    run,
    runId,
    exitCode,
    loadAverage: load,
    waitedForQuietMs: waited,
    durationMs: Date.now() - started,
    checks,
    score: round((passed / CHECKS.length) * 100),
  })
  console.error(`[task-conformance] ${runId}: score ${results.at(-1)!.score} (${passed}/${CHECKS.length})`)
}

const scores = results.map((r) => r.score)
const summary = stats(scores)
const perCheck = Object.fromEntries(
  CHECKS.map((c) => {
    const passedRuns = results.filter((r) => r.checks[c] === "passed").length
    return [c, { passed: passedRuns, runs: results.length, passK: passedRuns === results.length ? 1 : 0 }]
  }),
)

const out: Record<string, unknown> = {
  arm,
  runs: results.length,
  live,
  commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: packageDir }).stdout.toString().trim(),
  fixture: fixtureHashes(),
  scores,
  ...summary,
  perCheck,
  results,
}

if (args.baseline) {
  const base: Baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8"))
  out.vsBaseline = compare(summary, base, out.fixture)
}

const text = JSON.stringify(out, null, 2)
if (args.out) fs.writeFileSync(args.out, text + "\n")
console.log(text)

type RunResult = {
  run: number
  runId: string
  exitCode: number
  loadAverage: number[]
  waitedForQuietMs: number
  durationMs: number
  checks: Record<string, CheckStatus>
  score: number
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "")
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = "true"
    else {
      out[key] = next
      i++
    }
  }
  return out
}

function fixtureHashes() {
  const tree = (p: string) =>
    Bun.spawnSync(["git", "rev-parse", `HEAD:${p}`], { cwd: packageDir }).stdout.toString().trim() || "uncommitted"
  return {
    spec: tree("task-formats/blend/release-notes.spec"),
    seed: tree("packages/opencode/test/task-harness/release-notes-repo"),
  }
}

// Other sessions run tests on this machine (D8). Wait for any foreign `bun test` to finish, at most 30 minutes.
async function waitForQuietMachine() {
  const start = Date.now()
  while (Date.now() - start < 30 * 60_000) {
    const ps = Bun.spawnSync(["pgrep", "-f", "bun test"]).stdout.toString().trim()
    const foreign = ps
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid && pid !== process.ppid)
    if (foreign.length === 0) break
    await Bun.sleep(10_000)
  }
  return Date.now() - start
}

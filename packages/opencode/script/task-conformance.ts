#!/usr/bin/env bun
// Conformance runner for the task-harness spike.
//
//   bun run script/task-conformance.ts --arm <baseline|o1|o2|o3> --runs 5 [--live] [--checks H1,H3]
//     [--baseline <json>] [--out <json>]
//
// Options take `--name value` or `--name=value`; `--live` is bare or `true`.
//
// Each run executes test/task-harness/conformance.test.ts once for the arm and scores it: the share of the
// 17 checks (H1-H16 scripted, L1 live) that passed, in percent. The runner prints the statistics as JSON so no
// number in the findings is computed by hand.
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { CHECKS, compare, readChecks, round, stats, type Baseline, type CheckStatus } from "../test/task-harness/stats"

const ARMS = ["baseline", "o1", "o2", "o3"]
const args = parseArgs(process.argv.slice(2))
const arm = args.arm ?? "baseline"
if (!/^[1-9]\d*$/.test(args.runs ?? "5")) throw new Error(`--runs must be a positive integer, got ${args.runs}`)
const runs = Number(args.runs ?? "5")
const live = args.live === "true"
const only = args.checks?.split(",").map((id) => id.trim())
for (const id of only ?? [])
  if (!CHECKS.some((c) => c === id)) throw new Error(`unknown check ${id} in --checks; expected ${CHECKS.join(", ")}`)
// The checks a run scores: all 17, or the --checks selection; the others skip and do not count.
const selection: string[] = CHECKS.filter((c) => only === undefined || only.includes(c))
const packageDir = path.resolve(import.meta.dir, "..")
const runsRoot = path.resolve(packageDir, "../../.spike-runs")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}; expected one of ${ARMS.join(", ")}`)

// A comparison is only valid against a baseline measured the same way; refuse it before any run.
const base: (Baseline & { arm?: unknown; live?: unknown; selection?: unknown }) | undefined = args.baseline
  ? JSON.parse(fs.readFileSync(args.baseline, "utf8"))
  : undefined
if (base && base.arm !== "baseline") throw new Error(`--baseline ${args.baseline} is a run of arm ${String(base.arm)}, not baseline`)
if (base && base.live !== live) throw new Error(`--baseline ${args.baseline} has live ${String(base.live)}, this run has ${live}`)
if (base && JSON.stringify(base.selection) !== JSON.stringify(selection))
  throw new Error(`--baseline ${args.baseline} scored checks ${JSON.stringify(base.selection)}, this run scores ${JSON.stringify(selection)}`)

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
  const passed = selection.filter((c) => checks[c] === "passed").length
  results.push({
    run,
    runId,
    exitCode,
    loadAverage: load,
    waitedForQuietMs: waited,
    durationMs: Date.now() - started,
    checks,
    score: round((passed / selection.length) * 100),
  })
  console.error(`[task-conformance] ${runId}: score ${results.at(-1)!.score} (${passed}/${selection.length})`)
}

const scores = results.map((r) => r.score)
const summary = stats(scores)
const perCheck = Object.fromEntries(
  selection.map((c) => {
    const passedRuns = results.filter((r) => r.checks[c] === "passed").length
    return [c, { passed: passedRuns, runs: results.length, passK: passedRuns === results.length ? 1 : 0 }]
  }),
)

const out: Record<string, unknown> = {
  arm,
  runs: results.length,
  live,
  selection,
  commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: packageDir }).stdout.toString().trim(),
  fixture: fixtureHashes(),
  scores,
  ...summary,
  perCheck,
  results,
}

if (base) out.vsBaseline = compare(summary, base, out.fixture)

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
  const known = ["arm", "runs", "live", "checks", "baseline", "out"]
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`)
    const eq = arg.indexOf("=")
    const key = eq < 0 ? arg.slice(2) : arg.slice(2, eq)
    if (!known.includes(key)) throw new Error(`unknown option --${key}; expected ${known.map((k) => `--${k}`).join(", ")}`)
    const next = argv[i + 1]
    if (key === "live") {
      const value = eq >= 0 ? arg.slice(eq + 1) : next === "true" ? next : "true"
      if (eq < 0 && next === "true") i++
      if (value !== "true") throw new Error(`--live takes no value or true, got ${value}`)
      out[key] = value
      continue
    }
    if (eq >= 0) out[key] = arg.slice(eq + 1)
    else if (next !== undefined && !next.startsWith("--")) {
      out[key] = next
      i++
    } else throw new Error(`--${key} needs a value`)
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

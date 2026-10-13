#!/usr/bin/env bun
// The /task conformance guard: the conformance suite run against the current tree and against the code without the
// /task harness, in one invocation, compared in one JSON verdict.
//
//   bun run script/task-conformance.ts --arm o2 --runs 1 [--checks H1,H3] [--out <json>]
//
// Options take `--name value` or `--name=value`. `--live` (bare or `true`) also runs L1 on a real model for o2; it
// spends money, so the guard never needs it.
//
// The arms:
//   - baseline: commit BASELINE_COMMIT, the code without the harness. The runner exports it with `git archive` into
//     `.task-conformance/baseline/<commit>/`, installs it there with its own lockfile, and serves its
//     `packages/opencode/src/index.ts`. A later invocation reuses the export when its `.installed` marker exists.
//   - o2: the current tree, where /task always runs the harness.
// `--arm o2` (the default) runs both arms; `--arm baseline` runs the baseline alone, for diagnostics.
//
// Each run executes test/task-harness/conformance.test.ts once per arm and scores it: the share of the 17 checks
// (H1-H16 scripted, L1 live) that passed, in percent. The JSON goes to stdout and to
// `.task-conformance/conformance/guard-<stamp>.json`. The process exits non-zero when the guard fails:
//   - the baseline server did not start in the preflight (the reason is in `preflight.reason`);
//   - a baseline check H1-H16 is `missing` or `skipped` (L1 is never run for the baseline);
//   - an o2 check H1-H16 did not pass in every run;
//   - o2's median score is less than 50 points above the baseline's.
// A pass proves that the harness meets every scripted check of the contract, and that the checks still tell it apart
// from the code without it. A `--checks` selection skips the other checks, so it always fails the guard.
//
// CI does not run this guard; run it by hand before a change to the harness lands. The package's test run discovers
// conformance.test.ts too, but without TASK_HARNESS_ARM every check skips.
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { BASELINE_ENTRY_ENV, config, entry, killLeft, tree, type Arm } from "../test/task-harness/arms"
import * as Server from "../test/task-harness/arms/server"
import { CHECKS, compare, readChecks, round, stats, type CheckStatus } from "../test/task-harness/stats"

// The code without the /task harness. Pinned: a branch or a merge-base would move under the guard.
const BASELINE_COMMIT = "55ab6b3e56"
// What a run measured with: the fixture trees, the seed, the reference solution and the suite itself.
const FINGERPRINT = {
  spec: "task-formats/blend/release-notes.spec",
  t2: "task-formats/blend/provider-ordering-admin.spec",
  seed: "packages/opencode/test/task-harness/release-notes-repo",
  solution: "packages/opencode/test/task-harness/release-notes-solution",
  suite: "packages/opencode/test/task-harness/conformance.test.ts",
  scripts: "packages/opencode/test/task-harness/scripts.ts",
  arms: "packages/opencode/test/task-harness/arms",
}
// Agent tooling and signed state of the baseline commit: no part of the product, and not to be copied around.
// `_bmad*` is a pathspec wildcard over the tooling folders whose names start so.
const EXPORT_EXCLUDES = [".agents", ".claude", ".eque2-tests", "_bmad*", "state"]
const ARMS: Arm[] = ["baseline", "o2"]
const SCRIPTED = CHECKS.filter((c) => c !== "L1")
const SMALLEST_EFFECT = 50
// One child `bun test` run may take at most 4 hours; then it and every process it started get SIGKILL.
const CHILD_BOUND_MS = 4 * 3_600_000
const INSTALL_BOUND_MS = 20 * 60_000
const PREFLIGHT_READY_MS = 5 * 60_000

const args = parseArgs(process.argv.slice(2))
const arm = ARMS.find((item) => item === (args.arm ?? "o2"))
if (!arm) throw new Error(`unknown arm ${args.arm}; expected one of ${ARMS.join(", ")}`)
if (!/^[1-9]\d*$/.test(args.runs ?? "5")) throw new Error(`--runs must be a positive integer, got ${args.runs}`)
const runs = Number(args.runs ?? "5")
const live = args.live === "true"
const only = args.checks?.split(",").map((id) => id.trim())
for (const id of only ?? [])
  if (!CHECKS.some((c) => c === id)) throw new Error(`unknown check ${id} in --checks; expected ${CHECKS.join(", ")}`)
// The checks a run scores: all 17, or the --checks selection; the others skip and do not count.
const selection: string[] = CHECKS.filter((c) => only === undefined || only.includes(c))
const arms: Arm[] = arm === "o2" ? ["baseline", "o2"] : ["baseline"]
const packageDir = path.resolve(import.meta.dir, "..")
const root = path.resolve(packageDir, "../..")
const runsRoot = path.join(root, ".task-conformance")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

const baseline = await prepareBaseline().then(
  (value) => ({ ...value, error: undefined }),
  (error: unknown) => ({ error: message(error) }),
)
const preflight = baseline.error
  ? { started: false, reason: `the baseline export failed: ${baseline.error}` }
  : await startOnce()

// Without a baseline server every baseline check would fail for the wrong reason and inflate the difference.
const results: Record<string, RunResult[]> = Object.fromEntries(arms.map((a) => [a, []]))
if (preflight.started)
  for (let run = 1; run <= runs; run++) for (const a of arms) results[a].push(await runOnce(a, run))

const summaries = Object.fromEntries(arms.map((a) => [a, summarise(results[a])]))
const fixture = fixtureHashes()
const comparison =
  arm === "o2" && preflight.started
    ? compare(summaries.o2.stats, { ...summaries.baseline.stats, fixture }, fixture)
    : undefined
const failures = guard()

const out = {
  guard: { passed: failures.length === 0, failures },
  arm,
  arms,
  runs,
  live,
  selection,
  commit: git(["rev-parse", "HEAD"]),
  baselineCommit: git(["rev-parse", `${BASELINE_COMMIT}^{commit}`]),
  fixture,
  // Uncommitted changes under the fingerprinted paths: a non-empty list means the hashes do not describe the run.
  dirty: dirtyFixture(),
  baselineExport: baseline,
  preflight,
  results: summaries,
  comparison,
}

const text = JSON.stringify(out, null, 2) + "\n"
const file = path.join(runsRoot, "conformance", `guard-${stamp}.json`)
fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, text)
if (args.out) fs.writeFileSync(args.out, text)
console.error(`[task-conformance] guard ${failures.length === 0 ? "passed" : "FAILED"}; JSON in ${file}`)
await Bun.write(Bun.stdout, text)
process.exit(failures.length === 0 ? 0 : 1)

type RunResult = {
  run: number
  runId: string
  exitCode: number
  loadAverage: number[]
  waitedForQuietMs: number
  // False when other `bun test` runs were still going after 30 minutes and this run started anyway.
  quiet: boolean
  // True when the child run hit the 4-hour bound and was killed.
  timedOut: boolean
  durationMs: number
  checks: Record<string, CheckStatus>
  score: number
}

// Every clause of the guard that applies to the arms that ran; an empty list is a pass.
function guard() {
  if (!preflight.started) return [`the baseline server did not start: ${preflight.reason}`]
  const baselineGaps = results.baseline.flatMap((r) =>
    SCRIPTED.filter((c) => r.checks[c] === "missing" || r.checks[c] === "skipped").map(
      (c) => `baseline run ${r.run}: ${c} is ${r.checks[c]}`,
    ),
  )
  if (!comparison) return baselineGaps
  const o2Gaps = results.o2.flatMap((r) =>
    SCRIPTED.filter((c) => r.checks[c] !== "passed").map((c) => `o2 run ${r.run}: ${c} is ${r.checks[c]}`),
  )
  const effect =
    comparison.change < SMALLEST_EFFECT
      ? [`o2's median score is ${comparison.change} points above the baseline's, under ${SMALLEST_EFFECT}`]
      : []
  return [...baselineGaps, ...o2Gaps, ...effect]
}

// One `bun test` run of the suite for one arm, scored.
async function runOnce(a: Arm, run: number): Promise<RunResult> {
  const { waited, quiet } = await waitForQuietMachine()
  const load = os.loadavg()
  const runId = `${a}-${stamp}-r${run}`
  const dir = path.join(runsRoot, "conformance", runId)
  fs.mkdirSync(dir, { recursive: true })
  const junit = path.join(dir, "junit.xml")
  const started = Date.now()
  const env: Record<string, string | undefined> = {
    ...process.env,
    TASK_HARNESS_ARM: a,
    TASK_HARNESS_RUN_ID: runId,
    TASK_HARNESS_RUN_DIR: dir,
    TASK_HARNESS_LIVE: live && a !== "baseline" ? "1" : "0",
  }
  if (only) env.TASK_HARNESS_CHECKS = only.join(",")
  // The test preload deletes provider keys from the environment, so the live key travels under a prefixed name to
  // the L1 server. Nothing reads, prints or logs its value.
  if (live && a !== "baseline")
    for (const name of ["OPENAI_API_KEY"]) if (process.env[name]) env[`TASK_HARNESS_LIVE_${name}`] = process.env[name]
  const child = Bun.spawn(
    ["bun", "test", "test/task-harness/conformance.test.ts", "--timeout", "2400000", "--reporter=junit", `--reporter-outfile=${junit}`],
    // The child's stdout goes to stderr (fd 2), so the runner's own stdout carries only the JSON.
    { cwd: packageDir, env, stdout: 2, stderr: "inherit" },
  )
  let timedOut = false
  const bound = setTimeout(() => {
    timedOut = true
    const procs = tree(child.pid)
    child.kill("SIGKILL")
    killLeft(procs)
  }, CHILD_BOUND_MS)
  const exitCode = await child.exited
  clearTimeout(bound)
  const checks = readChecks(fs.existsSync(junit) ? fs.readFileSync(junit, "utf8") : undefined)
  // The baseline exposes no task state, so L1 cannot pass for it: scored failed without a run.
  if (a === "baseline") checks.L1 = "not-runnable"
  const passed = selection.filter((c) => checks[c] === "passed").length
  const score = round((passed / selection.length) * 100)
  console.error(`[task-conformance] ${runId}: score ${score} (${passed}/${selection.length})`)
  return {
    run,
    runId,
    exitCode,
    loadAverage: load,
    waitedForQuietMs: waited,
    quiet,
    timedOut,
    durationMs: Date.now() - started,
    checks,
    score,
  }
}

function summarise(list: RunResult[]) {
  const scores = list.map((r) => r.score)
  return {
    scores,
    stats: stats(scores),
    perCheck: Object.fromEntries(
      selection.map((c) => {
        const passedRuns = list.filter((r) => r.checks[c] === "passed").length
        return [c, { passed: passedRuns, runs: list.length, passK: passedRuns === list.length ? 1 : 0 }]
      }),
    ),
    runs: list,
  }
}

// The baseline tree, exported and installed once under the run folder, then reused while its marker exists. The
// suite's servers find its entry through BASELINE_ENTRY_ENV, which every child inherits.
async function prepareBaseline() {
  const dir = path.join(runsRoot, "baseline", BASELINE_COMMIT)
  const marker = path.join(dir, ".installed")
  const reused = fs.existsSync(marker)
  if (!reused) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const exported = Bun.spawnSync(
      [
        "bash",
        "-c",
        'set -o pipefail; dir="$1"; shift; git archive "$@" | tar -x -C "$dir"',
        "bash",
        dir,
        BASELINE_COMMIT,
        "--",
        ".",
        ...EXPORT_EXCLUDES.map((p) => `:(exclude)${p}`),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    if (exported.exitCode !== 0) throw new Error(`git archive ${BASELINE_COMMIT} | tar -x failed: ${exported.stderr.toString()}`)
    await install(dir)
  }
  const core = coreInside(dir)
  if (!reused) fs.writeFileSync(marker, `${git(["rev-parse", `${BASELINE_COMMIT}^{commit}`])}\n`)
  const baselineEntry = path.join(dir, "packages/opencode/src/index.ts")
  process.env[BASELINE_ENTRY_ENV] = baselineEntry
  return { dir, entry: entry("baseline"), reused, core }
}

async function install(dir: string) {
  const log = path.join(dir, ".install.log")
  const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: dir,
    // Electron's binary is not needed to serve opencode; HUSKY=0 skips the git hooks, the export has no .git.
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1", HUSKY: "0" },
    stdout: Bun.file(log),
    stderr: Bun.file(`${log}.stderr`),
    detached: true,
  })
  let timedOut = false
  const bound = setTimeout(() => {
    timedOut = true
    Server.kill(proc.pid, "SIGKILL")
  }, INSTALL_BOUND_MS)
  const code = await proc.exited
  clearTimeout(bound)
  if (timedOut) throw new Error(`bun install in ${dir} did not finish within ${INSTALL_BOUND_MS / 60_000} minutes; log ${log}`)
  if (code !== 0)
    throw new Error(`bun install in ${dir} exited ${code}; log ${log}:\n${fs.readFileSync(`${log}.stderr`, "utf8").slice(-2000)}`)
}

// The export sits inside this worktree, so a dependency it lacks would resolve from the current tree's node_modules
// further up. @opencode-ai/core must resolve inside the export, or the baseline would run the current tree's code.
function coreInside(dir: string) {
  const top = fs.realpathSync(dir)
  const links = ["packages/opencode/node_modules/@opencode-ai/core", "node_modules/@opencode-ai/core"]
    .map((p) => path.join(dir, p))
    .filter((p) => fs.existsSync(p))
  if (links.length === 0) throw new Error(`the export ${dir} has no node_modules/@opencode-ai/core`)
  return links.map((link) => {
    const real = fs.realpathSync(link)
    if (!real.startsWith(top + path.sep)) throw new Error(`${link} resolves to ${real}, outside the export ${top}`)
    return real
  })
}

// Start the baseline server once, before the suite, and require its "listening on" line. It is the export's first,
// cold start: right after an install the OS still scans the new files and Bun has transpiled nothing, so it waits for
// a quiet machine and gets PREFLIGHT_READY_MS. It warms the export for the suite, whose servers get 60 s each.
async function startOnce(): Promise<{
  started: boolean
  reason?: string
  url?: string
  ms?: number
  log?: string
  quiet?: boolean
  waitedForQuietMs?: number
}> {
  const dir = path.join(runsRoot, "conformance", `preflight-${stamp}`)
  const repo = path.join(dir, "repo")
  const home = path.join(dir, "home")
  fs.mkdirSync(repo, { recursive: true })
  const { waited, quiet } = await waitForQuietMachine()
  const started = Date.now()
  return Server.start(
    {
      entry: entry("baseline"),
      repo,
      home,
      // The suite's scripted-model configuration; the address is never called, the preflight sends no prompt.
      config: config("baseline", { kind: "scripted", url: "http://127.0.0.1:9" }),
      // What the test preload gives each check's server.
      env: {
        OPENCODE_MODELS_PATH: path.join(packageDir, "test/tool/fixtures/models-api.json"),
        OPENCODE_EXPERIMENTAL_EVENT_SYSTEM: "true",
        OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
      },
    },
    PREFLIGHT_READY_MS,
  ).then(
    async (server) => {
      const procs = tree(server.pid)
      await Server.stop(server)
      killLeft(procs)
      return { started: true, url: server.url, ms: Date.now() - started, log: server.log, quiet, waitedForQuietMs: waited }
    },
    (error: unknown) => ({ started: false, reason: message(error), ms: Date.now() - started, quiet, waitedForQuietMs: waited }),
  )
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function git(argv: string[]) {
  return Bun.spawnSync(["git", ...argv], { cwd: packageDir }).stdout.toString().trim()
}

function parseArgs(argv: string[]) {
  const known = ["arm", "runs", "live", "checks", "out"]
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
  return Object.fromEntries(Object.entries(FINGERPRINT).map(([key, p]) => [key, git(["rev-parse", `HEAD:${p}`]) || "uncommitted"]))
}

function dirtyFixture() {
  const out = Bun.spawnSync(["git", "status", "--porcelain", "--", ...Object.values(FINGERPRINT)], { cwd: root })
  return out.stdout.toString().split("\n").filter(Boolean)
}

// Other sessions run tests on this machine. Wait for any foreign `bun test` to finish, at most 30 minutes.
async function waitForQuietMachine() {
  const start = Date.now()
  let quiet = false
  while (Date.now() - start < 30 * 60_000) {
    const ps = Bun.spawnSync(["pgrep", "-f", "bun test"]).stdout.toString().trim()
    const foreign = ps
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid && pid !== process.ppid)
    // ponytail: quiet also means the 1-minute load average is under 80% of the cores; the scripted bounds are
    // seconds long, so a loaded machine turns them into flakes. Raise the share if a busy host never qualifies.
    const busy = os.loadavg()[0] > os.cpus().length * 0.8
    if (foreign.length === 0 && !busy) {
      quiet = true
      break
    }
    await Bun.sleep(10_000)
  }
  return { waited: Date.now() - start, quiet }
}

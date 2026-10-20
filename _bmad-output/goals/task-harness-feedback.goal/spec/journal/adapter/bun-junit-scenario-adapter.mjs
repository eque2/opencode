#!/usr/bin/env node
// bun-junit-scenario-adapter.mjs — run ONE bun:test scenario file with bun's JUnit reporter and hand each result,
// unchanged, to the public Vitest hook `onTestRunEnd(files)` of scenario-state-reporter.mjs.
//
// Recipe: owner ruling 6 of task-harness-feedback (spec.md), precedent log-proxy.goal/spec/journal/S6.md.
// This file is a verifier-scratchpad tool. It never edits the reporter, the state CLI, evidence or key material:
// the reporter alone writes evidence, and only in a real (non --dry-run) run.
//
// Usage:
//   node bun-junit-scenario-adapter.mjs --cwd=<package dir> --file=<./path/to/verify-X-ID.spec.ts>
//        --runs=<run root dir> [--timeout=30000] [--overall-ms=170000] [--idle-ms=120000] [--bun=<bun binary>]
//        ( --dry-run | --spec-folder=<abs spec folder> --reporter=<abs path to scenario-state-reporter.mjs> )
//
// What it does, in order:
//   1. Hashes the test file (sha256) before the run.
//   2. Makes a FRESH run dir <runs>/<runId>/ (refuses when it exists) and spawns bun itself:
//        bun test --timeout=<t> --reporter=junit --reporter-outfile=<run dir>/junit.xml <file>
//      in <cwd>. One process binds the run to the report. Output is teed to the console and <run dir>/run.log.
//      The process group is killed after --overall-ms, or after --idle-ms with no output.
//   3. Refuses (exit 3, nothing handed to the reporter) when:
//        R1 the report names another file (suite or testcase `file` does not resolve to <file>, or >1 file suite);
//        R2 the counts disagree (root/suite attributes vs parsed testcases, or JUnit vs bun's console summary,
//           or exit 0 with failures);
//        R3 bun exits 0 and writes no report;
//        R4 the test file changed during the run (hash before != hash after);
//        R5 bun was killed (overall or idle timeout) — a hang is not a test result; re-run or record it.
//   4. Maps the report to the Vitest file shape: suites -> { name, tasks }, testcases -> { name, result:
//      { state: pass|fail|skip, duration(ms) } }. Names are entity-decoded and otherwise unchanged. The file
//      result is { state: exit === 0 ? "pass" : "fail" }: a non-zero exit always fails the file. A non-zero
//      exit with no report (module-level throw) maps to an empty file with result fail.
//   5. --dry-run prints the mapped shape and stops (the reporter is NOT imported, no evidence).
//      Otherwise it imports the reporter, constructs it with { specFolder }, and calls onTestRunEnd([file]).
//
// Exit codes: 0 handed off, bun exit 0 | 1 handed off, bun exit != 0 | 3 refused | 4 usage or infrastructure error.
// Every run writes <run dir>/run.json (the manifest: command, exit, counts, hashes, decision).

import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

// ---------------------------------------------------------------------------------------------------- arguments

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (!match) usage(`unknown argument ${arg}`)
    return [match[1], match[2] ?? true]
  }),
)

function usage(message) {
  console.error(`[bun-junit-adapter] ${message}`)
  console.error(
    "usage: --cwd=<dir> --file=<test file> --runs=<run root> [--timeout=30000] [--overall-ms=170000] [--idle-ms=120000] [--bun=<bin>] (--dry-run | --spec-folder=<dir> --reporter=<file>)",
  )
  process.exit(4)
}

const known = new Set(["cwd", "file", "runs", "timeout", "overall-ms", "idle-ms", "bun", "dry-run", "spec-folder", "reporter"])
for (const name of Object.keys(args)) if (!known.has(name)) usage(`unknown option --${name}`)
for (const name of ["cwd", "file", "runs"]) if (typeof args[name] !== "string" || args[name] === "") usage(`--${name} is required`)
const dryRun = args["dry-run"] === true
if (!dryRun) {
  for (const name of ["spec-folder", "reporter"])
    if (typeof args[name] !== "string" || !path.isAbsolute(args[name])) usage(`--${name}=<absolute path> is required without --dry-run`)
}
const int = (name, fallback) => {
  if (args[name] === undefined) return fallback
  const value = Number(args[name])
  if (!Number.isInteger(value) || value <= 0) usage(`--${name} must be a positive integer`)
  return value
}
const timeoutMs = int("timeout", 30000)
const overallMs = int("overall-ms", 170000)
const idleMs = int("idle-ms", 120000)
const bunBin = typeof args.bun === "string" ? args.bun : "bun"

const cwd = path.resolve(args.cwd)
const fileArg = args.file
const testFile = path.resolve(cwd, fileArg)
if (!fs.existsSync(testFile) || !fs.statSync(testFile).isFile()) usage(`test file not found: ${testFile}`)
const canonical = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const testFileReal = canonical(testFile)

// ---------------------------------------------------------------------------------------------------- run dir

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
const runId = `${stamp}-${crypto.randomBytes(3).toString("hex")}`
const runDir = path.join(path.resolve(args.runs), runId)
if (fs.existsSync(runDir)) usage(`run dir exists, refusing to reuse it: ${runDir}`)
fs.mkdirSync(runDir, { recursive: true })
const junitPath = path.join(runDir, "junit.xml")
const logPath = path.join(runDir, "run.log")
const log = fs.createWriteStream(logPath)

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const manifest = {
  runId,
  adapter: "bun-junit-scenario-adapter.mjs",
  mode: dryRun ? "dry-run" : "real",
  cwd,
  file: fileArg,
  testFile,
  junit: junitPath,
  log: logPath,
  bun: bunBin,
  command: [bunBin, "test", `--timeout=${timeoutMs}`, "--reporter=junit", `--reporter-outfile=${junitPath}`, fileArg],
  hashBefore: sha(testFile),
}

function finish(code, decision, extra = {}) {
  Object.assign(manifest, { decision, adapterExit: code, ...extra })
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(manifest, null, 2) + "\n")
  console.error(`[bun-junit-adapter] runId=${runId} decision=${decision} exit=${code} manifest=${path.join(runDir, "run.json")}`)
  log.end(() => process.exit(code))
}

function refuse(rule, reason) {
  console.error(`[bun-junit-adapter] REFUSED ${rule}: ${reason}`)
  finish(3, `refused:${rule}`, { refusal: { rule, reason } })
}

// ---------------------------------------------------------------------------------------------------- run bun

console.error(`[bun-junit-adapter] runId=${runId} cwd=${cwd}`)
console.error(`[bun-junit-adapter] $ ${manifest.command.join(" ")}`)
const started = Date.now()
const child = spawn(bunBin, manifest.command.slice(1), {
  cwd,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})
let output = ""
let lastOutput = Date.now()
let killedBy
const tee = (stream, sink) =>
  stream.on("data", (chunk) => {
    lastOutput = Date.now()
    const text = chunk.toString()
    output += text
    log.write(text)
    sink.write(text)
  })
tee(child.stdout, process.stdout)
tee(child.stderr, process.stderr)
const killGroup = (why) => {
  if (killedBy) return
  killedBy = why
  console.error(`[bun-junit-adapter] killing bun process group: ${why}`)
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}
const watchdog = setInterval(() => {
  if (Date.now() - started > overallMs) killGroup(`overall limit ${overallMs} ms`)
  else if (Date.now() - lastOutput > idleMs) killGroup(`no output for ${idleMs} ms`)
}, 500)

child.on("error", (error) => {
  clearInterval(watchdog)
  console.error(`[bun-junit-adapter] could not spawn ${bunBin}: ${error.message}`)
  finish(4, "error:spawn", { error: error.message })
})

child.on("close", (exitCode, signal) => {
  clearInterval(watchdog)
  const durationMs = Date.now() - started
  Object.assign(manifest, { bunExit: exitCode, signal, durationMs, hashAfter: sha(testFile) })
  decide(exitCode, signal, durationMs).catch((error) => {
    console.error(`[bun-junit-adapter] ${error.stack ?? error}`)
    finish(4, "error:adapter", { error: String(error.message ?? error) })
  })
})

// ---------------------------------------------------------------------------------------------------- decide

async function decide(exitCode, signal, durationMs) {
  if (killedBy) return refuse("R5", `bun was killed (${killedBy}); a hang is not a test result`)
  if (manifest.hashAfter !== manifest.hashBefore)
    return refuse("R4", `the test file changed during the run (${manifest.hashBefore.slice(0, 16)} -> ${manifest.hashAfter.slice(0, 16)})`)
  const code = exitCode ?? 1
  const hasReport = fs.existsSync(junitPath)
  if (!hasReport && code === 0) return refuse("R3", "bun exited 0 and wrote no JUnit report")

  const summary = consoleSummary(output)
  manifest.summary = summary
  let file
  if (!hasReport) {
    // A module-level throw: bun runs no test and writes no report. The file fails, with no test results.
    file = { filepath: testFile, tasks: [], result: { state: "fail", duration: durationMs } }
    manifest.counts = { tests: 0, passed: 0, failed: 0, skipped: 0, note: "no report; non-zero exit" }
  } else {
    const report = parseXml(fs.readFileSync(junitPath, "utf8"))
    const checked = checkReport(report, code, summary)
    if (checked.refusal) return refuse(checked.refusal.rule, checked.refusal.reason)
    manifest.counts = checked.counts
    file = {
      filepath: testFile,
      tasks: checked.tasks,
      result: { state: code === 0 ? "pass" : "fail", duration: durationMs },
    }
  }
  // The window between the hash check and the reporter's own source hash is this function; check once more.
  if (sha(testFile) !== manifest.hashBefore) return refuse("R4", "the test file changed after the run")
  fs.writeFileSync(path.join(runDir, "mapped.json"), JSON.stringify([file], null, 2) + "\n")
  console.error(
    `[bun-junit-adapter] mapped: tests=${manifest.counts.tests} pass=${manifest.counts.passed} fail=${manifest.counts.failed} skip=${manifest.counts.skipped} file=${file.result.state} bunExit=${code}`,
  )
  if (dryRun) {
    console.log(JSON.stringify([file], null, 2))
    return finish(code === 0 ? 0 : 1, "dry-run:mapped")
  }
  process.env.SPEC_FOLDER = args["spec-folder"]
  const { default: Reporter } = await import(pathToFileURL(args.reporter).href)
  const reporter = new Reporter({ specFolder: args["spec-folder"] })
  reporter.onTestRunEnd([file])
  if (sha(testFile) !== manifest.hashBefore)
    console.error("[bun-junit-adapter] WARNING: the test file changed while the reporter ran; its evidence hash will not match")
  return finish(code === 0 ? 0 : 1, "handed-off")
}

// bun's console summary: the LAST block of "N pass / N fail / N skip / N todo" lines and "Ran N tests across N files."
function consoleSummary(text) {
  const ran = [...text.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)].at(-1)
  if (!ran) return undefined
  const before = text.slice(0, ran.index)
  const block = before.slice(Math.max(0, before.lastIndexOf("\n\n")))
  const count = (word) => {
    const hit = [...block.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "gm"))].at(-1)
    return hit ? Number(hit[1]) : 0
  }
  return { ran: Number(ran[1]), files: Number(ran[2]), pass: count("pass"), fail: count("fail"), skip: count("skip"), todo: count("todo") }
}

function checkReport(report, code, summary) {
  const refusal = (rule, reason) => ({ refusal: { rule, reason } })
  const root = report.children.find((node) => node.name === "testsuites")
  if (!root) return refusal("R2", "the report has no <testsuites> root")
  const fileSuites = root.children.filter((node) => node.name === "testsuite")
  if (fileSuites.length !== 1) return refusal("R1", `the report holds ${fileSuites.length} file suites, expected exactly 1`)
  const suite = fileSuites[0]
  const resolves = (attr) => attr !== undefined && canonical(path.resolve(cwd, attr)) === testFileReal
  if (!resolves(suite.attrs.file)) return refusal("R1", `the report is for '${suite.attrs.file}', not '${fileArg}'`)

  const cases = []
  const mapSuite = (node) =>
    node.children.flatMap((childNode) => {
      if (childNode.name === "testsuite") {
        if (childNode.attrs.file !== undefined && !resolves(childNode.attrs.file))
          throw Object.assign(new Error("other file"), { other: childNode.attrs.file })
        return [{ name: childNode.attrs.name ?? "", tasks: mapSuite(childNode) }]
      }
      if (childNode.name !== "testcase") return []
      if (!resolves(childNode.attrs.file)) throw Object.assign(new Error("other file"), { other: childNode.attrs.file })
      const failed = childNode.children.some((c) => c.name === "failure" || c.name === "error")
      const skipped = childNode.children.some((c) => c.name === "skipped")
      const state = failed ? "fail" : skipped ? "skip" : "pass"
      cases.push(state)
      const seconds = Number(childNode.attrs.time ?? 0)
      return [{ name: childNode.attrs.name ?? "", result: { state, duration: Number.isFinite(seconds) ? seconds * 1000 : 0 } }]
    })
  let tasks
  try {
    tasks = mapSuite(suite)
  } catch (error) {
    if (error.other !== undefined) return refusal("R1", `a test in the report is for '${error.other}', not '${fileArg}'`)
    throw error
  }
  const counts = {
    tests: cases.length,
    passed: cases.filter((s) => s === "pass").length,
    failed: cases.filter((s) => s === "fail").length,
    skipped: cases.filter((s) => s === "skip").length,
  }
  const attr = (node, name) => (node.attrs[name] === undefined ? undefined : Number(node.attrs[name]))
  for (const [label, node] of [["testsuites", root], ["file testsuite", suite]]) {
    for (const [name, value] of [["tests", counts.tests], ["failures", counts.failed], ["skipped", counts.skipped]]) {
      const declared = attr(node, name)
      if (declared !== value) return refusal("R2", `${label} ${name}=${declared} but the report holds ${value}`)
    }
  }
  if (code === 0 && counts.failed > 0) return refusal("R2", `bun exited 0 but the report holds ${counts.failed} failures`)
  if (summary === undefined) {
    if (code === 0) return refusal("R2", "bun exited 0 but printed no 'Ran N tests across N files.' summary to compare")
  } else {
    const disagree = [
      ["files", summary.files, 1],
      ["tests", summary.ran, counts.tests],
      ["pass", summary.pass, counts.passed],
      ["fail", summary.fail, counts.failed],
      ["skip+todo", summary.skip + summary.todo, counts.skipped],
    ].filter(([, said, held]) => said !== held)
    if (disagree.length > 0)
      return refusal("R2", `bun's summary and the report disagree: ${disagree.map(([n, s, h]) => `${n} ${s} vs ${h}`).join(", ")}`)
  }
  return { tasks, counts }
}

// ---------------------------------------------------------------------------------------------------- tiny XML

// A strict parser for the XML subset bun writes: declaration, comments, CDATA, elements, attributes, text.
function parseXml(source) {
  const doc = { name: "#document", attrs: {}, children: [] }
  const stack = [doc]
  let i = 0
  const decode = (text) =>
    text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
      if (entity[0] === "#")
        return String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10))
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity]
    })
  const fail = (why) => {
    throw new Error(`malformed JUnit XML at offset ${i}: ${why}`)
  }
  while (i < source.length) {
    if (source[i] !== "<") {
      const next = source.indexOf("<", i)
      i = next === -1 ? source.length : next
      continue
    }
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i)
      if (end === -1) fail("unterminated declaration")
      i = end + 2
    } else if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i)
      if (end === -1) fail("unterminated comment")
      i = end + 3
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i)
      if (end === -1) fail("unterminated CDATA")
      i = end + 3
    } else if (source.startsWith("</", i)) {
      const end = source.indexOf(">", i)
      if (end === -1) fail("unterminated end tag")
      const name = source.slice(i + 2, end).trim()
      const open = stack.pop()
      if (!open || open.name !== name) fail(`end tag </${name}> does not close <${open?.name}>`)
      i = end + 1
    } else {
      const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(i, i + 200))
      if (!nameMatch) fail("bad start tag")
      const node = { name: nameMatch[1], attrs: {}, children: [] }
      i += nameMatch[0].length
      for (;;) {
        while (/\s/.test(source[i] ?? "")) i++
        if (source.startsWith("/>", i)) {
          i += 2
          stack.at(-1).children.push(node)
          break
        }
        if (source[i] === ">") {
          i += 1
          stack.at(-1).children.push(node)
          stack.push(node)
          break
        }
        const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(source.slice(i))
        if (!attr) fail(`bad attribute in <${node.name}>`)
        node.attrs[attr[1]] = decode(attr[3] ?? attr[4])
        i += attr[0].length
      }
    }
  }
  if (stack.length !== 1) fail(`unclosed <${stack.at(-1).name}>`)
  return doc
}

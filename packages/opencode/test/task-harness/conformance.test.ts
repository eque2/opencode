// The conformance suite of the /task harness: H1–H16 scripted, L1 live (harness contract, section 8).
//
//   TASK_HARNESS_ARM=<baseline|o2> bun test test/task-harness/conformance.test.ts --timeout 2400000
//
// `script/task-conformance.ts` runs it for both arms; it exports the baseline tree and sets TASK_HARNESS_BASELINE_ENTRY,
// without which the baseline arm cannot start a server.
//
// Each check runs on a fresh copy of the seed with its own `opencode serve` process and its own scripted model, and
// passes only through the arm's observable behaviour: the status file, the requests the scripted model received, the
// target repository's git state and the process table. `script/task-conformance.ts` runs this file per run and
// scores it. Environment: TASK_HARNESS_ARM, TASK_HARNESS_RUN_DIR (default `<worktree>/.task-conformance/conformance/dev`),
// TASK_HARNESS_CHECKS (comma list; the other checks skip), TASK_HARNESS_LIVE=1 (runs L1).
//
// The status file must exist within 30 s of `/task` (section 3: the harness rewrites it after every state change,
// and H1/H2 bound the load to 30 s). A check whose arm writes none fails then, instead of waiting out its full limit;
// that keeps a baseline run to minutes.
import { test } from "bun:test"
import path from "node:path"
import fs from "node:fs"
import matter from "gray-matter"
import * as Arms from "./arms"
import * as Server from "./arms/server"
import * as Status from "./arms/status"
import * as Workspace from "./arms/workspace"
import * as Scripts from "./scripts"

const packageDir = path.resolve(import.meta.dir, "../..")
const worktree = path.resolve(packageDir, "../..")
// The package's default test run discovers this file too; without an arm every check registers as skipped.
const armed = process.env.TASK_HARNESS_ARM !== undefined
const arm = Arms.parseArm(process.env.TASK_HARNESS_ARM)
const runDir = process.env.TASK_HARNESS_RUN_DIR || path.join(worktree, ".task-conformance", "conformance", "dev")
const selected = (process.env.TASK_HARNESS_CHECKS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
const live = process.env.TASK_HARNESS_LIVE === "1"

const SPEC = Workspace.releaseNotesSpec
const T1_DIR = `${SPEC}/T1-release-notes.task`
const T11_DIR = `${T1_DIR}/T1.1-commit-parser.task`
const T11_VERIFY = `${T11_DIR}/VERIFY.md`
const LEAVES = ["T1.1", "T1.2", "T1.3", "T1.4", "T1.5"]
const LOCAL_SCENARIOS = Array.from({ length: 12 }, (_, i) => `S${i + 1}`)
const POLL_MS = 200
const STATUS_APPEARS_MS = 30_000
const SETUP_MS = 180_000
const ENDED: Status.RunState[] = ["refused", "cancelled", "needs_human", "budget_exhausted", "failed"]
const LIVE_ENDS: Status.RunState[] = ["done", "budget_exhausted", "needs_human", "failed"]
const LIVE_WALL_MS = 30 * 60_000
const LIVE_TOKENS = 1_500_000
const LIVE_IDLE_MS = 60_000
// The preload of this package's test run deletes provider keys from the environment; the runner hands the live
// key over under this prefix so the server inherits it. The suite never reads, prints or logs its value.
const LIVE_KEYS = ["OPENAI_API_KEY"]

// --- the fixture ---------------------------------------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

function front(file: string) {
  return record(matter(fs.readFileSync(path.join(worktree, file), "utf8")).data)
}

const specFront = front(`${SPEC}/SPEC.md`)
const taskAttempts = Number(record(record(specFront.policy).budgets).taskAttempts ?? 3)
const t2Outside = Object.keys(record(front("task-formats/blend/provider-ordering-admin.spec/SPEC.md").outside))

// Qualified obligation ids per task, from every VERIFY.md of the release-notes tree (31 in all).
const obligations: Map<string, string[]> = (() => {
  const out = new Map<string, string[]>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(worktree, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sub = `${dir}/${entry.name}`
      const task = /^(T[\d.]+)-/.exec(entry.name)?.[1]
      const verify = `${sub}/VERIFY.md`
      if (task && fs.existsSync(path.join(worktree, verify))) {
        const data = front(verify)
        const keys = ["ensures", "preserves", "forbids"].flatMap((group) => Object.keys(record(data[group])))
        out.set(
          task,
          keys.map((key) => `${task}.${key}`),
        )
      }
      walk(sub)
    }
  }
  walk(SPEC)
  return out
})()
const allObligations = [...obligations.values()].flat()

function solutionSrc() {
  return fs.readdirSync(path.join(Workspace.solutionDir, "src")).filter((file) => file.endsWith(".ts"))
}

function gitShow(repo: string, ref: string) {
  const out = Bun.spawnSync(["git", "show", ref], { cwd: repo })
  return out.exitCode === 0 ? out.stdout.toString() : undefined
}

// --- one check -----------------------------------------------------------------------------------------------------------

type Ctx = {
  readonly id: string
  readonly ws: Workspace.Workspace
  readonly model: Scripts.ScriptedModel
  readonly script: Scripts.Script
  readonly arm: Arms.Adapter
  readonly marker: string
} & AsyncDisposable

function check(id: string, behaviour: string, timeout: number, fn: () => Promise<void>, skip = false) {
  const on = armed && !skip && (selected.length === 0 || selected.includes(id))
  if (on) test(`${id} ${behaviour}`, fn, timeout)
  else test.skip(`${id} ${behaviour}`, fn)
}

async function open(check: string, prepare?: (repo: string) => void): Promise<Ctx> {
  // Digits only, so `sleep 999.<marker>` stays a valid number; fixed width (7 + 6), so no check's marker is a prefix
  // of another's and a match on `sleep 999.<marker>` reaches only this check's processes.
  const marker = `${String(process.pid).padStart(7, "0")}${String(Date.now() % 1_000_000).padStart(6, "0")}`
  const ws = Workspace.create(runDir, check)
  prepare?.(ws.repo)
  const model = await Scripts.start({ check, marker })
  const patterns = [ws.dir, `sleep 999.${marker}`]
  const adapter = await Arms.open({ arm, workspace: ws, model: { kind: "scripted", url: model.url } }).catch(
    async (error: unknown) => {
      await model.close()
      Arms.sweep(patterns)
      throw error
    },
  )
  return {
    id: check,
    ws,
    model,
    script: model.script,
    arm: adapter,
    marker,
    async [Symbol.asyncDispose]() {
      await adapter.close()
      await model.close()
      Arms.sweep(patterns)
      fs.writeFileSync(
        path.join(ws.dir, "requests.json"),
        JSON.stringify({ log: model.script.log, errors: model.script.errors }, null, 2) + "\n",
      )
    },
  }
}

// Poll every 200 ms until `probe` returns a value. Fails when the time limit expires, or when the status file is
// still absent 30 s after `/task`.
async function until<T>(
  c: Ctx,
  what: string,
  ms: number,
  probe: (s: Status.Status | undefined) => T | undefined | Promise<T | undefined>,
  options: { from?: number; detail?: () => string } = {},
): Promise<T> {
  const deadline = (options.from ?? Date.now()) + ms
  for (;;) {
    apparatus(c)
    // A status of another path (from `/task trust` or a killed run) reads as none; see Adapter.reading().
    const reading = c.arm.reading()
    const s = "status" in reading ? reading.status : undefined
    const value = await probe(s)
    if (value !== undefined) return value
    const started = c.arm.startedAt
    if ("problem" in reading && started !== undefined && Date.now() - started > STATUS_APPEARS_MS)
      throw new Error(
        `${what}: ${reading.problem}, ${STATUS_APPEARS_MS / 1000} s after /task${reading.absent ? "; the arm exposes no task state" : ""}`,
      )
    if (Date.now() > deadline)
      throw new Error(
        `${what}: not reached within ${Math.round(ms / 1000)} s; ${"problem" in reading ? reading.problem : Status.summary(s)}${options.detail ? `; ${options.detail()}` : ""}`,
      )
    await Bun.sleep(POLL_MS)
  }
}

// Stop waiting as soon as the run ends in a state the check does not expect.
function ended(s: Status.Status | undefined, expected: Status.RunState[] = []) {
  if (s && ENDED.includes(s.run.state) && !expected.includes(s.run.state))
    throw new Error(`the run ended in ${s.run.state}${s.run.reason ? ` (${s.run.reason})` : ""}; ${Status.summary(s)}`)
}

// A script exception is an apparatus bug, not the arm's failure: it fails the check ahead of any assertion.
function apparatus(c: Ctx) {
  if (c.script.errors.length > 0) throw new Error(`apparatus error in the scripted model: ${c.script.errors.join("; ")}`)
}

function verify(problems: string[], c?: Ctx) {
  if (c) apparatus(c)
  if (problems.length > 0) throw new Error(problems.join("\n"))
}

async function noRequests(c: Ctx, when: string) {
  apparatus(c)
  const hits = await c.model.hits()
  if (hits.length > 0)
    throw new Error(`the scripted model received ${hits.length} request(s) ${when}; no model request is allowed`)
}

const builders = (c: Ctx, unit: string) => c.script.seen.filter((r) => r.role === "builder" && r.unit === unit)
const verifiers = (c: Ctx, unit: string) =>
  c.script.seen.filter((r) => r.role === "verifier" && !r.scenario && r.unit === unit)
const attemptMessage = (c: Ctx, unit: string, attempt: number) => builders(c, unit).find((r) => r.attempt === attempt)
const logged = (c: Ctx, unit: string, attempt: number, action: string) =>
  c.script.log.find((e) => e.role === "builder" && e.unit === unit && e.attempt === attempt && e.action === action)
const history = (s: Status.Status, unit: string, to?: string) =>
  s.history.filter((h) => h.unit === unit && (to === undefined || h.to === to))

function state(s: Status.Status | undefined, id: string) {
  return s?.tasks[id]?.state
}

// H3's end state, also the end state of H8.
function happyEnd(c: Ctx, s: Status.Status) {
  const problems: string[] = []
  if (s.run.state !== "done") problems.push(`run.state is ${s.run.state}, expected done`)
  for (const id of ["T1", ...LEAVES])
    if (state(s, id) !== "trusted") problems.push(`${id} is ${state(s, id) ?? "absent"}, expected trusted`)
  const untrusted = allObligations.filter((id) => s.obligations[id]?.state !== "trusted")
  if (untrusted.length > 0)
    problems.push(`obligations not trusted: ${untrusted.map((id) => `${id}=${s.obligations[id]?.state ?? "absent"}`).join(", ")}`)
  for (const id of LOCAL_SCENARIOS)
    if (s.scenarios[id]?.state !== "trusted") problems.push(`${id} is ${s.scenarios[id]?.state ?? "absent"}, expected trusted`)
  const s13 = s.scenarios["S13"]
  if (s13?.state !== "waiting" || !s13.waitingOn.includes("T8"))
    problems.push(`S13 is ${s13?.state ?? "absent"} waiting on [${s13?.waitingOn.join(", ") ?? ""}], expected waiting on T8`)
  for (const file of solutionSrc())
    if (gitShow(c.ws.repo, `${Workspace.BASE_BRANCH}:src/${file}`) !== Workspace.solutionFile(`src/${file}`))
      problems.push(`${Workspace.BASE_BRANCH}:src/${file} is not the solution's src/${file}`)
  for (const id of LEAVES)
    if (s.tasks[id]?.attempts !== 1) problems.push(`${id} has attempts ${s.tasks[id]?.attempts}, expected 1`)
  if ((s.tasks["T1"]?.attempts ?? 0) > 1) problems.push(`T1 has attempts ${s.tasks["T1"]?.attempts}, expected at most 1`)
  return problems
}

// --- H1–H16 ---------------------------------------------------------------------------------------------------------------

const CYCLE_SPEC = "task-formats/blend/release-notes-cycle.spec"

check("H1", "refuse before the model", 30_000 + SETUP_MS, async () => {
  await using c = await open("H1", (repo) => {
    fs.cpSync(path.join(repo, SPEC), path.join(repo, CYCLE_SPEC), { recursive: true })
    const task = path.join(repo, CYCLE_SPEC, "T1-release-notes.task/T1.1-commit-parser.task/TASK.md")
    const text = fs.readFileSync(task, "utf8")
    if (!text.startsWith("---\n")) throw new Error("T1.1's TASK.md has no front matter")
    fs.writeFileSync(task, text.replace(/^---\n/, "---\nafter: [T1.3]\n"))
    Workspace.git(repo, "add", CYCLE_SPEC)
    Workspace.git(repo, "commit", "-q", "-m", "release-notes copy with the cycle T1.1 -> T1.3 -> T1.1")
  })
  await c.arm.start(CYCLE_SPEC)
  const s = await until(c, "run refused", 30_000, async (s) => {
    await noRequests(c, "before the refusal")
    return s?.run.state === "refused" ? s : undefined
  })
  if (!s.run.reason?.includes("R7")) throw new Error(`the refusal reason "${s.run.reason ?? ""}" does not name R7`)
  await Bun.sleep(1_000)
  await noRequests(c, "by 1 s after the refusal")
})

check("H2", "parse T2", 30_000 + SETUP_MS, async () => {
  await using c = await open("H2")
  const ids = ["T2.1", "T2.2", "T2.3", "T2.4", "T2.5", "T2.6"]
  // Each waits on outside ids or on its waiting T2 siblings, and the six lists name at least one outside id.
  const waits = (s: Status.Status, id: string) => {
    const task = s.tasks[id]
    return task?.state === "waiting" && task.waitingOn.length > 0 && task.waitingOn.every((w) => t2Outside.includes(w) || ids.includes(w))
  }
  const loaded = (s: Status.Status) =>
    ids.every((id) => waits(s, id)) && ids.some((id) => s.tasks[id]?.waitingOn.some((w) => t2Outside.includes(w)))
  await c.arm.start(Workspace.t2Task)
  await until(
    c,
    "T2.1-T2.6 waiting on their outside preconditions",
    30_000,
    async (s) => {
      await noRequests(c, "while loading T2")
      return s && loaded(s) ? s : undefined
    },
    {
      detail: () => {
        const s = c.arm.status()
        return ids.map((id) => `${id}=${s?.tasks[id]?.state ?? "absent"} [${s?.tasks[id]?.waitingOn.join(", ") ?? ""}]`).join(" ")
      },
    },
  )
  await Bun.sleep(1_000)
  await noRequests(c, "by 1 s after T2 loaded")
})

check("H3", "happy path", 600_000 + SETUP_MS, async () => {
  await using c = await open("H3")
  await c.arm.recordOutside("T9")
  await c.arm.start(SPEC)
  const s = await until(c, "run done", 600_000, (s) => {
    ended(s)
    return s?.run.state === "done" ? s : undefined
  })
  verify(happyEnd(c, s), c)
})

check("H4", "order and parallelism", 600_000 + SETUP_MS, async () => {
  await using c = await open("H4")
  await c.arm.start(SPEC)
  const s = await until(c, "T1.1-T1.4 trusted, T1.5 and S13 waiting", 600_000, (s) => {
    ended(s)
    const settled =
      s &&
      ["T1.1", "T1.2", "T1.3", "T1.4"].every((id) => state(s, id) === "trusted") &&
      state(s, "T1.5") === "waiting" &&
      s.scenarios["S13"]?.state === "waiting"
    return settled ? s : undefined
  })
  const problems: string[] = []
  const arrived = ["T1.1", "T1.2"].map((id) => c.script.arrived.get(id))
  const released = ["T1.1", "T1.2"].map((id) => c.script.released.get(id))
  if (arrived.some((at) => at === undefined) || released.some((at) => at === undefined))
    problems.push("the first builder requests of T1.1 and T1.2 did not both arrive")
  else if (Math.max(...arrived.map(Number)) > Math.min(...released.map(Number)))
    problems.push("the first builder requests of T1.1 and T1.2 did not both arrive before either was released")
  // A relative worktree path is relative to the repository, not to this test's working directory.
  const real = (p: string) => {
    const full = path.resolve(c.ws.repo, p)
    return fs.existsSync(full) ? fs.realpathSync(full) : full
  }
  const w1 = s.tasks["T1.1"]?.worktree
  const w2 = s.tasks["T1.2"]?.worktree
  const root = real(c.ws.repo)
  if (!w1 || !w2) problems.push(`T1.1 and T1.2 must each name a worktree (got ${w1 ?? "none"}, ${w2 ?? "none"})`)
  else {
    if (real(w1) === real(w2)) problems.push(`T1.1 and T1.2 share the worktree ${w1}`)
    if (real(w1) === root || real(w2) === root) problems.push("a task's worktree is the repository root")
  }
  const index = (unit: string, to: string) => s.history.findIndex((h) => h.unit === unit && h.to === to)
  const t13 = index("T1.3", "building")
  const t14 = index("T1.4", "building")
  if (t13 < 0 || index("T1.1", "trusted") < 0 || t13 < index("T1.1", "trusted"))
    problems.push("T1.3's first building entry is not after T1.1's trusted entry")
  if (t14 < 0 || index("T1.2", "trusted") < 0 || index("T1.3", "trusted") < 0 || t14 < Math.max(index("T1.2", "trusted"), index("T1.3", "trusted")))
    problems.push("T1.4's first building entry is not after both T1.2's and T1.3's trusted entries")
  if (!s.tasks["T1.5"]?.waitingOn.includes("T9")) problems.push(`T1.5 waits on [${s.tasks["T1.5"]?.waitingOn.join(", ")}], not T9`)
  if (!s.scenarios["S13"]?.waitingOn.includes("T8")) problems.push(`S13 waits on [${s.scenarios["S13"]?.waitingOn.join(", ")}], not T8`)
  verify(problems, c)
})

check("H5", "ready is a request", 180_000 + SETUP_MS, async () => {
  await using c = await open("H5")
  await c.arm.start(T11_DIR)
  const s = await until(c, "T1.1 trusted", 180_000, (s) => {
    ended(s)
    return state(s, "T1.1") === "trusted" ? s : undefined
  })
  const problems: string[] = []
  const second = attemptMessage(c, "T1.1", 2)
  if (!second) problems.push("no attempt-2 builder message arrived")
  else if (!second.reopen.some((r) => r.id === "T1.1.c1")) problems.push("the attempt-2 builder message has no `reopen T1.1.c1` line")
  const ready2 = logged(c, "T1.1", 2, "task_ready")
  if (!ready2) problems.push("no attempt-2 task_ready call was made, so attempt 2's proofs have no start to compare with")
  else {
    const early = verifiers(c, "T1.1").filter((r) => r.at < ready2.at)
    if (early.length > 0) problems.push(`${early.length} verifier request(s) arrived before attempt 2's proofs`)
  }
  if (second) {
    const trusted = s.history.filter((h) => h.unit.startsWith("T1.1.") && h.to === "trusted" && h.at < second.at)
    if (trusted.length > 0) problems.push(`obligations trusted before attempt 2: ${trusted.map((h) => h.unit).join(", ")}`)
  }
  if (s.tasks["T1.1"]?.attempts !== 2) problems.push(`T1.1 has attempts ${s.tasks["T1.1"]?.attempts}, expected 2`)
  verify(problems, c)
})

check("H6", "forced rejection", 180_000 + SETUP_MS, async () => {
  await using c = await open("H6")
  await c.arm.start(T11_DIR)
  const s = await until(c, "T1.1 trusted", 180_000, (s) => {
    ended(s)
    return state(s, "T1.1") === "trusted" ? s : undefined
  })
  const problems: string[] = []
  const second = attemptMessage(c, "T1.1", 2)
  if (!second) problems.push("no attempt-2 builder message arrived")
  else {
    const reopened = second.reopen.find((r) => r.id === "T1.1.c3")
    if (!reopened) problems.push("the attempt-2 builder message has no `reopen T1.1.c3` line")
    else if (!reopened.reason.includes(Scripts.REJECT_REASON))
      problems.push(`the reopen reason "${reopened.reason}" does not carry the verifier's reason`)
    const round2 = verifiers(c, "T1.1").find((r) => r.step === 0 && r.at > second.at)
    if (!round2) problems.push("no second verifier round arrived after attempt 2")
    else {
      if (!round2.judges.includes("T1.1.c3")) problems.push("the second verifier round does not judge T1.1.c3")
      const trusted = new Set(s.history.filter((h) => h.to === "trusted" && h.at < round2.at).map((h) => h.unit))
      const again = round2.judges.filter((id) => id !== "T1.1.c3" && trusted.has(id))
      if (again.length > 0) problems.push(`the second verifier round judges already trusted ids: ${again.join(", ")}`)
    }
  }
  for (const id of ["T1.1.c1", "T1.1.c2", "T1.1.c4", "T1.1.c5"]) {
    const bad = s.history.filter((h) => h.unit === id && (h.to === "rejected" || h.to === "stale"))
    if (bad.length > 0) problems.push(`${id} went ${bad.map((h) => h.to).join(", ")}`)
  }
  if (s.tasks["T1.1"]?.attempts !== 2) problems.push(`T1.1 has attempts ${s.tasks["T1.1"]?.attempts}, expected 2`)
  verify(problems, c)
})

check("H7", "budget", 240_000 + SETUP_MS, async () => {
  await using c = await open("H7")
  await c.arm.start(T11_DIR)
  const s = await until(c, "T1.1 and the run budget_exhausted", 240_000, (s) => {
    ended(s, ["budget_exhausted"])
    if (state(s, "T1.1") === "trusted") throw new Error("T1.1 became trusted although every attempt fails [T1.1.c1]")
    return state(s, "T1.1") === "budget_exhausted" && s?.run.state === "budget_exhausted" ? s : undefined
  })
  await Bun.sleep(1_000)
  const problems: string[] = []
  if (s.tasks["T1.1"]?.attempts !== taskAttempts)
    problems.push(`T1.1 has attempts ${s.tasks["T1.1"]?.attempts}, expected ${taskAttempts} (taskAttempts)`)
  const beyond = builders(c, "T1.1").filter((r) => r.attempt > taskAttempts)
  if (beyond.length > 0) problems.push(`a builder attempt ${beyond[0]?.attempt} message exists`)
  verify(problems, c)
})

check("H8", "crash and resume", 1_200_000 + SETUP_MS, async () => {
  await using c = await open("H8")
  await c.arm.recordOutside("T9")
  await c.arm.start(SPEC)
  const first = await until(c, "T1.3's first builder request", 600_000, (s) => {
    ended(s)
    return builders(c, "T1.3")[0]
  })
  // Kill only once T1.1 and T1.2 are trusted, so the restart cannot catch them mid-flight; T1.3's `sleep 30` still runs.
  await until(
    c,
    "T1.1 and T1.2 trusted within 25 s of T1.3's first builder request",
    25_000,
    (s) => {
      if (state(s, "T1.1") === "trusted" && state(s, "T1.2") === "trusted") return s
      ended(s)
      return undefined
    },
    { from: first.at },
  )
  // At least 1 s after the request, as before, so the bash call has started when the server dies.
  await Bun.sleep(Math.max(0, first.at + 1_000 - Date.now()))
  c.arm.kill()
  const restartAt = Date.now()
  await c.arm.restart()
  const next = await until(c, "T1.3's next builder request after the restart", 600_000, (s) => {
    const found = builders(c, "T1.3").find((r) => r.at > restartAt)
    if (!found) ended(s)
    return found
  })
  const s = await until(
    c,
    "run done after the restart",
    600_000,
    (s) => {
      ended(s)
      return s?.run.state === "done" ? s : undefined
    },
    { from: restartAt },
  )
  const problems: string[] = []
  const result = Scripts.resultOf(next.messages, (call) => call.name === "bash" && call.args.includes("sleep 30"))
  if (!result) problems.push("T1.3's next builder request carries no tool result for the `sleep 30` bash call")
  else if (!Scripts.ERROR_TEXT.test(result.text))
    problems.push(`the tool result for the dangling bash call is not an error: "${result.text.slice(0, 200)}"`)
  const after = c.script.seen.filter(
    (r) => r.at > restartAt && !r.scenario && (r.unit === "T1.1" || r.unit === "T1.2") && (r.role === "builder" || r.role === "verifier"),
  )
  if (after.length > 0) problems.push(`${after.length} builder or verifier request(s) for T1.1 or T1.2 arrived after the restart`)
  problems.push(...happyEnd(c, s))
  verify(problems, c)
})

const EDIT = "The edited text of H9. "

// Idempotent: a retry after the base branch already moved does not edit twice.
function editC2(text: string) {
  if (text.includes(EDIT)) return text
  const next = text.replace(/(\n {2}c2:\n(?: {4}.*\n)*? {4}text: ")/, `$1${EDIT}`)
  if (next === text) throw new Error("cannot find the text of c2 in T1.1's VERIFY.md")
  return next
}

// Commit an edit of one file on top of the base branch, whatever the harness does with the root checkout: the commit
// is built from the branch's tree with a private index, and the branch moves only if nobody moved it meanwhile. When
// the root checkout is on the branch, its index entry and working file follow, as a plain commit there would leave
// them.
function commitOnBase(dir: string, repo: string, file: string, edit: (text: string) => string, message: string) {
  const ref = `refs/heads/${Workspace.BASE_BRANCH}`
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "conformance",
    GIT_AUTHOR_EMAIL: "conformance@eque2.test",
    GIT_COMMITTER_NAME: "conformance",
    GIT_COMMITTER_EMAIL: "conformance@eque2.test",
  }
  const git = (args: string[], extra: Record<string, string> = {}) => {
    const out = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...env, ...extra } })
    if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`)
    return out.stdout.toString().trim()
  }
  const parent = git(["rev-parse", ref])
  const before = gitShow(repo, `${parent}:${file}`)
  if (before === undefined) throw new Error(`${Workspace.BASE_BRANCH} has no ${file}`)
  const after = edit(before)
  const content = path.join(dir, "edit.blob")
  const index = path.join(dir, "edit.index")
  fs.writeFileSync(content, after)
  fs.rmSync(index, { force: true })
  const blob = git(["hash-object", "-w", content])
  git(["read-tree", parent], { GIT_INDEX_FILE: index })
  git(["update-index", "--cacheinfo", `100644,${blob},${file}`], { GIT_INDEX_FILE: index })
  const tree = git(["write-tree"], { GIT_INDEX_FILE: index })
  if (after !== before) git(["update-ref", ref, git(["commit-tree", tree, "-p", parent, "-m", message]), parent])
  const head = Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: repo }).stdout.toString().trim()
  if (head === ref) {
    fs.writeFileSync(path.join(repo, file), after)
    git(["update-index", "--cacheinfo", `100644,${blob},${file}`])
  }
}

check("H9", "stale on edit", 600_000 + SETUP_MS, async () => {
  await using c = await open("H9")
  const startAt = Date.now()
  await c.arm.recordOutside("T9")
  await c.arm.start(SPEC)
  await until(
    c,
    "T1.1 trusted",
    600_000,
    (s) => {
      ended(s)
      return state(s, "T1.1") === "trusted" ? s : undefined
    },
    { from: startAt },
  )
  const editAt = Date.now()
  // Retried while the harness itself moves the base branch or holds the index lock.
  for (let tries = 0; ; tries++) {
    try {
      commitOnBase(c.ws.dir, c.ws.repo, T11_VERIFY, editC2, "H9: edit the text of T1.1.c2")
      break
    } catch (error) {
      if (tries >= 20) throw error
      await Bun.sleep(250)
    }
  }
  const cycled = (s: Status.Status) => {
    const stale = s.history.findIndex((h) => h.unit === "T1.1.c2" && h.to === "stale" && h.at >= editAt)
    return stale >= 0 && s.history.slice(stale + 1).some((h) => h.unit === "T1.1.c2" && h.to === "trusted")
  }
  const s = await until(
    c,
    "T1.1.c2 stale then trusted again, and the run done",
    600_000,
    (s) => {
      ended(s)
      return s && s.run.state === "done" && cycled(s) ? s : undefined
    },
    { from: startAt },
  )
  const problems: string[] = []
  if (!verifiers(c, "T1.1").some((r) => r.step === 0 && r.at > editAt && r.judges.includes("T1.1.c2")))
    problems.push("no new verifier round judged T1.1.c2 after the edit")
  for (const id of ["T1.1.c1", "T1.1.c3", "T1.1.c4", "T1.1.c5"])
    if (history(s, id, "stale").length > 0) problems.push(`${id} went stale`)
  verify(problems, c)
})

check("H10", "builder cannot judge", 180_000 + SETUP_MS, async () => {
  await using c = await open("H10")
  await c.arm.start(T11_DIR)
  const s = await until(c, "T1.1 trusted", 180_000, (s) => {
    ended(s)
    return state(s, "T1.1") === "trusted" ? s : undefined
  })
  const problems: string[] = []
  const withVerdict = builders(c, "T1.1").filter((r) => r.tools.includes("verdict"))
  if (withVerdict.length > 0) problems.push(`${withVerdict.length} builder request(s) list the verdict tool`)
  const withReady = verifiers(c, "T1.1").filter((r) => r.tools.includes("task_ready"))
  if (withReady.length > 0) problems.push(`${withReady.length} verifier request(s) list the task_ready tool`)
  const isVerdictCall = (call: Scripts.Call) => call.name === "verdict" || (call.name === "invalid" && call.args.includes("verdict"))
  const result = builders(c, "T1.1")
    .map((r) => Scripts.resultOf(r.messages, isVerdictCall))
    .find((x) => x !== undefined)
  if (!result) problems.push("no builder request carries a tool result for the builder's verdict call")
  else if (!Scripts.ERROR_TEXT.test(result.text))
    problems.push(`the tool result for the builder's verdict call is not an error: "${result.text.slice(0, 200)}"`)
  const firstVerifier = verifiers(c, "T1.1")[0]
  const c1 = history(s, "T1.1.c1", "trusted")[0]
  if (c1 && (!firstVerifier || c1.at < firstVerifier.at)) problems.push("T1.1.c1 was trusted before a verifier round")
  verify(problems, c)
})

check("H11", "test tampering", 180_000 + SETUP_MS, async () => {
  await using c = await open("H11")
  const startAt = Date.now()
  await c.arm.start(T11_DIR)
  // Back in building for attempt 2: a T1.1 `building` entry that follows a `proving` entry, with attempts at 2.
  const back = (s: Status.Status) => {
    const proving = s.history.findIndex((h) => h.unit === "T1.1" && h.to === "proving")
    const index = proving < 0 ? -1 : s.history.findIndex((h, i) => i > proving && h.unit === "T1.1" && h.to === "building")
    return index >= 0 && (s.tasks["T1.1"]?.attempts ?? 0) >= 2 ? s.history[index] : undefined
  }
  const s = await until(
    c,
    "T1.1 back in building for attempt 2",
    180_000,
    (s) => {
      ended(s)
      return s && back(s) ? s : undefined
    },
    { from: startAt },
  )
  const entry = back(s)
  const named = (text: string | undefined) => text?.includes(Scripts.TAMPER_FILE) ?? false
  const inStatus = named(s.tasks["T1.1"]?.reason) || history(s, "T1.1").some((h) => named(h.reason))
  const problems: string[] = []
  if (!inStatus) {
    const second = await until(c, "the attempt-2 builder message", 30_000, () => attemptMessage(c, "T1.1", 2)).catch(
      () => undefined,
    )
    if (!second?.reopen.some((r) => named(r.reason)))
      problems.push(`neither a reopen reason nor the task reason names ${Scripts.TAMPER_FILE}`)
  }
  const trusted = s.history.filter((h) => h.unit.startsWith("T1.1.") && h.to === "trusted" && entry && h.at <= entry.at)
  if (trusted.length > 0) problems.push(`obligations trusted in attempt 1: ${trusted.map((h) => h.unit).join(", ")}`)
  // Attempt 2 removes the file and writes only its own files, so T1.1 ends trusted.
  const end = await until(
    c,
    "T1.1 trusted after attempt 2",
    180_000,
    (s) => {
      ended(s)
      return state(s, "T1.1") === "trusted" ? s : undefined
    },
    { from: startAt },
  ).catch((error: unknown) => {
    problems.push(error instanceof Error ? error.message : String(error))
    return undefined
  })
  if (end && end.tasks["T1.1"]?.attempts !== 2) problems.push(`T1.1 has attempts ${end.tasks["T1.1"]?.attempts}, expected 2`)
  verify(problems, c)
})

check("H12", "stream stall", 180_000 + SETUP_MS, async () => {
  await using c = await open("H12")
  const startAt = Date.now()
  await c.arm.start(T11_DIR)
  const hung = await until(
    c,
    "the hung builder request",
    180_000,
    (s) => {
      ended(s)
      return c.script.log.find((e) => e.unit === "T1.1" && e.action === "hang")
    },
    { from: startAt },
  )
  await until(
    c,
    "a new T1.1 builder request or a stall entry in history",
    10_000,
    (s) => {
      const again = builders(c, "T1.1").some((r) => r.at > hung.at)
      const named = s ? history(s, "T1.1").some((h) => /stall|idle/i.test(h.reason ?? "")) : false
      if (again || named) return true
      ended(s)
      return undefined
    },
    { from: hung.at },
  )
  const s = await until(
    c,
    "T1.1 trusted",
    180_000,
    (s) => {
      ended(s)
      return state(s, "T1.1") === "trusted" ? s : undefined
    },
    { from: startAt },
  )
  apparatus(c)
  if (s.tasks["T1.1"]?.attempts !== 1) throw new Error(`T1.1 has attempts ${s.tasks["T1.1"]?.attempts}, expected 1`)
})

check("H13", "hung proof", 180_000 + SETUP_MS, async () => {
  await using c = await open("H13")
  let atReopen: number[] | undefined
  c.script.observe((r) => {
    if (atReopen === undefined && r.role === "builder" && r.unit === "T1.1" && r.attempt === 2)
      atReopen = Arms.pgrep(`sleep 999.${c.marker}`)
  })
  await c.arm.start(T11_DIR)
  await until(c, "T1.1 trusted", 180_000, (s) => {
    ended(s)
    return state(s, "T1.1") === "trusted" ? s : undefined
  })
  const problems: string[] = []
  const second = attemptMessage(c, "T1.1", 2)
  const reopened = second?.reopen.find((r) => r.id === "T1.1.c1")
  if (!second) problems.push("no attempt-2 builder message arrived")
  else if (!reopened) problems.push("the attempt-2 builder message has no `reopen T1.1.c1` line")
  else if (!/timed out/i.test(reopened.reason)) problems.push(`the reopen reason "${reopened.reason}" does not say "timed out"`)
  if (atReopen && atReopen.length > 0) problems.push(`sleep 999.${c.marker} was still running at the reopen (${atReopen.join(", ")})`)
  const ready1 = logged(c, "T1.1", 1, "task_ready")
  if (!ready1) problems.push("no attempt-1 task_ready call was made, so the time to the reopen has no start")
  if (second && ready1 && second.at - ready1.at >= 30_000)
    problems.push(`the reopen came ${Math.round((second.at - ready1.at) / 1000)} s after task_ready, not under 30 s`)
  verify(problems, c)
})

check("H14", "provider errors", 2 * (180_000 + SETUP_MS), async () => {
  {
    await using c = await open("H14a")
    await c.arm.start(T11_DIR)
    const s = await until(c, "(a) T1.1 trusted after a 529", 180_000, (s) => {
      ended(s)
      return state(s, "T1.1") === "trusted" ? s : undefined
    })
    apparatus(c)
    if (s.tasks["T1.1"]?.attempts !== 1) throw new Error(`(a) T1.1 has attempts ${s.tasks["T1.1"]?.attempts}, expected 1`)
  }
  {
    await using c = await open("H14b")
    await c.arm.start(T11_DIR)
    const first = await until(c, "(b) the first T1.1 builder request", 60_000, (s) => {
      ended(s, ["needs_human"])
      return builders(c, "T1.1")[0]
    })
    await until(
      c,
      "(b) T1.1 and the run needs_human after a spend-cap 429",
      15_000,
      (s) => (state(s, "T1.1") === "needs_human" && s?.run.state === "needs_human" ? s : undefined),
      { from: first.at },
    )
    await Bun.sleep(1_000)
    apparatus(c)
    const count = builders(c, "T1.1").length
    if (count > 2) throw new Error(`(b) the scripted model received ${count} builder requests, at most 2 allowed`)
  }
})

check("H15", "repetition", 180_000 + SETUP_MS, async () => {
  await using c = await open("H15")
  const startAt = Date.now()
  await c.arm.start(T11_DIR)
  const third = await until(
    c,
    "the 3rd identical read call",
    180_000,
    (s) => {
      ended(s)
      return c.script.log.find((e) => e.unit === "T1.1" && e.attempt === 1 && e.step === 2 && e.action === "read package.json")
    },
    { from: startAt },
  )
  await until(
    c,
    "a T1.1 history entry naming the repetition",
    10_000,
    (s) => {
      if (s && history(s, "T1.1").some((h) => /repet/i.test(h.reason ?? ""))) return true
      ended(s)
      return undefined
    },
    { from: third.at },
  )
  await Bun.sleep(Math.max(0, third.at + 10_000 - Date.now()))
  apparatus(c)
  const fourth = builders(c, "T1.1").filter((r) => r.attempt === 1 && r.step >= 3 && r.continues)
  if (fourth.length > 0) throw new Error("the builder turn went on after the 3rd identical read call")
  const named: Status.TaskState[] = ["trusted", "stalled", "needs_human", "budget_exhausted", "failed", "cancelled"]
  await until(
    c,
    "T1.1 trusted or in a named state",
    180_000,
    (s) => {
      const now = state(s, "T1.1")
      if (now && named.includes(now)) return s
      ended(s)
      return undefined
    },
    { from: startAt },
  )
})

check("H16", "cancel", 180_000 + SETUP_MS, async () => {
  await using c = await open("H16")
  await c.arm.start(SPEC)
  await until(c, "both bash sleeps in flight", 180_000, (s) => {
    ended(s)
    return Arms.pgrep(`sleep 999.${c.marker}1`).length > 0 && Arms.pgrep(`sleep 999.${c.marker}2`).length > 0 ? true : undefined
  })
  const abortAt = Date.now()
  await c.arm.abort()
  const cancelled = (s: Status.Status | undefined) =>
    state(s, "T1.1") === "cancelled" && state(s, "T1.2") === "cancelled" && s?.run.state === "cancelled"
  await until(
    c,
    "T1.1, T1.2 and the run cancelled with no sleep left",
    2_000,
    (s) => {
      if (cancelled(s) && Arms.pgrep(`sleep 999.${c.marker}`).length === 0) return true
      ended(s, ["cancelled"])
      return undefined
    },
    { from: abortAt, detail: () => `sleep processes: ${Arms.pgrep(`sleep 999.${c.marker}`).length}` },
  )
  await Bun.sleep(Math.max(0, abortAt + 2_000 - Date.now()))
  apparatus(c)
  const late = c.script.seen.filter((r) => r.role === "builder" && r.at > abortAt)
  if (late.length > 0) throw new Error(`${late.length} builder request(s) arrived after the abort`)
})

// --- L1 ------------------------------------------------------------------------------------------------------------------

check(
  "L1",
  "live",
  LIVE_WALL_MS + 15 * 60_000,
  async () => {
    const ws = Workspace.create(runDir, "L1")
    const forwarded = Object.fromEntries(
      LIVE_KEYS.flatMap((name) => {
        const value = process.env[`TASK_HARNESS_LIVE_${name}`]
        return value ? [[name, value]] : []
      }),
    )
    const model = process.env.TASK_HARNESS_LIVE_MODEL || "openai/gpt-5.6-terra"
    const adapter = await Arms.open({
      arm,
      workspace: ws,
      model: { kind: "live", model },
      env: { ...Arms.liveCatalog(ws.home), ...forwarded },
    })
    const startAt = Date.now()
    const out: Record<string, unknown> = { arm, model }
    try {
      await adapter.recordOutside("T9")
      await adapter.start(SPEC)
      let s: Status.Status | undefined
      let tokens: Arms.Tokens = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      let tokensAt = 0
      // The cap needs a working count: 3 failed counts in a row are a breach.
      let tokenFailures = 0
      let breach: string | undefined
      let idleSince: number | undefined
      let idle = false
      for (;;) {
        s = adapter.status()
        if (s && (LIVE_ENDS.includes(s.run.state) || ENDED.includes(s.run.state))) break
        // A run `waiting` with no task in progress cannot move by itself: after 60 s it counts as ended.
        const busy = s ? Object.values(s.tasks).some((t) => ["building", "proving", "verifying"].includes(t.state)) : true
        idleSince = s?.run.state === "waiting" && !busy ? (idleSince ?? Date.now()) : undefined
        if (idleSince !== undefined && Date.now() - idleSince > LIVE_IDLE_MS) {
          idle = true
          break
        }
        if (!s && Date.now() - (adapter.startedAt ?? startAt) > STATUS_APPEARS_MS)
          throw new Error(`no status file at ${Status.file(ws.repo)} ${STATUS_APPEARS_MS / 1000} s after /task`)
        if (Date.now() - tokensAt > 10_000) {
          tokensAt = Date.now()
          try {
            tokens = await adapter.tokens()
            tokenFailures = 0
          } catch (error) {
            tokenFailures++
            if (tokenFailures >= 3)
              breach = `the token count failed ${tokenFailures} times in a row: ${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (tokens.total > LIVE_TOKENS) breach = `tokens ${tokens.total} > ${LIVE_TOKENS}`
        if (Date.now() - startAt > LIVE_WALL_MS) breach = `wall clock over ${LIVE_WALL_MS / 60_000} min`
        if (breach) {
          await adapter.abort()
          break
        }
        await Bun.sleep(POLL_MS)
      }
      out.wallClockMs = Date.now() - startAt
      out.tokens = await adapter.tokens().catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        last: tokens,
      }))
      out.state = s?.run.state
      out.reason = s?.run.reason
      out.breach = breach
      out.idle = idle
      const problems: string[] = []
      if (breach) problems.push(`cap breached: ${breach}`)
      // The loop samples tokens every 10 s, so a run can end just past the cap between samples: "within the live cap"
      // is judged on the final count and the final wall clock as well.
      const finalTokens = record(out.tokens).total
      const finalWall = Date.now() - startAt
      if (!breach && typeof finalTokens === "number" && finalTokens > LIVE_TOKENS)
        problems.push(`cap breached: tokens ${finalTokens} > ${LIVE_TOKENS} at the end of the run`)
      if (!breach && finalWall > LIVE_WALL_MS)
        problems.push(`cap breached: wall clock ${Math.round(finalWall / 1000)} s > ${LIVE_WALL_MS / 1000} s`)
      if (!s || !LIVE_ENDS.includes(s.run.state))
        problems.push(
          `the run did not end by itself in a terminal state${idle ? `; it stayed waiting with no task in progress for ${LIVE_IDLE_MS / 1000} s` : ""} (${Status.summary(s)})`,
        )
      if (s) {
        for (const [task, ids] of obligations)
          if (state(s, task) === "trusted") {
            const open = ids.filter((id) => s?.obligations[id]?.state !== "trusted")
            if (open.length > 0) problems.push(`${task} is trusted but ${open.join(", ")} are not`)
          }
        if (s.run.state === "done") {
          const gates = await runGates(ws)
          out.gates = gates
          for (const [id, gate] of Object.entries(gates))
            if (gate.timedOut)
              problems.push(`gate ${id} did not finish within ${GATE_MS / 1000} s on ${Workspace.BASE_BRANCH}`)
            else if (gate.code !== 0) problems.push(`gate ${id} exits ${gate.code} on ${Workspace.BASE_BRANCH}`)
        }
      }
      verify(problems)
    } finally {
      out.wallClockMs ??= Date.now() - startAt
      fs.writeFileSync(path.join(ws.dir, "l1.json"), JSON.stringify(out, null, 2) + "\n")
      await adapter.close()
      Arms.sweep([ws.dir])
    }
  },
  !live,
)

// The four gates of SPEC.md, run by the test on a fresh clone of the base branch, each bounded at 300 s. Each gate
// runs in its own process group, so the bound also stops what it started.
const GATE_IDS = ["BUILD-1", "BUILD-2", "BUILD-3", "BUILD-4"]
const GATE_MS = 300_000

async function runGates(ws: Workspace.Workspace): Promise<Record<string, { code: number | null; timedOut: boolean }>> {
  const gates = record(specFront.gates)
  const commands = GATE_IDS.map((id) => {
    const value = record(gates[id]).command
    if (typeof value !== "string" || value.trim() === "") throw new Error(`SPEC.md has no command for gate ${id}`)
    return [id, value] as const
  })
  const dir = path.join(ws.dir, "gates")
  fs.rmSync(dir, { recursive: true, force: true })
  Workspace.git(ws.dir, "clone", "-q", "--branch", Workspace.BASE_BRANCH, ws.repo, dir)
  const out: Record<string, { code: number | null; timedOut: boolean }> = {}
  out.install = await bounded(["bun", "install", "--frozen-lockfile"], dir, path.join(ws.dir, "gate-install.log"))
  if (out.install.code !== 0 || out.install.timedOut) return out
  for (const [id, command] of commands) out[id] = await bounded(["sh", "-c", command], dir, path.join(ws.dir, `gate-${id}.log`))
  return out
}

async function bounded(cmd: string[], cwd: string, log: string) {
  const proc = Bun.spawn(cmd, { cwd, detached: true, stdout: Bun.file(log), stderr: Bun.file(`${log}.stderr`) })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    Server.kill(proc.pid, "SIGKILL")
  }, GATE_MS)
  const code = await proc.exited
  clearTimeout(timer)
  return { code: timedOut ? null : code, timedOut }
}

// The scripted model of the conformance suite (harness contract, sections 4, 5 and 8): one TestLLMServer per check.
//
// Every reply is computed from the request alone: the role and unit from the protocol marker in the conversation,
// the attempt from the latest `task-harness attempt=` line, the step from the number of tool results after that
// line. Concurrency, provider retries and server restarts therefore cannot desynchronise the script. Only the
// behaviours the contract defines as "the first request" (H4 hold, H12 hang, H14a 529) keep a one-shot flag per
// unit, because a retried request is byte-for-byte the first one again.
import { Effect, ManagedRuntime } from "effect"
import { httpError, reply, TestLLMServer, type Hit, type Item, type Reply } from "../lib/llm-server"
import { solutionFile, solutionTasks } from "./arms/workspace"

export type Role = "builder" | "verifier" | "reviewer"
export type Call = { readonly id: string; readonly name: string; readonly args: string }
export type Message = { readonly role: string; readonly text: string; readonly calls: Call[]; readonly callId?: string }

export type Request = {
  readonly at: number
  readonly title: boolean
  readonly role?: Role
  // A task id (`T1.1`) or, for a scenario judge, a scenario id (`S1`).
  readonly unit?: string
  readonly scenario: boolean
  // The latest `task-harness attempt=<n>`; 1 for a builder message without one, 0 for other roles.
  readonly attempt: number
  // Tool results after the attempt line (or after the marker when there is none).
  readonly step: number
  // The user message that holds the latest attempt line (or the marker).
  readonly message: string
  readonly judges: string[]
  readonly reopen: { readonly id: string; readonly reason: string }[]
  readonly tools: string[]
  readonly messages: Message[]
  // The last message is a tool result: the request continues the same turn.
  readonly continues: boolean
}

export type Entry = {
  readonly at: number
  readonly role?: Role
  readonly unit?: string
  readonly attempt: number
  readonly step: number
  readonly action: string
}

const MARKER = /task-harness role=(builder|verifier|reviewer) (task|scenario)=([A-Za-z0-9._-]+)/
const ATTEMPT = /task-harness attempt=(\d+)/g
// One line per id; a list bullet or text after the id is tolerated.
const JUDGE = /^[ \t]*(?:[-*][ \t]+)?judge[ \t]+([A-Za-z0-9._-]+)/gm
const REOPEN = /^[ \t]*(?:[-*][ \t]+)?reopen[ \t]+([A-Za-z0-9._-]+?):[ \t]*(.*)$/gm

export const REJECT_REASON = "the refs test does not cover Refs #"
// A tool result is an error when its text says so: the OpenAI chat format has no error flag on a tool message.
export const ERROR_TEXT =
  /error|invalid|unavailable|not available|unknown tool|interrupt|abort|cancel|denied|not allowed|forbidden|refused|fail/i

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown) {
  return typeof value === "string" ? value : ""
}

function content(value: unknown): string {
  if (typeof value === "string") return value
  return list(value)
    .map((part) => str(record(part)?.text))
    .join("\n")
}

function message(value: unknown): Message {
  const m = record(value) ?? {}
  const calls = list(m.tool_calls).map((call) => {
    const c = record(call) ?? {}
    const fn = record(c.function) ?? {}
    return { id: str(c.id), name: str(fn.name), args: str(fn.arguments) }
  })
  const callId = str(m.tool_call_id)
  return { role: str(m.role), text: content(m.content), calls, ...(callId ? { callId } : {}) }
}

export function parse(hit: Hit): Request {
  const messages = list(hit.body.messages).map(message)
  const title = JSON.stringify(hit.body).includes("Generate a title for this conversation")
  const users = messages.flatMap((m, index) => (m.role === "user" ? [{ m, index }] : []))
  const marked = users.flatMap(({ m, index }) => {
    const match = MARKER.exec(m.text)
    return match ? [{ index, role: match[1], kind: match[2], unit: match[3] }] : []
  })[0]
  const attempts = users.flatMap(({ m, index }) => {
    const found = [...m.text.matchAll(ATTEMPT)].at(-1)
    return found ? [{ index, attempt: Number(found[1]) }] : []
  })
  const latest = attempts.at(-1)
  const role = marked?.role === "builder" || marked?.role === "verifier" || marked?.role === "reviewer" ? marked.role : undefined
  const from = latest?.index ?? marked?.index ?? -1
  const text = from >= 0 ? (messages[from]?.text ?? "") : ""
  return {
    at: hit.at,
    title,
    role,
    unit: marked?.unit,
    scenario: marked?.kind === "scenario",
    attempt: latest?.attempt ?? (role === "builder" ? 1 : 0),
    step: from >= 0 ? messages.slice(from + 1).filter((m) => m.role === "tool").length : 0,
    message: text,
    judges: [
      ...new Set(
        users
          .filter(({ index }) => index >= (marked?.index ?? 0))
          .flatMap(({ m }) => [...m.text.matchAll(JUDGE)].map((x) => (x[1] ?? "").replace(/\.+$/, ""))),
      ),
    ].filter(Boolean),
    reopen: [...text.matchAll(REOPEN)].map((x) => ({ id: x[1] ?? "", reason: x[2] ?? "" })),
    tools: list(hit.body.tools).map((tool) => str(record(record(tool)?.function)?.name)),
    messages,
    continues: messages.at(-1)?.role === "tool",
  }
}

// The text of the tool result that answered the first call matching `match`, or undefined when none followed it.
export function resultOf(messages: Message[], match: (call: Call) => boolean): { call: Call; text: string } | undefined {
  for (let i = 0; i < messages.length; i++) {
    const call = messages[i]?.calls.find(match)
    if (!call) continue
    for (const next of messages.slice(i + 1)) {
      if (next.role === "assistant") break
      if (next.role === "tool" && next.callId === call.id) return { call, text: next.text }
    }
  }
  return undefined
}

// --- the scripted builders and verifiers ------------------------------------------------------------------------------

type Action = { readonly name: string; readonly input: Record<string, unknown> }

type Leaf = { files: Record<string, string> }
let leaves: Record<string, Leaf> | undefined
function leaf(unit: string): Leaf {
  leaves ??= solutionTasks()
  return leaves[unit] ?? { files: {} }
}

// The solution's commit.ts with the type no longer lower-cased: `[T1.1.c1]` fails (H5, H7).
export function unloweredCommit(text: string) {
  const next = text.replace(/(groups(?:\[["']type["']\]|\.type)!?)\.toLowerCase\(\)/, "$1")
  if (next === text) throw new Error("the solution's src/commit.ts has no `type` lower-casing to remove")
  return next
}

// T1.1's test file with one more `[T1.1.c1]` test that waits on a child process that never ends (H13).
export function hungTest(text: string, marker: string) {
  return [
    'import { test as held } from "bun:test"',
    text,
    'held("[T1.1.c1] the parser waits for a child process", async () => {',
    `  await Bun.spawn(["sleep", "999.${marker}"]).exited`,
    "}, 1_000_000)",
    "",
  ].join("\n")
}

// A passing test that proves another task's obligation, written by T1.1's builder (H11).
export const TAMPER_FILE = "test/verify-release-notes-S3.spec.ts"
const TAMPER = [
  'import { expect, test } from "bun:test"',
  "",
  'test("[T1.2.c1] the bump rule holds", () => {',
  "  expect(1 + 1).toBe(2)",
  "})",
  "",
].join("\n")

function writes(unit: string, edit: (target: string, text: string) => string = (_, text) => text): Action[] {
  return Object.entries(leaf(unit).files).map(([target, source]) => ({
    name: "write",
    input: { filePath: target, content: edit(target, solutionFile(source)) },
  }))
}

function ready(unit: string): Action {
  return { name: "task_ready", input: { summary: `${unit}: the files are written.` } }
}

const isTest = (target: string) => target.startsWith("test/") && /\.(spec|test)\.ts$/.test(target)

export type ScriptOptions = {
  // The check id (`H1`…`H16`, `H14a`, `H14b`); it selects the variant of the happy script.
  readonly check: string
  // Digits only, unique per check run: `sleep 999.<marker>` must stay a valid number.
  readonly marker: string
}

export class Script {
  readonly log: Entry[] = []
  readonly seen: Request[] = []
  readonly errors: string[] = []
  // H4: when the first builder request of T1.1 and T1.2 arrived, and when it was released.
  readonly arrived = new Map<string, number>()
  readonly released = new Map<string, number>()
  private readonly once = new Set<string>()
  private readonly observers: ((request: Request) => void)[] = []
  private closed = false

  constructor(readonly options: ScriptOptions) {}

  observe(fn: (request: Request) => void) {
    this.observers.push(fn)
  }

  close() {
    this.closed = true
  }

  async answer(hit: Hit): Promise<Item | Reply | undefined> {
    const request = parse(hit)
    this.seen.push(request)
    for (const fn of this.observers) fn(request)
    const note = (action: string) =>
      this.log.push({ at: request.at, role: request.role, unit: request.unit, attempt: request.attempt, step: request.step, action })
    try {
      if (!request.role || !request.unit) {
        note("unscripted")
        return undefined
      }
      if (request.role === "builder") return await this.builder(request, note)
      return this.judge(request, note)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.errors.push(text)
      note(`script error: ${text}`)
      return httpError(500, { error: { message: `conformance script error: ${text}` } })
    }
  }

  private first(key: string) {
    if (this.once.has(key)) return false
    this.once.add(key)
    return true
  }

  private async builder(request: Request, note: (action: string) => void): Promise<Item | Reply> {
    const unit = request.unit ?? ""
    const check = this.options.check
    if (unit === "T1.1" && check === "H14b") {
      note("http 429")
      return httpError(429, {
        error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
      })
    }
    if (unit === "T1.1" && check === "H14a" && this.first("529")) {
      note("http 529")
      return httpError(529, { error: { message: "Overloaded" } })
    }
    if (unit === "T1.1" && check === "H12" && this.first("hang")) {
      note("hang")
      return reply().hang()
    }
    if ((unit === "T1.1" || unit === "T1.2") && check === "H4" && this.first(`hold ${unit}`)) {
      this.arrived.set(unit, request.at)
      const deadline = request.at + 20_000
      while (!(this.arrived.has("T1.1") && this.arrived.has("T1.2")) && Date.now() < deadline && !this.closed)
        await Bun.sleep(20)
      this.released.set(unit, Date.now())
    }
    const plan = this.plan(unit, Math.max(1, request.attempt))
    const action = plan[request.step]
    if (!action) {
      note("text")
      return reply().text(`${unit}: done.`).stop()
    }
    note(action.name === "write" || action.name === "read" ? `${action.name} ${str(action.input.filePath)}` : action.name)
    return reply().tool(action.name, action.input)
  }

  // The builder's actions for one attempt: the happy script (write the leaf's files, then `task_ready`) or the
  // check's variant of it.
  plan(unit: string, attempt: number): Action[] {
    const { check, marker } = this.options
    const happy = () => [...writes(unit), ready(unit)]
    const first = attempt === 1
    if (unit === "T1.1" && ((check === "H5" && first) || check === "H7"))
      return [...writes(unit, (target, text) => (target === "src/commit.ts" ? unloweredCommit(text) : text)), ready(unit)]
    if (unit === "T1.3" && check === "H8" && first) return [{ name: "bash", input: { command: "sleep 30" } }, ...happy()]
    if (unit === "T1.1" && check === "H10" && first)
      return [{ name: "verdict", input: { verdicts: [{ id: "T1.1.c1", verdict: "trusted" }] } }, ...happy()]
    if (unit === "T1.1" && check === "H11" && first)
      return [...writes(unit), { name: "write", input: { filePath: TAMPER_FILE, content: TAMPER } }, ready(unit)]
    if (unit === "T1.1" && check === "H13" && first)
      return [...writes(unit, (target, text) => (isTest(target) ? hungTest(text, marker) : text)), ready(unit)]
    if (unit === "T1.1" && check === "H15" && first) {
      const read = { name: "read", input: { filePath: "package.json" } }
      return [read, read, read, ...happy()]
    }
    if ((unit === "T1.1" || unit === "T1.2") && check === "H16" && first)
      return [{ name: "bash", input: { command: `sleep 999.${marker}${unit === "T1.1" ? 1 : 2}` } }, ...happy()]
    return happy()
  }

  // Verifiers, reviewers and scenario judges: one `verdict` call with every judged id, then text.
  private judge(request: Request, note: (action: string) => void): Reply {
    if (request.step > 0) {
      note("text")
      return reply().text("Verdicts recorded.").stop()
    }
    const rejectC3 =
      this.options.check === "H6" &&
      request.role === "verifier" &&
      request.unit === "T1.1" &&
      request.judges.includes("T1.1.c3") &&
      request.judges.some((id) => id !== "T1.1.c3" && id.startsWith("T1.1."))
    const verdicts = request.judges.map((id) =>
      rejectC3 && id === "T1.1.c3" ? { id, verdict: "rejected", reason: REJECT_REASON } : { id, verdict: "trusted" },
    )
    note(rejectC3 ? "verdict (T1.1.c3 rejected)" : "verdict")
    return reply().tool("verdict", { verdicts })
  }
}

// --- the server ----------------------------------------------------------------------------------------------------------

export type ScriptedModel = {
  readonly url: string
  readonly script: Script
  // Every request the model received, title requests included.
  hits(): Promise<Hit[]>
  close(): Promise<void>
}

export async function start(options: ScriptOptions): Promise<ScriptedModel> {
  const runtime = ManagedRuntime.make(TestLLMServer.layer)
  const llm = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* TestLLMServer
    }),
  )
  const script = new Script(options)
  await runtime.runPromise(llm.respond((hit) => script.answer(hit)))
  return {
    url: llm.url,
    script,
    hits: () => runtime.runPromise(llm.hits),
    close: async () => {
      script.close()
      await Promise.race([runtime.dispose(), Bun.sleep(5_000)])
    },
  }
}

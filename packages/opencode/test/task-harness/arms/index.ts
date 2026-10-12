// The arm adapter of the harness contract (section 7) and the per-arm server configuration (section 1).
// An arm passes a check only through what this adapter observes: the status file, the scripted model's requests,
// the target repository's git state and the process table.
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { testProviderConfig } from "../../lib/test-provider"
import * as Server from "./server"
import * as Status from "./status"
import type { Workspace } from "./workspace"

export const ARMS = ["baseline", "o1", "o2", "o3"] as const
export type Arm = (typeof ARMS)[number]

const worktree = path.resolve(import.meta.dir, "../../../../..")
export const pluginEntry = `file://${path.join(worktree, "packages/opencode/src/task/harness-plugin/index.ts")}`

export function parseArm(value: string | undefined): Arm {
  const arm = ARMS.find((item) => item === (value || "baseline"))
  if (!arm) throw new Error(`unknown TASK_HARNESS_ARM ${value}; expected one of ${ARMS.join(", ")}`)
  return arm
}

// The scripted model (every H check) or a live model (L1, e.g. `openai/gpt-5.6-terra`, no provider block).
export type Model = { readonly kind: "scripted"; readonly url: string } | { readonly kind: "live"; readonly model: string }

export function config(arm: Arm, model: Model): Record<string, unknown> {
  const base =
    model.kind === "scripted"
      ? { ...testProviderConfig(model.url), model: "test/test-model" }
      : { formatter: false, lsp: false, model: model.model }
  if (arm === "baseline")
    return {
      ...base,
      command: {
        task: {
          template: "Run the blend task tree at $ARGUMENTS: build each task, prove it and have it verified.",
          description: "Run a blend task tree",
        },
      },
    }
  if (arm === "o3") return { ...base, plugin: [pluginEntry] }
  return base
}

export function env(arm: Arm): Record<string, string> {
  return arm === "baseline" ? {} : { OPENCODE_TASK_HARNESS: arm }
}

export type Tokens = { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export type Adapter = {
  readonly arm: Arm
  readonly repo: string
  // Epoch ms of the latest `/task <path>` (start or restart); undefined before the first.
  readonly startedAt: number | undefined
  readonly server: Server.Server
  start(target: string): Promise<void>
  // The status of the latest `/task <path>`, or why there is none; status() is its status alone.
  reading(): Status.Reading
  status(): Status.Status | undefined
  abort(): Promise<void>
  kill(): void
  restart(): Promise<void>
  recordOutside(id: string): Promise<void>
  tokens(): Promise<Tokens>
  close(): Promise<void>
}

export async function open(input: {
  readonly arm: Arm
  readonly workspace: Workspace
  readonly model: Model
  readonly env?: Record<string, string>
}): Promise<Adapter> {
  const options: Server.ServerOptions = {
    repo: input.workspace.repo,
    home: input.workspace.home,
    config: config(input.arm, input.model),
    // Scripted bounds for the scripted model only; L1 runs with the live bounds (contract section 1).
    env: { ...env(input.arm), OPENCODE_TASK_LIMITS: input.model.kind === "live" ? "live" : "scripted", ...input.env },
  }
  let server = await Server.start(options)
  let client = createOpencodeClient({ baseUrl: server.url, directory: input.workspace.repo })
  let root: string | undefined
  let target: string | undefined
  let startedAt: number | undefined
  // True from kill() until a restart succeeds: the dead server's pid may be reused, so close() must not signal it.
  let killed = false
  const turns: Promise<unknown>[] = []
  const left: Proc[] = []

  const session = async () => {
    const created = await client.session.create({})
    if (!created.data) throw new Error(`session.create failed: ${JSON.stringify(created.error)}`)
    return created.data.id
  }

  const start = async (path: string) => {
    target = path
    root = await session()
    startedAt = Date.now()
    // session.command waits for the whole turn; the run goes on in the background, so never await it here.
    turns.push(client.session.command({ sessionID: root, command: "task", arguments: path }).catch((error: unknown) => error))
  }

  // A status written for another path (left by `/task trust` or by an earlier run) is not this run's status.
  const reading = (): Status.Reading => {
    const read = Status.inspect(input.workspace.repo)
    if (!("status" in read)) return read
    const repo = input.workspace.repo
    // Typed as a string, but written by the arm: check it.
    const own: unknown = read.status.run.path
    const ownPath = typeof own === "string" ? own : undefined
    if (target !== undefined && ownPath !== undefined && path.resolve(repo, ownPath) === path.resolve(repo, target)) return read
    return {
      problem: `the status file at ${Status.file(repo)} is for /task ${ownPath ?? "(no run.path)"}, not ${target ?? "(no /task yet)"}`,
      absent: true,
    }
  }

  return {
    arm: input.arm,
    repo: input.workspace.repo,
    get startedAt() {
      return startedAt
    },
    get server() {
      return server
    },
    start,
    reading,
    status: () => {
      const read = reading()
      return "status" in read ? read.status : undefined
    },
    abort: async () => {
      if (!root) throw new Error("abort before start")
      await client.session.abort({ sessionID: root })
    },
    kill: () => {
      left.push(...tree(server.pid))
      Server.kill(server.pid, "SIGKILL")
      killed = true
    },
    restart: async () => {
      if (!target) throw new Error("restart before start")
      server = await Server.start(options)
      killed = false
      client = createOpencodeClient({ baseUrl: server.url, directory: input.workspace.repo })
      await start(target)
    },
    recordOutside: async (id: string) => {
      const sessionID = await session()
      const turn = client.session.command({ sessionID, command: "task", arguments: `trust ${id}` })
      const result = await Promise.race([turn, Bun.sleep(120_000).then(() => undefined)])
      if (!result) throw new Error(`/task trust ${id} did not return within 120 s`)
      if (result.error) throw new Error(`/task trust ${id} failed: ${JSON.stringify(result.error)}`)
    },
    tokens: async () => {
      const listed = await client.session.list({ scope: "project", limit: 100_000 })
      const out: Tokens = { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      for (const item of listed.data ?? []) {
        const t = item.tokens
        if (!t) continue
        out.input += t.input
        out.output += t.output
        out.reasoning += t.reasoning
        out.cacheRead += t.cache.read
        out.cacheWrite += t.cache.write
      }
      out.total = out.input + out.output + out.reasoning + out.cacheRead + out.cacheWrite
      return out
    },
    close: async () => {
      if (!killed) {
        left.push(...tree(server.pid))
        await Server.stop(server)
      }
      killLeft(left)
      await Promise.race([Promise.allSettled(turns), Bun.sleep(5_000)])
    },
  }
}

// --- process table ---------------------------------------------------------------------------------------------------

export type Proc = { readonly pid: number; readonly started: string }
type Row = Proc & { readonly ppid: number; readonly pgid: number; readonly command: string }

function table(): Row[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,lstart=,command="]).stdout.toString()
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 8)
    .map((cols) => ({
      pid: Number(cols[0]),
      ppid: Number(cols[1]),
      pgid: Number(cols[2]),
      started: cols.slice(3, 8).join(" "),
      command: cols.slice(8).join(" "),
    }))
}

// The server, its process group and every descendant: tool processes run in their own groups and outlive the server.
export function tree(root: number): Proc[] {
  const rows = table()
  const found = new Set<number>([root])
  for (const row of rows) if (row.pgid === root) found.add(row.pid)
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (found.has(row.pid) || !found.has(row.ppid)) continue
      found.add(row.pid)
      grew = true
    }
  }
  return rows.filter((row) => found.has(row.pid)).map((row) => ({ pid: row.pid, started: row.started }))
}

// SIGKILL every recorded process that is still the same process (same pid and start time).
export function killLeft(procs: Proc[]) {
  const live = new Map(table().map((row) => [row.pid, row.started]))
  for (const proc of procs) {
    if (proc.pid === process.pid || live.get(proc.pid) !== proc.started) continue
    try {
      process.kill(proc.pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

// Every process whose command line contains `text` literally (pgrep -f would read it as a regular expression).
export function pgrep(text: string): number[] {
  return commands(Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString(), text)
}

// The pids in `ps -axo pid=,command=` output whose command contains `text`, without this process.
export function commands(table: string, text: string): number[] {
  return table
    .split("\n")
    .map((line) => /^\s*(\d+)\s(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[2].includes(text))
    .map((m) => Number(m[1]))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

// Last line of defence after a check: anything whose command line names the check folder or the check's marker.
export function sweep(patterns: string[]) {
  const table = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString()
  for (const pattern of patterns)
    for (const pid of commands(table, pattern)) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // already gone
      }
    }
}

// L1 only: the isolated cache gets the public model catalog, so the live model resolves without OPENCODE_MODELS_PATH
// pointing at the unit-test catalog. Without a local catalog, opencode fetches the public one.
export function liveCatalog(home: string): Record<string, string> {
  const source = process.env.TASK_HARNESS_MODELS_CATALOG || path.join(os.homedir(), ".cache/opencode/models.json")
  const target = path.join(home, ".cache/opencode/models.json")
  if (!fs.existsSync(source)) return { OPENCODE_MODELS_PATH: "", OPENCODE_DISABLE_MODELS_FETCH: "0" }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return { OPENCODE_MODELS_PATH: target }
}

// The status file of the harness contract (section 3): `<session directory>/.opencode/task/status.json`.
// Every arm that implements the contract rewrites it atomically after each state change; the baseline has none.
import path from "node:path"
import fs from "node:fs"

export type RunState = "running" | "refused" | "waiting" | "done" | "cancelled" | "needs_human" | "budget_exhausted" | "failed"
export type TaskState =
  | "waiting"
  | "building"
  | "proving"
  | "verifying"
  | "trusted"
  | "stalled"
  | "needs_human"
  | "budget_exhausted"
  | "cancelled"
  | "failed"
  | "blocked"
export type ObligationState = "pending" | "passed" | "failed" | "trusted" | "rejected" | "stale"
export type ScenarioState = "waiting" | "pending" | "trusted" | "rejected" | "failed" | "blocked" | "cancelled"

// The AD-13 fields are optional: the checks read the state, reason and history; an arm may write more.
export type Span = { state: string; from: number; to?: number }
export type TaskStatus = {
  state: TaskState
  attempts: number
  waitingOn: string[]
  worktree?: string
  reason?: string
  tags?: string[]
  spans?: Span[]
}
export type HistoryEntry = { at: number; unit: string; from?: string; to: string; reason?: string }

export interface Status {
  run: {
    state: RunState
    reason?: string
    spec: string
    path: string
    tags?: string[]
    title?: string
    specId?: string
    task?: { id: string; title: string }
    warning?: string
    aliveAt?: number
  }
  tasks: Record<string, TaskStatus>
  obligations: Record<string, { state: ObligationState; reason?: string }>
  scenarios: Record<string, { state: ScenarioState; waitingOn: string[]; reason?: string }>
  history: HistoryEntry[] // at = epoch ms
}

export function file(repo: string) {
  return path.join(repo, ".opencode", "task", "status.json")
}

// The status, or why there is none: the file is absent, or it is malformed (not JSON, or not the contract's shape).
export type Reading = { readonly status: Status } | { readonly problem: string; readonly absent: boolean }

export function inspect(repo: string): Reading {
  const where = file(repo)
  const text = (() => {
    try {
      return fs.readFileSync(where, "utf8")
    } catch {
      return undefined
    }
  })()
  if (text === undefined) return { problem: `no status file at ${where}`, absent: true }
  const value: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  if (value === undefined) return { problem: `the status file at ${where} is malformed: not JSON`, absent: false }
  const wrong = shape(value)
  if (wrong || !isStatus(value)) return { problem: `the status file at ${where} is malformed: ${wrong}`, absent: false }
  return { status: value }
}

// Undefined when the file is absent or malformed.
export function read(repo: string): Status | undefined {
  const reading = inspect(repo)
  return "status" in reading ? reading.status : undefined
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// What is wrong with the top-level shape, or undefined when it is the contract's.
function shape(value: unknown): string | undefined {
  if (!isObject(value)) return "not an object"
  if (!isObject(value.run)) return "run is not an object"
  if (typeof value.run.state !== "string") return "run.state is not a string"
  for (const key of ["tasks", "obligations", "scenarios"]) if (!isObject(value[key])) return `${key} is not an object`
  if (!Array.isArray(value.history)) return "history is not an array"
  return undefined
}

function isStatus(value: unknown): value is Status {
  return shape(value) === undefined
}

// One line for failure messages: the run state and every task's state.
export function summary(status: Status | undefined) {
  if (!status) return "no status file"
  const tasks = Object.entries(status.tasks)
    .map(([id, task]) => `${id}=${task.state}/${task.attempts}${task.reason ? ` (${task.reason})` : ""}`)
    .join(" ")
  return `run=${status.run.state}${status.run.reason ? ` (${status.run.reason})` : ""} ${tasks}`
}

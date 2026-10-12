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
export type ObligationState = "pending" | "passed" | "failed" | "trusted" | "rejected" | "stale"
export type ScenarioState = "waiting" | "pending" | "trusted" | "rejected" | "failed"

export type TaskStatus = { state: TaskState; attempts: number; waitingOn: string[]; worktree?: string; reason?: string }
export type HistoryEntry = { at: number; unit: string; from?: string; to: string; reason?: string }

export interface Status {
  harness: "o1" | "o2" | "o3"
  run: { state: RunState; reason?: string; spec: string; path: string }
  tasks: Record<string, TaskStatus>
  obligations: Record<string, { state: ObligationState; reason?: string }>
  scenarios: Record<string, { state: ScenarioState; waitingOn: string[]; reason?: string }>
  history: HistoryEntry[] // at = epoch ms
}

export function file(repo: string) {
  return path.join(repo, ".opencode", "task", "status.json")
}

// Undefined when the file is absent or does not parse as an object with the contract's top-level keys.
export function read(repo: string): Status | undefined {
  const text = (() => {
    try {
      return fs.readFileSync(file(repo), "utf8")
    } catch {
      return undefined
    }
  })()
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isStatus(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isStatus(value: unknown): value is Status {
  if (!value || typeof value !== "object") return false
  const keys = ["run", "tasks", "obligations", "scenarios", "history"]
  return keys.every((key) => key in value) && "history" in value && Array.isArray(value.history)
}

// One line for failure messages: the run state and every task's state.
export function summary(status: Status | undefined) {
  if (!status) return "no status file"
  const tasks = Object.entries(status.tasks)
    .map(([id, task]) => `${id}=${task.state}/${task.attempts}${task.reason ? ` (${task.reason})` : ""}`)
    .join(" ")
  return `run=${status.run.state}${status.run.reason ? ` (${status.run.reason})` : ""} ${tasks}`
}

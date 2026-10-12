import type { Verdict } from "./model"

// The harness's in-session hooks. `SessionPrompt` consults them while a child session runs: it injects the
// harness-only tools by agent name, records what those tools receive here, and asks here whether the builder is
// repeating itself before it sends the next model request. The runner reads the records after the turn ends.
//
// ponytail: process-wide maps keyed by session id. A restart empties them; the runner re-registers the sessions it
// resumes. Upgrade to an instance-scoped service if two servers ever share a process.

export const BUILDER = "task-builder"
export const VERIFIER = "task-verifier"

type Call = { readonly tool: string; readonly input: unknown }

const ready = new Map<string, { readonly summary?: string }>()
const verdicts = new Map<string, ReadonlyArray<Verdict>>()
const repeated = new Map<string, string>()
const limits = new Map<string, number>()

/** Watch a builder session for repeated calls; `limit` identical calls in a row end the turn. */
export function watch(sessionID: string, limit: number) {
  limits.set(sessionID, limit)
  repeated.delete(sessionID)
}

export function unwatch(sessionID: string) {
  limits.delete(sessionID)
}

export function recordReady(sessionID: string, input: { readonly summary?: string }) {
  ready.set(sessionID, input)
}

/** The builder's `task_ready` of the turn that just ended, cleared on read. */
export function takeReady(sessionID: string) {
  const value = ready.get(sessionID)
  ready.delete(sessionID)
  return value
}

export function recordVerdicts(sessionID: string, input: ReadonlyArray<Verdict>) {
  verdicts.set(sessionID, [...(verdicts.get(sessionID) ?? []), ...input])
}

export function takeVerdicts(sessionID: string) {
  const value = verdicts.get(sessionID)
  verdicts.delete(sessionID)
  return value
}

/**
 * Called before each model request of a watched session with the tool calls made since its last user message,
 * oldest first. Returns the reason when the last `limit` calls are one tool with one input, and remembers it.
 */
export function checkRepetition(sessionID: string, calls: ReadonlyArray<Call>): string | undefined {
  const limit = limits.get(sessionID)
  if (limit === undefined || calls.length < limit) return undefined
  const last = calls.slice(-limit)
  const key = (call: Call) => `${call.tool}\u0000${JSON.stringify(call.input)}`
  if (!last.every((call) => key(call) === key(last[0]!))) return undefined
  const reason = `repetition: ${limit} identical ${last[0]!.tool} calls in a row`
  repeated.set(sessionID, reason)
  return reason
}

/** The repetition that ended the builder's turn, cleared on read. */
export function takeRepeated(sessionID: string) {
  const value = repeated.get(sessionID)
  repeated.delete(sessionID)
  return value
}

export * as TaskHooks from "./hooks"

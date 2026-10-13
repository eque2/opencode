import { MutableHashMap, Option, Schema } from "effect"
import { ProofProcess } from "@/task/proof/process"
import type { Verdict } from "./model"

// The harness's in-session hooks. `SessionPrompt` consults them while a child session runs: it injects the
// harness-only tools by agent name, records what those tools receive here, and asks here whether the builder is
// repeating itself before it sends the next model request. The runner reads the records after the turn ends.
//
// ponytail: process-wide maps keyed by session id. A restart empties them; the runner re-registers the sessions it
// resumes. Upgrade to an instance-scoped service if two servers ever share a process.

export const BUILDER = "task-builder"
export const VERIFIER = "task-verifier"

/**
 * The environment of a shell an agent runs. The harness's agents run headless and execute model-written code, so
 * their shell gets the proof allowlist: no provider key or token reaches the model or its tests. Every other agent
 * keeps the environment it is given.
 */
export const shellEnvironment = (
  agent: string,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> =>
  agent === BUILDER || agent === VERIFIER ? ProofProcess.allowedEnvironment(env) : env

type Call = { readonly tool: string; readonly input: unknown }

const ready = MutableHashMap.empty<string, { readonly summary?: string }>()
const verdicts = MutableHashMap.empty<string, ReadonlyArray<Verdict>>()
const repeated = MutableHashMap.empty<string, string>()
const limits = MutableHashMap.empty<string, number>()

// The same encoding the doom-loop check in `SessionProcessor` compares inputs with.
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const take = <V>(map: MutableHashMap.MutableHashMap<string, V>, key: string) => {
  const value = Option.getOrUndefined(MutableHashMap.get(map, key))
  MutableHashMap.remove(map, key)
  return value
}

/** Watch a builder session for repeated calls; `limit` identical calls in a row end the turn. */
export function watch(sessionID: string, limit: number) {
  MutableHashMap.set(limits, sessionID, limit)
  MutableHashMap.remove(repeated, sessionID)
}

/** Whether the harness watches this session for repeated calls. */
export function watching(sessionID: string) {
  return MutableHashMap.has(limits, sessionID)
}

export function unwatch(sessionID: string) {
  MutableHashMap.remove(limits, sessionID)
}

export function recordReady(sessionID: string, input: { readonly summary?: string }) {
  MutableHashMap.set(ready, sessionID, input)
}

/** The builder's `task_ready` of the turn that just ended, cleared on read. */
export function takeReady(sessionID: string) {
  return take(ready, sessionID)
}

export function recordVerdicts(sessionID: string, input: ReadonlyArray<Verdict>) {
  const before = Option.getOrElse(MutableHashMap.get(verdicts, sessionID), () => [])
  MutableHashMap.set(verdicts, sessionID, [...before, ...input])
}

/** The verdicts of the round that just ended, cleared on read. */
export function takeVerdicts(sessionID: string) {
  return take(verdicts, sessionID)
}

/**
 * Called before each model request of a watched session with the tool calls made since its last user message,
 * oldest first. Returns the reason when the last `limit` calls are one tool with one input, and remembers it.
 */
export function checkRepetition(sessionID: string, calls: ReadonlyArray<Call>): string | undefined {
  const limit = Option.getOrUndefined(MutableHashMap.get(limits, sessionID))
  if (limit === undefined || calls.length < limit) return undefined
  const last = calls.slice(-limit)
  const key = (call: Call) => `${call.tool}\u0000${Option.getOrElse(encodeJson(call.input), () => "")}`
  const first = key(last[0])
  if (!last.every((call) => key(call) === first)) return undefined
  const reason = `repetition: ${limit} identical ${last[0].tool} calls in a row`
  MutableHashMap.set(repeated, sessionID, reason)
  return reason
}

/** The repetition that ended the builder's turn, cleared on read. */
export function takeRepeated(sessionID: string) {
  return take(repeated, sessionID)
}

export * as TaskHooks from "./hooks"

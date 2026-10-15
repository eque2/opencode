import { Effect, Option, Schema } from "effect"
import { ProofProcess } from "@/task/proof/process"
import type { Verdict } from "./model"

// The harness's in-session hooks. `SessionPrompt` consults them while a child session runs: it injects the
// harness-only tools by agent name, routes what those tools receive to the supervisor that owns the session, and asks
// here whether the builder is repeating itself before it sends the next model request (spine AD-11). The functions
// over `HarnessHooks` hold no state: the owner keeps what it receives in its context.

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

/** An entry of the harness root's session index: the supervisor that owns a session (AD-11). */
export interface Owner {
  /** The system id of the supervisor that owns the session. */
  readonly owner: string
  /** Whether `prompt.ts` checks the session's turns for repetition (a builder session). */
  readonly watch: boolean
}

/** The events a hook sends to the owner of its session. */
export type HookEvent =
  | { readonly type: "hook.ready"; readonly session: string; readonly summary?: string }
  | { readonly type: "hook.verdicts"; readonly session: string; readonly verdicts: ReadonlyArray<Verdict> }
  | { readonly type: "hook.repeated"; readonly session: string; readonly reason: string }

/** What `SessionPrompt` resolves from `TaskHarness` and hands to the hooks; no module of `src/task/` holds the root. */
export interface HarnessHooks {
  /** The owner of a session, if a supervisor claimed it. */
  readonly ownerOf: (session: string) => Effect.Effect<Option.Option<Owner>>
  /** Sends the event to the owner of its session; false when no live supervisor owns the session. */
  readonly send: (event: HookEvent) => Effect.Effect<boolean>
  /** The repetition limit in the owner's context, read from its snapshot with no send before the read. */
  readonly limitOf: (session: string) => Effect.Effect<Option.Option<number>>
}

/** `task_ready`: sends `hook.ready` to the owner; false when nobody owns the session, so nothing was recorded. */
export const sendReady = (hooks: HarnessHooks, session: string, input: { readonly summary?: string }) =>
  hooks.send({ type: "hook.ready", session, ...input })

/** `verdict`: sends `hook.verdicts` to the owner; false when nobody owns the session, so nothing was recorded. */
export const sendVerdicts = (hooks: HarnessHooks, session: string, input: ReadonlyArray<Verdict>) =>
  hooks.send({ type: "hook.verdicts", session, verdicts: input })

// The same encoding the doom-loop check in `SessionProcessor` compares inputs with.
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** The pure repetition check: the reason when the last `limit` calls are one tool with one input. */
export function repetition(limit: number, calls: ReadonlyArray<Call>): Option.Option<string> {
  if (calls.length < limit) return Option.none()
  const last = calls.slice(-limit)
  const key = (call: Call) => `${call.tool}\u0000${Option.getOrElse(encodeJson(call.input), () => "")}`
  const first = key(last[0])
  if (!last.every((call) => key(call) === first)) return Option.none()
  return Option.some(`repetition: ${limit} identical ${last[0].tool} calls in a row`)
}

/**
 * The repetition stop of a watched session, before each model request: reads the limit from the owner's snapshot,
 * runs `repetition` over the session's own calls, and on a match sends `hook.repeated` and returns the reason, so
 * `prompt.ts` ends the turn. A session with no owner, or one not watched, is never stopped.
 */
export const repetitionStop = Effect.fn("TaskHooks.repetitionStop")(function* (
  hooks: HarnessHooks,
  session: string,
  calls: ReadonlyArray<Call>,
) {
  const owner = yield* hooks.ownerOf(session)
  if (Option.isNone(owner) || !owner.value.watch) return Option.none<string>()
  const limit = yield* hooks.limitOf(session)
  if (Option.isNone(limit)) return Option.none<string>()
  const reason = repetition(limit.value, calls)
  if (Option.isSome(reason)) yield* hooks.send({ type: "hook.repeated", session, reason: reason.value })
  return reason
})

export * as TaskHooks from "./hooks"

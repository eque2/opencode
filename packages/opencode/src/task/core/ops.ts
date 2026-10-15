import type { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "@/session/schema"

// What `SessionPrompt` hands the harness when it dispatches `/task`. Passed in, not imported, because the harness
// itself prompts sessions and importing `SessionPrompt` from here would be a cycle.

/**
 * The run header (D17, AD-13): the first message of a run carries it as its text part's metadata, and the TUI draws
 * the header from it, never from the text. `spec.title` is the H1 as written, empty when the spec has none.
 */
export interface Header {
  readonly spec: { readonly id: string; readonly title: string }
  /** A subtree run's root task. */
  readonly task?: { readonly id: string; readonly title: string }
  /** The scenarios a subtree run leaves out, as they need tasks outside it (D13, AD-15). */
  readonly leftOut: ReadonlyArray<string>
}

export interface PromptInput {
  readonly sessionID: SessionID
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly parts: ReadonlyArray<{
    readonly type: "text"
    readonly text: string
    /** The run header's structured field (`{ taskHarness: { header } }`, a `Header`), on the header message only. */
    readonly metadata?: { readonly [key: string]: Schema.MutableJson }
  }>
  /** Create the user message only; no model turn (`PromptInput.noReply`). */
  readonly noReply?: boolean
}

export interface Ops {
  /** `SessionPrompt.prompt`: runs the turn in the current instance and returns the last message. */
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts>
  /**
   * Appends one assistant-role text message to a session with no model call (AD-18): the closing summary. It waits
   * behind a turn of the session in flight, and it still writes after the user aborts the session.
   */
  readonly say: (input: { readonly sessionID: SessionID; readonly text: string }) => Effect.Effect<void, unknown>
  /** `SessionPrompt.cancel` in the current instance. */
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** The model the session would use next. */
  readonly currentModel: (sessionID: SessionID) => Effect.Effect<{ readonly providerID: string; readonly modelID: string }>
}

export * as TaskOps from "./ops"

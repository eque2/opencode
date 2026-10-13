import type { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionID } from "@/session/schema"

// What `SessionPrompt` hands the harness when it dispatches `/task`. Passed in, not imported, because the harness
// itself prompts sessions and importing `SessionPrompt` from here would be a cycle.

export interface PromptInput {
  readonly sessionID: SessionID
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID: string }
  readonly parts: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  /** Create the user message only; no model turn (`PromptInput.noReply`). */
  readonly noReply?: boolean
}

export interface Ops {
  /** `SessionPrompt.prompt`: runs the turn in the current instance and returns the last message. */
  readonly prompt: (input: PromptInput) => Effect.Effect<SessionV1.WithParts>
  /** `SessionPrompt.cancel` in the current instance. */
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  /** The model the session would use next. */
  readonly currentModel: (sessionID: SessionID) => Effect.Effect<{ readonly providerID: string; readonly modelID: string }>
}

export * as TaskOps from "./ops"

import { Schema } from "effect"

export type OpenAICompatibleChatModelId = string

export const openaiCompatibleProviderOptions = Schema.Struct({
  /**
   * A unique identifier representing your end-user, which can help the provider to
   * monitor and detect abuse.
   */
  user: Schema.optional(Schema.String),

  /**
   * Reasoning effort for reasoning models. Defaults to `medium`.
   */
  reasoningEffort: Schema.optional(Schema.String),

  /**
   * Controls the verbosity of the generated text. Defaults to `medium`.
   */
  textVerbosity: Schema.optional(Schema.String),

  /**
   * Copilot thinking_budget used for Anthropic models.
   */
  thinking_budget: Schema.optional(Schema.Finite),
}).annotate({ identifier: "GithubCopilot.OpenAICompatibleProviderOptions" })

export type OpenAICompatibleProviderOptions = typeof openaiCompatibleProviderOptions.Type

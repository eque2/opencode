import type { Hooks } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk"

type ChatInput = Parameters<NonNullable<Hooks["chat.params"]>>[0]
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1]

// Typed builders for the chat hook inputs, so tests pass real plugin SDK shapes to the hooks.
export function chatModel(input: { providerID: string; npm: string; apiID?: string }): Model {
  return {
    id: input.apiID ?? "test-model",
    providerID: input.providerID,
    api: { id: input.apiID ?? "test-model", url: "https://example.test", npm: input.npm },
    name: "Test model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
  }
}

export function chatInput(input: { sessionID?: string; model: Model }): ChatInput {
  const sessionID = input.sessionID ?? "ses_test"
  return {
    sessionID,
    agent: "build",
    model: input.model,
    provider: {
      source: "custom",
      info: {
        id: input.model.providerID,
        name: input.model.providerID,
        source: "custom",
        env: [],
        options: {},
        models: {},
      },
      options: {},
    },
    message: {
      id: "msg_test",
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: input.model.providerID, modelID: input.model.id },
    },
  }
}

export function chatParamsOutput(input: Pick<ChatParamsOutput, "maxOutputTokens" | "options">): ChatParamsOutput {
  return { temperature: 0, topP: 1, topK: 0, ...input }
}

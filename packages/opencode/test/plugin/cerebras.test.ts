import { describe, expect, test } from "bun:test"
import { CerebrasPlugin } from "../../src/plugin/cerebras"
import { chatInput, chatModel, chatParamsOutput } from "./chat-hook.fixture"

function input(npm: string) {
  return chatInput({ model: chatModel({ providerID: "cerebras", npm }) })
}

function output(options: Record<string, unknown>) {
  return chatParamsOutput({ maxOutputTokens: 32_000, options })
}

describe("CerebrasPlugin", () => {
  test("omits the generic output cap when max_completion_tokens is configured", async () => {
    const hook = (await CerebrasPlugin())["chat.params"]!
    const params = output({ max_completion_tokens: 64 })

    await hook(input("@ai-sdk/cerebras"), params)

    expect(params.maxOutputTokens).toBeUndefined()
  })

  test("preserves the generic output cap without max_completion_tokens", async () => {
    const hook = (await CerebrasPlugin())["chat.params"]!
    const params = output({})

    await hook(input("@ai-sdk/cerebras"), params)

    expect(params.maxOutputTokens).toBe(32_000)
  })

  test("does not change other providers", async () => {
    const hook = (await CerebrasPlugin())["chat.params"]!
    const params = output({ max_completion_tokens: 64 })

    await hook(input("@ai-sdk/openai"), params)

    expect(params.maxOutputTokens).toBe(32_000)
  })
})

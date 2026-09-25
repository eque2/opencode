import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2/client"
import { Option } from "effect"
import { createStore } from "solid-js/store"
import { getSessionContext } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
): AssistantMessage => {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: "u1",
    providerID,
    modelID,
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  }
}

const user = (id: string): UserMessage => {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    agent: "build",
    model: { providerID: "openai", modelID: "gpt-4.1" },
    time: { created: 1 },
  }
}

describe("getSessionContext", () => {
  test("computes token totals and usage from latest assistant with tokens", () => {
    const messages: Message[] = [
      user("u1"),
      assistant("a1", { input: 600, output: 200, reasoning: 100, read: 50, write: 50 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.message.id).toBe("a2")
    expect(ctx?.total).toBe(500)
    expect(ctx?.input).toBe(300)
    expect(ctx?.usage).toEqual(Option.some(50))
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages: Message[] = [
      assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1"),
    ]
    const providers = [{ id: "p-1", models: {} }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.providerLabel).toBe("p-1")
    expect(ctx?.modelLabel).toBe("m-1")
    expect(ctx?.limit).toBeUndefined()
    expect(ctx?.usage).toEqual(Option.none())
  })

  test("recomputes when message array is mutated in place", () => {
    const [messages, setMessages] = createStore<Message[]>([
      assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25),
    ])
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContext(messages, providers)
    // The store setter appends at the next index, which mutates the same array in place.
    setMessages(messages.length, assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContext(messages, providers)

    expect(one?.message.id).toBe("a1")
    expect(two?.message.id).toBe("a2")
  })

  test("returns undefined when inputs are undefined", () => {
    const ctx = getSessionContext()

    expect(ctx).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, TextPart, UserMessage } from "@opencode-ai/sdk/v2/client"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"

const user = (id: string): UserMessage => ({
  id,
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-4.1" },
})

const assistant = (id: string): AssistantMessage => ({
  id,
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1 },
  parentID: "u1",
  modelID: "gpt-4.1",
  providerID: "openai",
  mode: "build",
  agent: "build",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const text = (messageID: string, value: string): TextPart => ({
  id: `prt_${messageID}`,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text: value,
})

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages: Message[] = [user("u1"), assistant("a1")]
    const parts = {
      u1: [text("u1", "hello world")],
      a1: [text("a1", "assistant response")],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  test("scales segments when estimates exceed input", () => {
    const messages: Message[] = [user("u1"), assistant("a1")]
    const parts = {
      u1: [text("u1", "x".repeat(400))],
      a1: [text("a1", "y".repeat(400))],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })
})

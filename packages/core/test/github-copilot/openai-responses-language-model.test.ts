import { OpenAIResponsesLanguageModel } from "@opencode-ai/core/github-copilot/responses/openai-responses-language-model"
import { convertToOpenAIResponsesInput } from "@opencode-ai/core/github-copilot/responses/convert-to-openai-responses-input"
import { describe, test, expect, mock } from "bun:test"
import type {
  LanguageModelV3Content,
  LanguageModelV3Prompt,
  LanguageModelV3Reasoning,
  LanguageModelV3Text,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import { Effect } from "effect"

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

function createMockFetch(body: unknown): FetchFunction {
  return Object.assign(
    mock(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    ),
    { preconnect: fetch.preconnect },
  )
}

function createModel(fetchFn: FetchFunction) {
  return new OpenAIResponsesLanguageModel("test-model", {
    provider: "copilot",
    url: () => "https://api.test.com/responses",
    headers: () => ({ Authorization: "Bearer test-token" }),
    fetch: fetchFn,
  })
}

const isReasoning = (part: LanguageModelV3Content): part is LanguageModelV3Reasoning => part.type === "reasoning"
const isText = (part: LanguageModelV3Content): part is LanguageModelV3Text => part.type === "text"
const isToolCall = (part: LanguageModelV3Content): part is LanguageModelV3ToolCall => part.type === "tool-call"

// GitHub Copilot's Responses model echoes item metadata (itemId, reasoningEncryptedContent,
// responseId, ...) under the "copilot" providerOptions/providerMetadata namespace, matching the
// namespace request options already use. It used to echo this metadata under "openai" (a leftover
// from forking the OpenAI Responses model), which left it unreachable by anything reading the
// "copilot" namespace and let stale itemIds slip past stripping meant for that namespace.
describe("doGenerate", () => {
  test("attaches item metadata under the copilot namespace, not openai", async () => {
    const mockFetch = createMockFetch({
      id: "resp_1",
      created_at: 0,
      model: "gpt-5.5",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "enc_1",
          summary: [{ type: "summary_text", text: "thinking..." }],
        },
        {
          type: "message",
          role: "assistant",
          id: "msg_1",
          content: [{ type: "output_text", text: "Hello there", annotations: [] }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "bash",
          arguments: "{}",
          id: "fc_1",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const model = createModel(mockFetch)

    const { content, providerMetadata } = await model.doGenerate({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })

    const reasoning = content.find(isReasoning)
    expect(reasoning?.providerMetadata?.copilot?.itemId).toBe("rs_1")
    expect(reasoning?.providerMetadata?.copilot?.reasoningEncryptedContent).toBe("enc_1")
    expect(reasoning?.providerMetadata?.openai).toBeUndefined()

    const text = content.find(isText)
    expect(text?.providerMetadata?.copilot?.itemId).toBe("msg_1")
    expect(text?.providerMetadata?.openai).toBeUndefined()

    const toolCall = content.find(isToolCall)
    expect(toolCall?.providerMetadata?.copilot?.itemId).toBe("fc_1")
    expect(toolCall?.providerMetadata?.openai).toBeUndefined()

    expect(providerMetadata?.copilot?.responseId).toBe("resp_1")
    expect(providerMetadata?.openai).toBeUndefined()
  })
})

describe("convertToOpenAIResponsesInput", () => {
  test("echoes a stale tool-call itemId from the copilot namespace as the function_call id", async () => {
    const { input } = await Effect.runPromise(
      convertToOpenAIResponsesInput({
        prompt: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "bash",
                input: { command: "ls" },
                providerOptions: { copilot: { itemId: "fc_999" } },
              },
            ],
          },
        ],
        systemMessageMode: "system",
        store: false,
      }),
    )

    expect(input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: JSON.stringify({ command: "ls" }),
        id: "fc_999",
      },
    ])
  })

  test("omits the function_call id once the stale copilot itemId has been stripped", async () => {
    const { input } = await Effect.runPromise(
      convertToOpenAIResponsesInput({
        prompt: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "bash",
                input: { command: "ls" },
                providerOptions: {},
              },
            ],
          },
        ],
        systemMessageMode: "system",
        store: false,
      }),
    )

    const [item] = input
    expect(item).toBeDefined()
    expect(item && "id" in item ? item.id : undefined).toBeUndefined()
  })

  test("preserves reasoning items keyed by the copilot namespace instead of dropping them", async () => {
    const { input, warnings } = await Effect.runPromise(
      convertToOpenAIResponsesInput({
        prompt: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "thinking...",
                providerOptions: { copilot: { itemId: "rs_1", reasoningEncryptedContent: "enc_1" } },
              },
            ],
          },
        ],
        systemMessageMode: "system",
        store: false,
      }),
    )

    expect(warnings).toEqual([])
    expect(input).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "enc_1",
        summary: [{ type: "summary_text", text: "thinking..." }],
      },
    ])
  })

  test("drops reasoning items with no copilot itemId and warns, as before", async () => {
    const { input, warnings } = await Effect.runPromise(
      convertToOpenAIResponsesInput({
        prompt: [
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "thinking...", providerOptions: {} }],
          },
        ],
        systemMessageMode: "system",
        store: false,
      }),
    )

    expect(input).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      message: expect.stringContaining("Non-OpenAI reasoning parts are not supported"),
    })
  })

  test("reads imageDetail from the copilot namespace on user file parts", async () => {
    const { input } = await Effect.runPromise(
      convertToOpenAIResponsesInput({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: "aGVsbG8=",
                providerOptions: { copilot: { imageDetail: "high" } },
              },
            ],
          },
        ],
        systemMessageMode: "system",
        store: false,
      }),
    )

    expect(input[0]).toMatchObject({ content: [{ detail: "high" }] })
  })
})

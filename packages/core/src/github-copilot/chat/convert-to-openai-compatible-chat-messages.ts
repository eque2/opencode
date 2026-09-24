import {
  type LanguageModelV3Message,
  type LanguageModelV3Prompt,
  type LanguageModelV3ToolResultOutput,
  type SharedV3ProviderOptions,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider"
import type {
  OpenAICompatibleChatPrompt,
  OpenAICompatibleContentPart,
  OpenAICompatibleMessage,
  OpenAICompatibleMessageToolCall,
  OpenAICompatibleToolMessage,
} from "./openai-compatible-api-types"
import { convertToBase64 } from "@ai-sdk/provider-utils"
import { Effect, Predicate, Schema } from "effect"

export class UnsupportedRoleError extends Schema.TaggedError<UnsupportedRoleError>()(
  "GithubCopilot.UnsupportedRoleError",
  { message: Schema.String },
) {}

type ConversionError = UnsupportedFunctionalityError | UnsupportedRoleError | Schema.SchemaError
type UserContent = Extract<LanguageModelV3Message, { role: "user" }>["content"]
type AssistantContent = Extract<LanguageModelV3Message, { role: "assistant" }>["content"]
type ToolContent = Extract<LanguageModelV3Message, { role: "tool" }>["content"]
type OpenAIMetadata = ReturnType<typeof getOpenAIMetadata>

// The AI SDK types tool-call input as unknown and tool output values as JSONValue, whose objects
// may hold undefined members. The codec writes the same text as JSON.stringify, which drops them.
const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

function getOpenAIMetadata(message: { providerOptions?: SharedV3ProviderOptions }) {
  return message?.providerOptions?.copilot ?? {}
}

export const convertToOpenAICompatibleChatMessages = Effect.fn("GithubCopilot.convertToOpenAICompatibleChatMessages")(
  function* (prompt: LanguageModelV3Prompt) {
    const messages = yield* Effect.forEach(prompt, convertMessage)
    return messages.flat() satisfies OpenAICompatibleChatPrompt
  },
)

// One prompt message becomes one OpenAI-compatible message, except a tool message, which
// becomes one message for each tool result.
function convertMessage({
  role,
  content,
  ...message
}: LanguageModelV3Message): Effect.Effect<ReadonlyArray<OpenAICompatibleMessage>, ConversionError> {
  const metadata = getOpenAIMetadata(message)
  switch (role) {
    case "system":
      return Effect.succeed([{ role: "system", content, ...metadata }])
    case "user":
      return convertUserMessage(content, metadata)
    case "assistant":
      return convertAssistantMessage(content, metadata)
    case "tool":
      return convertToolMessages(content)
    default: {
      const _exhaustiveCheck: never = role
      return Effect.fail(new UnsupportedRoleError({ message: `Unsupported role: ${String(_exhaustiveCheck)}` }))
    }
  }
}

function convertUserMessage(
  content: UserContent,
  metadata: OpenAIMetadata,
): Effect.Effect<ReadonlyArray<OpenAICompatibleMessage>, UnsupportedFunctionalityError> {
  if (content.length === 1 && content[0].type === "text") {
    return Effect.succeed([{ role: "user", content: content[0].text, ...getOpenAIMetadata(content[0]) }])
  }
  return Effect.forEach(content, convertUserPart).pipe(
    Effect.map((parts) => [{ role: "user", content: parts, ...metadata }]),
  )
}

function convertUserPart(
  part: UserContent[number],
): Effect.Effect<OpenAICompatibleContentPart, UnsupportedFunctionalityError> {
  const partMetadata = getOpenAIMetadata(part)
  const { type } = part
  switch (type) {
    case "text": {
      return Effect.succeed({ type: "text", text: part.text, ...partMetadata })
    }
    case "file": {
      if (part.mediaType.startsWith("image/")) {
        const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType

        return Effect.succeed({
          type: "image_url",
          image_url: {
            url:
              part.data instanceof URL
                ? part.data.toString()
                : `data:${mediaType};base64,${convertToBase64(part.data)}`,
          },
          ...partMetadata,
        })
      }
      return Effect.fail(
        new UnsupportedFunctionalityError({
          functionality: `file part media type ${part.mediaType}`,
        }),
      )
    }
    default: {
      const _exhaustiveCheck: never = type
      return Effect.fail(
        new UnsupportedFunctionalityError({ functionality: `user content part type ${String(_exhaustiveCheck)}` }),
      )
    }
  }
}

const convertAssistantMessage = Effect.fnUntraced(function* (content: AssistantContent, metadata: OpenAIMetadata) {
  let text = ""
  let reasoningText: string | undefined
  let reasoningOpaque: string | undefined

  for (const part of content) {
    // Check for reasoningOpaque on any part (may be attached to text/tool-call)
    const partOpaque = part.providerOptions?.copilot?.reasoningOpaque
    if (Predicate.isString(partOpaque) && partOpaque && !reasoningOpaque) {
      reasoningOpaque = partOpaque
    }

    switch (part.type) {
      case "text": {
        text += part.text
        break
      }
      case "reasoning": {
        if (part.text) reasoningText = part.text
        break
      }
    }
  }

  const toolCalls = yield* Effect.forEach(
    content.flatMap((part) => (part.type === "tool-call" ? [part] : [])),
    (part) =>
      encodeJsonText(part.input).pipe(
        Effect.map(
          (input): OpenAICompatibleMessageToolCall => ({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.toolName,
              arguments: input,
            },
            ...getOpenAIMetadata(part),
          }),
        ),
      ),
  )

  const assistant: OpenAICompatibleMessage = {
    role: "assistant",
    content: text || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    reasoning_text: reasoningOpaque ? reasoningText : undefined,
    reasoning_opaque: reasoningOpaque,
    ...metadata,
  }
  return [assistant]
})

function convertToolMessages(content: ToolContent) {
  return Effect.forEach(
    content.flatMap((part) => (part.type === "tool-approval-response" ? [] : [part])),
    (toolResponse) =>
      toolOutputText(toolResponse.output).pipe(
        Effect.map(
          (content): OpenAICompatibleToolMessage => ({
            role: "tool",
            tool_call_id: toolResponse.toolCallId,
            content,
            ...getOpenAIMetadata(toolResponse),
          }),
        ),
      ),
  )
}

function toolOutputText(
  output: LanguageModelV3ToolResultOutput,
): Effect.Effect<string, Schema.SchemaError | UnsupportedFunctionalityError> {
  const { type } = output
  switch (type) {
    case "text":
    case "error-text":
      return Effect.succeed(output.value)
    case "execution-denied":
      return Effect.succeed(output.reason ?? "Tool execution denied.")
    case "content":
    case "json":
    case "error-json":
      return encodeJsonText(output.value)
    default: {
      const _exhaustiveCheck: never = type
      return Effect.fail(
        new UnsupportedFunctionalityError({ functionality: `tool output type ${String(_exhaustiveCheck)}` }),
      )
    }
  }
}

import type { JsonSchema, LLMRequest, ProviderMetadata } from "@opencode-ai/llm"
import { LLM, Message, SystemPart, ToolCallPart, ToolDefinition, ToolResultPart } from "@opencode-ai/llm"
import {
  AmazonBedrock,
  Anthropic,
  Azure,
  Google,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
} from "@opencode-ai/llm/providers"
import type { ModelMessage } from "ai"
import { Effect, Option, Schema } from "effect"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import { LLMJson } from "./json"

/** The session data cannot be lowered into a native LLM request. */
export class NativeRequestError extends Schema.TaggedError<NativeRequestError>()("LLMNativeRequestError", {
  message: Schema.String,
}) {}

type ToolInput = {
  readonly description?: string
  readonly inputSchema?: unknown
}

export type RequestInput = {
  readonly model: Provider.Model
  readonly apiKey?: string
  readonly baseURL?: string
  readonly system?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools?: Record<string, ToolInput>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: LLMRequest["providerOptions"]
  readonly headers?: Record<string, string>
}

const providerMetadata = (value: unknown): Option.Option<ProviderMetadata> => {
  if (!isRecord(value)) return Option.none()
  const result = LLMJson.objectEntries(value)
  return Object.keys(result).length === 0 ? Option.none() : Option.some(result)
}

// Stored AI SDK parts historically kept provider-owned continuation metadata in
// `providerOptions`; native parts now use `providerMetadata` directly.
const providerMetadataField = (part: Record<string, unknown>) =>
  Option.match(
    Option.orElse(providerMetadata(part.providerMetadata), () => providerMetadata(part.providerOptions)),
    { onNone: () => ({}), onSome: (providerMetadata) => ({ providerMetadata }) },
  )

const providerExecutedField = (part: Record<string, unknown>) =>
  typeof part.providerExecuted === "boolean" ? { providerExecuted: part.providerExecuted } : {}

const textPart = (part: Record<string, unknown>) => ({
  type: "text" as const,
  text: typeof part.text === "string" ? part.text : "",
  ...providerMetadataField(part),
})

const mediaPart = (part: Record<string, unknown>) => {
  if (typeof part.data !== "string" && !(part.data instanceof Uint8Array))
    return Effect.fail(
      new NativeRequestError({
        message: "Native LLM request adapter only supports file parts with string or Uint8Array data",
      }),
    )
  return Effect.succeed({
    type: "media" as const,
    mediaType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream",
    data: part.data,
    ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
  })
}

const toolResult = (part: Record<string, unknown>) => {
  const output = isRecord(part.output) ? part.output : { type: "json", value: part.output }
  const type = output.type === "text" ? "text" : output.type === "error-text" ? "error" : "json"
  return ToolResultPart.make({
    id: typeof part.toolCallId === "string" ? part.toolCallId : "",
    name: typeof part.toolName === "string" ? part.toolName : "",
    result: "value" in output ? output.value : output,
    resultType: type,
    ...providerExecutedField(part),
    ...providerMetadataField(part),
  })
}

const contentPart = Effect.fnUntraced(function* (part: unknown) {
  if (!isRecord(part))
    return yield* new NativeRequestError({ message: "Native LLM request adapter only supports object content parts" })
  if (part.type === "text") return textPart(part)
  if (part.type === "file") return yield* mediaPart(part)
  if (part.type === "reasoning")
    return {
      type: "reasoning" as const,
      text: typeof part.text === "string" ? part.text : "",
      ...providerMetadataField(part),
    }
  if (part.type === "tool-call")
    return ToolCallPart.make({
      id: typeof part.toolCallId === "string" ? part.toolCallId : "",
      name: typeof part.toolName === "string" ? part.toolName : "",
      input: part.input,
      ...providerExecutedField(part),
      ...providerMetadataField(part),
    })
  if (part.type === "tool-result") return toolResult(part)
  return yield* new NativeRequestError({
    message: `Native LLM request adapter does not support ${String(part.type)} content parts`,
  })
})

const content = Effect.fnUntraced(function* (value: ModelMessage["content"]) {
  if (typeof value === "string") return [{ type: "text" as const, text: value }]
  return yield* Effect.forEach(value, contentPart)
})

const messages = Effect.fnUntraced(function* (input: readonly ModelMessage[]) {
  const system = input.flatMap((message) => (message.role === "system" ? [SystemPart.make(message.content)] : []))
  const messages = yield* Effect.forEach(
    input.filter((message) => message.role !== "system"),
    (message) =>
      content(message.content).pipe(
        Effect.map((content) =>
          Message.make({
            role: message.role,
            content,
            ...(isRecord(message.providerOptions)
              ? { native: { providerOptions: LLMJson.objectEntries(message.providerOptions) } }
              : {}),
          }),
        ),
      ),
  )
  return { system, messages }
})

const emptyObjectSchema = (): JsonSchema => ({ type: "object", properties: {} })

const schema = (value: unknown): JsonSchema => {
  if (!isRecord(value)) return emptyObjectSchema()
  return Option.getOrElse(
    LLMJson.toJsonObject(isRecord(value.jsonSchema) ? value.jsonSchema : value),
    emptyObjectSchema,
  )
}

const tools = (input: Record<string, ToolInput> | undefined): ToolDefinition[] =>
  Object.entries(input ?? {}).map(([name, item]) =>
    ToolDefinition.make({
      name,
      description: item.description ?? "",
      inputSchema: schema(item.inputSchema),
    }),
  )

const generationField = (input: RequestInput) => {
  const generation = {
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxTokens: input.maxOutputTokens,
  }
  return Object.values(generation).some((value) => value !== undefined) ? { generation } : {}
}

// An empty configured URL counts as no URL; a request base URL overrides the model URL.
const baseURL = (input: Provider.Model | RequestInput) =>
  Option.liftPredicate("model" in input ? (input.baseURL ?? input.model.api.url) : input.api.url, (url) => url !== "")

const requireBaseURL = (model: Provider.Model, url: Option.Option<string>) =>
  Option.match(url, {
    onNone: () =>
      Effect.fail(
        new NativeRequestError({
          message: `Native LLM request adapter requires a base URL for ${model.providerID}/${model.id}`,
        }),
      ),
    onSome: Effect.succeed,
  })

export const model = Effect.fnUntraced(function* (
  input: Provider.Model | RequestInput,
  headers?: Record<string, string>,
) {
  const model = "model" in input ? input.model : input
  const url = baseURL(input)
  const mergedHeaders = { ...model.headers, ...headers }
  const options = {
    ...("model" in input && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...Option.match(url, { onNone: () => ({}), onSome: (baseURL) => ({ baseURL }) }),
    ...(Object.keys(mergedHeaders).length === 0 ? {} : { headers: mergedHeaders }),
    limits: {
      context: model.limit.context,
      output: model.limit.output,
    },
  }
  if (model.api.npm === "@ai-sdk/openai") return OpenAI.configure(options).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/azure")
    return Azure.configure({ ...options, baseURL: yield* requireBaseURL(model, url) }).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/anthropic") return Anthropic.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/google") return Google.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return AmazonBedrock.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/openai-compatible")
    return OpenAICompatible.configure({
      ...options,
      provider: String(model.providerID),
      baseURL: yield* requireBaseURL(model, url),
    }).model(model.api.id)
  if (model.api.npm === "@openrouter/ai-sdk-provider") return OpenRouter.configure(options).model(model.api.id)
  return yield* new NativeRequestError({
    message: `Native LLM request adapter does not support provider package ${model.api.npm}`,
  })
})

export const request = Effect.fnUntraced(function* (input: RequestInput) {
  const converted = yield* messages(input.messages)
  // This is the only native adapter boundary that should construct canonical
  // @opencode-ai/llm request objects from opencode's session/AI SDK-shaped data.
  return LLM.request({
    model: yield* model(input, input.headers),
    system: [...(input.system ?? []).map(SystemPart.make), ...converted.system],
    messages: converted.messages,
    tools: tools(input.tools),
    toolChoice: input.toolChoice,
    ...generationField(input),
    providerOptions: input.providerOptions,
  })
})

export * as LLMNative from "./native-request"

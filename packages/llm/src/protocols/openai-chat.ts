import { Array as Arr, Effect, Option, Predicate, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { isRecord, JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "openai-chat"
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/chat/completions"

// =============================================================================
// Request Body Schema
// =============================================================================
// The body schema is the provider-native JSON body. `fromRequest` below builds
// this shape from the common `LLMRequest`, then `Route.make` validates and
// JSON-encodes it before transport.
const OpenAIChatFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
}).annotate({ identifier: "OpenAIChat.Function" })

const OpenAIChatTool = Schema.Struct({
  type: Schema.tag("function"),
  function: OpenAIChatFunction,
}).annotate({ identifier: "OpenAIChat.Tool" })
type OpenAIChatTool = Schema.Schema.Type<typeof OpenAIChatTool>

const OpenAIChatAssistantToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.tag("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
}).annotate({ identifier: "OpenAIChat.AssistantToolCall" })
type OpenAIChatAssistantToolCall = Schema.Schema.Type<typeof OpenAIChatAssistantToolCall>

const OpenAIChatUserContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image_url"),
    image_url: Schema.Struct({ url: Schema.String }),
  }),
])

const OpenAIChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(OpenAIChatUserContent)]),
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: optionalArray(OpenAIChatAssistantToolCall),
    reasoning_content: Schema.optional(Schema.String),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String, content: Schema.String }),
]).pipe(Schema.toTaggedUnion("role"))
type OpenAIChatMessage = Schema.Schema.Type<typeof OpenAIChatMessage>
type OpenAIChatUserContentPart = Schema.Schema.Type<typeof OpenAIChatUserContent>

const OpenAIChatToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    type: Schema.tag("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
])

export const bodyFields = {
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  tools: optionalArray(OpenAIChatTool),
  tool_choice: Schema.optional(OpenAIChatToolChoice),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Boolean })),
  store: Schema.optional(Schema.Boolean),
  reasoning_effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: optionalArray(Schema.String),
}
const OpenAIChatBody = Schema.Struct(bodyFields).annotate({ identifier: "OpenAIChat.Body" })
export type OpenAIChatBody = Schema.Schema.Type<typeof OpenAIChatBody>

// =============================================================================
// Streaming Event Schema
// =============================================================================
// The event schema is one decoded SSE `data:` payload. `Framing.sse` splits the
// byte stream into strings, then `Protocol.jsonEvent` decodes each string into
// this provider-native event shape.
const OpenAIChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  prompt_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
    }),
  ),
  completion_tokens_details: optionalNull(
    Schema.Struct({
      reasoning_tokens: Schema.optional(Schema.Number),
    }),
  ),
}).annotate({ identifier: "OpenAIChat.Usage" })

const OpenAIChatToolCallDeltaFunction = Schema.Struct({
  name: optionalNull(Schema.String),
  arguments: optionalNull(Schema.String),
}).annotate({ identifier: "OpenAIChat.ToolCallDeltaFunction" })

const OpenAIChatToolCallDelta = Schema.Struct({
  index: Schema.Number,
  id: optionalNull(Schema.String),
  function: optionalNull(OpenAIChatToolCallDeltaFunction),
}).annotate({ identifier: "OpenAIChat.ToolCallDelta" })
type OpenAIChatToolCallDelta = Schema.Schema.Type<typeof OpenAIChatToolCallDelta>

const OpenAIChatDelta = Schema.Struct({
  content: optionalNull(Schema.String),
  reasoning_content: optionalNull(Schema.String),
  tool_calls: optionalNull(Schema.Array(OpenAIChatToolCallDelta)),
}).annotate({ identifier: "OpenAIChat.Delta" })

const OpenAIChatChoice = Schema.Struct({
  delta: optionalNull(OpenAIChatDelta),
  finish_reason: optionalNull(Schema.String),
}).annotate({ identifier: "OpenAIChat.Choice" })

const OpenAIChatEvent = Schema.Struct({
  choices: Schema.Array(OpenAIChatChoice),
  usage: optionalNull(OpenAIChatUsage),
}).annotate({ identifier: "OpenAIChat.Event" })
type OpenAIChatEvent = Schema.Schema.Type<typeof OpenAIChatEvent>
type OpenAIChatRequestMessage = LLMRequest["messages"][number]

interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly toolCallEvents: ReadonlyArray<LLMEvent>
  readonly usage?: Usage
  readonly finishReason?: FinishReason
  readonly lifecycle: Lifecycle.State
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
// Lowering is the only place that knows how common LLM messages map onto the
// OpenAI Chat wire format. Keep provider quirks here instead of leaking native
// fields into `LLMRequest`.
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema): OpenAIChatTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: ToolSchemaProjection.openAI(inputSchema),
  },
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("OpenAI Chat", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({ type: "function" as const, function: { name } }),
  })

const lowerToolCall = (part: ToolCallPart): OpenAIChatAssistantToolCall => ({
  id: part.id,
  type: "function",
  function: {
    name: part.name,
    arguments: ProviderShared.encodeJson(part.input),
  },
})

const lowerMedia = Effect.fn("OpenAIChat.lowerMedia")(function* (part: MediaPart) {
  const media = yield* ProviderShared.validateMedia("OpenAI Chat", part, ProviderShared.IMAGE_MIMES)
  return { type: "image_url" as const, image_url: { url: media.dataUrl } }
})

const openAICompatibleReasoningContent = (native: unknown): Option.Option<string> =>
  isRecord(native) ? Option.liftPredicate(native.reasoning_content, Predicate.isString) : Option.none()

const lowerUserMessage = Effect.fn("OpenAIChat.lowerUserMessage")(function* (message: OpenAIChatRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "media") {
      content.push(yield* lowerMedia(part))
      continue
    }
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "user", ["text", "media"])
  }
  if (content.every((part) => part.type === "text"))
    return { role: "user" as const, content: content.map((part) => part.text).join("") }
  return { role: "user" as const, content }
})

// A tool-call-only assistant turn sends `content: null`. Code holds the
// joined text as an Option and the codec writes the JSON `null`.
const encodeAssistantContent = Schema.encodeSync(Schema.OptionFromNullOr(Schema.String))

const lowerAssistantMessage = Effect.fn("OpenAIChat.lowerAssistantMessage")(function* (
  message: OpenAIChatRequestMessage,
) {
  if (!message.content.every((part) => ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"])))
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "assistant", ["text", "reasoning", "tool-call"])
  const content = message.content.filter((part): part is TextPart => part.type === "text")
  const reasoning = message.content.filter((part): part is ReasoningPart => part.type === "reasoning")
  const toolCalls = message.content.filter((part): part is ToolCallPart => part.type === "tool-call").map(lowerToolCall)
  const reasoningContent =
    reasoning.length > 0
      ? Option.some(reasoning.map((part) => part.text).join(""))
      : openAICompatibleReasoningContent(message.native?.openaiCompatible)
  return {
    role: "assistant" as const,
    content: encodeAssistantContent(
      content.length === 0 ? Option.none() : Option.some(ProviderShared.joinText(content)),
    ),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    ...Option.match(reasoningContent, {
      onNone: () => ({}),
      onSome: (text) => ({ reasoning_content: text }),
    }),
  }
})

// One tool result lowers to one `tool` message. Image files cannot sit in a
// tool message, so they come back separately for a following user message.
const lowerToolResult = Effect.fn("OpenAIChat.lowerToolResult")(function* (
  part: OpenAIChatRequestMessage["content"][number],
) {
  if (!ProviderShared.supportsContent(part, ["tool-result"]))
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "tool", ["tool-result"])
  if (part.result.type !== "content")
    return {
      message: { role: "tool" as const, tool_call_id: part.id, content: ProviderShared.toolResultText(part) },
      images: [],
    }
  const content: ReadonlyArray<ToolContent> = part.result.value
  const text = content.filter((item) => item.type === "text").map((item) => item.text)
  const files = content.filter((item) => item.type === "file")
  return {
    message: { role: "tool" as const, tool_call_id: part.id, content: text.join("\n") },
    images: yield* Effect.forEach(files, (item) =>
      lowerMedia({ type: "media", mediaType: item.mime, data: item.uri, filename: item.name }),
    ),
  }
})

const lowerToolMessages = Effect.fn("OpenAIChat.lowerToolMessages")(function* (message: OpenAIChatRequestMessage) {
  const lowered = yield* Effect.forEach(message.content, lowerToolResult)
  return {
    messages: lowered.map((result) => result.message),
    images: lowered.flatMap((result) => result.images),
  }
})

const lowerMessage = Effect.fn("OpenAIChat.lowerMessage")(function* (message: OpenAIChatRequestMessage) {
  if (message.role === "user") return [yield* lowerUserMessage(message)]
  if (message.role === "assistant") return [yield* lowerAssistantMessage(message)]
  return (yield* lowerToolMessages(message)).messages
})

// A wrapped chronological system update joins a directly preceding user
// message; otherwise it becomes its own user message.
const appendSystemUpdate = (
  messages: ReadonlyArray<OpenAIChatMessage>,
  text: string,
): ReadonlyArray<OpenAIChatMessage> => {
  const previous = messages.at(-1)
  if (previous?.role === "user" && typeof previous.content === "string")
    return Arr.append(messages.slice(0, -1), { role: "user", content: `${previous.content}\n${text}` })
  if (previous?.role === "user" && Array.isArray(previous.content))
    return Arr.append(messages.slice(0, -1), {
      role: "user",
      content: [...previous.content, { type: "text", text }],
    })
  return Arr.append(messages, { role: "user", content: text })
}

const lowerMessages = Effect.fn("OpenAIChat.lowerMessages")(function* (request: LLMRequest) {
  let messages: ReadonlyArray<OpenAIChatMessage> =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  // Tool-result images wait here and flush as one user message before the
  // next non-tool turn, so parallel tool messages stay contiguous.
  let pendingImages: ReadonlyArray<OpenAIChatUserContentPart> = []
  const flushImages = () => {
    if (pendingImages.length > 0) messages = Arr.append(messages, { role: "user", content: pendingImages })
    pendingImages = []
  }
  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Chat", message)
      if (pendingImages.length > 0) {
        messages = Arr.append(messages, {
          role: "user",
          content: Arr.append(pendingImages, { type: "text", text: part.text }),
        })
        pendingImages = []
        continue
      }
      messages = appendSystemUpdate(messages, part.text)
      continue
    }
    if (message.role === "tool") {
      const lowered = yield* lowerToolMessages(message)
      messages = Arr.appendAll(messages, lowered.messages)
      pendingImages = Arr.appendAll(pendingImages, lowered.images)
      continue
    }
    flushImages()
    const lowered: ReadonlyArray<OpenAIChatMessage> = yield* lowerMessage(message)
    messages = Arr.appendAll(messages, lowered)
  }
  flushImages()
  return messages
})

const lowerOptions = Effect.fn("OpenAIChat.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  const reasoningEffort = OpenAIOptions.reasoningEffort(request)
  if (reasoningEffort && !OpenAIOptions.isReasoningEffort(reasoningEffort))
    return yield* invalid(`OpenAI Chat does not support reasoning effort ${reasoningEffort}`)
  return {
    ...(store !== undefined ? { store } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIChat.fromRequest")(function* (request: LLMRequest) {
  // `fromRequest` returns the provider body only. Endpoint, auth, framing,
  // validation, and HTTP execution are composed by `Route.make`.
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) =>
            lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
          ),
        }),
    ...(request.toolChoice ? { tool_choice: yield* lowerToolChoice(request.toolChoice) } : {}),
    stream: true as const,
    stream_options: { include_usage: true },
    // Unset generation options are omitted rather than set to undefined, so
    // bodies that extend this schema with a JSON rest record (OpenRouter)
    // still validate.
    ...(generation?.maxTokens === undefined ? {} : { max_tokens: generation.maxTokens }),
    ...(generation?.temperature === undefined ? {} : { temperature: generation.temperature }),
    ...(generation?.topP === undefined ? {} : { top_p: generation.topP }),
    ...(generation?.frequencyPenalty === undefined ? {} : { frequency_penalty: generation.frequencyPenalty }),
    ...(generation?.presencePenalty === undefined ? {} : { presence_penalty: generation.presencePenalty }),
    ...(generation?.seed === undefined ? {} : { seed: generation.seed }),
    ...(generation?.stop === undefined ? {} : { stop: generation.stop }),
    ...(yield* lowerOptions(request)),
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Streaming parsers are small state machines: every event returns a new state
// plus the common `LLMEvent`s produced by that event. Tool calls are accumulated
// because OpenAI streams JSON arguments across multiple deltas.
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "stop") return "stop"
  if (reason === "length") return "length"
  if (reason === "content_filter") return "content-filter"
  if (reason === "function_call" || reason === "tool_calls") return "tool-calls"
  return "unknown"
}

// OpenAI Chat reports `prompt_tokens` (inclusive total) with a
// `cached_tokens` subset, and `completion_tokens` (inclusive total) with
// a `reasoning_tokens` subset. We pass the inclusive totals through and
// derive the non-cached breakdown so the `LLM.Usage` contract is
// satisfied on both sides.
const mapUsage = (usage: OpenAIChatEvent["usage"]): Usage | undefined => {
  if (!usage) return undefined
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.prompt_tokens, cached)
  return new Usage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens),
    providerMetadata: { openai: usage },
  })
}

const step = (state: ParserState, event: OpenAIChatEvent) =>
  Effect.gen(function* () {
    const events: LLMEvent[] = []
    const usage = mapUsage(event.usage) ?? state.usage
    const choice = event.choices[0]
    const finishReason = choice?.finish_reason ? mapFinishReason(choice.finish_reason) : state.finishReason
    const delta = choice?.delta
    const toolDeltas = delta?.tool_calls ?? []
    let tools = state.tools

    let lifecycle = state.lifecycle

    if (delta?.reasoning_content)
      lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", delta.reasoning_content)

    if (delta?.content) {
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0")
      lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", delta.content)
    }

    if (toolDeltas.length) lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0")

    for (const tool of toolDeltas) {
      const result = ToolStream.appendOrStart(
        ADAPTER,
        tools,
        tool.index,
        {
          id: Option.getOrUndefined(Option.fromNullishOr(tool.id)),
          name: Option.getOrUndefined(Option.fromNullishOr(tool.function?.name)),
          text: tool.function?.arguments ?? "",
        },
        "OpenAI Chat tool call delta is missing id or name",
      )
      if (ToolStream.isError(result)) return yield* result
      tools = result.tools
      if (result.events.length) lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(...result.events)
    }

    // Finalize accumulated tool inputs eagerly when finish_reason arrives so
    // JSON parse failures fail the stream at the boundary rather than at halt.
    const finished =
      finishReason !== undefined && state.finishReason === undefined && Object.keys(tools).length > 0
        ? Option.some(yield* ToolStream.finishAll(ADAPTER, tools))
        : Option.none()
    const settled = Option.getOrElse(finished, () => ({ tools, events: state.toolCallEvents }))

    return [
      {
        tools: settled.tools,
        toolCallEvents: settled.events,
        usage,
        finishReason,
        lifecycle,
      },
      events,
    ] as const
  })

const finishEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  const hasToolCalls = state.toolCallEvents.length > 0
  const reason = state.finishReason === "stop" && hasToolCalls ? "tool-calls" : state.finishReason
  const lifecycle = state.toolCallEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...state.toolCallEvents)
  if (reason) Lifecycle.finish(lifecycle, events, { reason, usage: state.usage })
  return events
}

// =============================================================================
// Protocol And OpenAI Route
// =============================================================================
/**
 * The OpenAI Chat protocol — request body construction, body schema, and the
 * streaming-event state machine. Reused by every route that speaks OpenAI Chat
 * over HTTP+SSE: native OpenAI, DeepSeek, TogetherAI, Cerebras, Baseten,
 * Fireworks, DeepInfra, and (once added) Azure OpenAI Chat.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIChatBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIChatEvent),
    initial: () => ({ tools: ToolStream.empty<number>(), toolCallEvents: [], lifecycle: Lifecycle.initial() }),
    step,
    onHalt: finishEvents,
  },
})

export const httpTransport = HttpTransport.sseJson.with<OpenAIChatBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as OpenAIChat from "./openai-chat"

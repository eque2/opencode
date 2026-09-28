import { Array as Arr, Effect, Option, Predicate, Schema } from "effect"
import { Route } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  ModelID,
  Usage,
  type CacheHint,
  type ContentPart,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type ModelToolSchemaCompatibility,
  type ProviderMetadata,
  type ReasoningPart,
  type ToolCallPart,
  type ToolContent,
  type ToolDefinition,
  type ToolResultPart,
} from "../schema"
import { BedrockEventStream } from "./bedrock-event-stream"
import { isContextOverflow } from "../provider-error"
import { JsonObject, optionalArray, ProviderShared } from "./shared"
import { BedrockAuth } from "./utils/bedrock-auth"
import { BedrockCache } from "./utils/bedrock-cache"
import { BedrockMedia } from "./utils/bedrock-media"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "bedrock-converse"

export type { Credentials as BedrockCredentials } from "./utils/bedrock-auth"

// =============================================================================
// Request Body Schema
// =============================================================================
// Bedrock carries the tool call id as `toolUseId` in tool-use and tool-result
// blocks and in the streamed `contentBlockStart` event.
const ToolUseId = Schema.String.pipe(Schema.brand("BedrockConverse.ToolUseId"))

const BedrockTextBlock = Schema.Struct({
  text: Schema.String,
}).annotate({ identifier: "BedrockConverse.TextBlock" })
type BedrockTextBlock = Schema.Schema.Type<typeof BedrockTextBlock>

const BedrockToolUseBlock = Schema.Struct({
  toolUse: Schema.Struct({
    toolUseId: ToolUseId,
    name: Schema.String,
    input: Schema.Json,
  }),
}).annotate({ identifier: "BedrockConverse.ToolUseBlock" })
type BedrockToolUseBlock = Schema.Schema.Type<typeof BedrockToolUseBlock>

const BedrockToolResultContentItem = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ json: Schema.Json }),
  BedrockMedia.ImageBlock,
])

const BedrockToolResultBlock = Schema.Struct({
  toolResult: Schema.Struct({
    toolUseId: ToolUseId,
    content: Schema.Array(BedrockToolResultContentItem),
    status: Schema.optional(Schema.Literals(["success", "error"])),
  }),
}).annotate({ identifier: "BedrockConverse.ToolResultBlock" })
type BedrockToolResultBlock = Schema.Schema.Type<typeof BedrockToolResultBlock>

const BedrockReasoningBlock = Schema.Struct({
  reasoningContent: Schema.Struct({
    reasoningText: Schema.optional(
      Schema.Struct({
        text: Schema.String,
        signature: Schema.optional(Schema.String),
      }),
    ),
  }),
}).annotate({ identifier: "BedrockConverse.ReasoningBlock" })

const BedrockUserBlock = Schema.Union([
  BedrockTextBlock,
  BedrockMedia.ImageBlock,
  BedrockMedia.DocumentBlock,
  BedrockToolResultBlock,
  BedrockCache.CachePointBlock,
])
type BedrockUserBlock = Schema.Schema.Type<typeof BedrockUserBlock>

const BedrockAssistantBlock = Schema.Union([
  BedrockTextBlock,
  BedrockReasoningBlock,
  BedrockToolUseBlock,
  BedrockCache.CachePointBlock,
])
type BedrockAssistantBlock = Schema.Schema.Type<typeof BedrockAssistantBlock>

const BedrockMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(BedrockUserBlock) }),
  Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.Array(BedrockAssistantBlock) }),
]).pipe(Schema.toTaggedUnion("role"))
type BedrockMessage = Schema.Schema.Type<typeof BedrockMessage>

const BedrockSystemBlock = Schema.Union([BedrockTextBlock, BedrockCache.CachePointBlock])
type BedrockSystemBlock = Schema.Schema.Type<typeof BedrockSystemBlock>

const BedrockToolSpec = Schema.Struct({
  toolSpec: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    inputSchema: Schema.Struct({
      json: JsonObject,
    }),
  }),
}).annotate({ identifier: "BedrockConverse.ToolSpec" })
type BedrockToolSpec = Schema.Schema.Type<typeof BedrockToolSpec>

const BedrockTool = Schema.Union([BedrockToolSpec, BedrockCache.CachePointBlock])
type BedrockTool = Schema.Schema.Type<typeof BedrockTool>

const BedrockToolChoice = Schema.Union([
  Schema.Struct({ auto: Schema.Struct({}) }),
  Schema.Struct({ any: Schema.Struct({}) }),
  Schema.Struct({ tool: Schema.Struct({ name: Schema.String }) }),
])
type BedrockToolChoice = Schema.Schema.Type<typeof BedrockToolChoice>

const BedrockBodyFields = {
  modelId: ModelID,
  messages: Schema.Array(BedrockMessage),
  system: optionalArray(BedrockSystemBlock),
  inferenceConfig: Schema.optional(
    Schema.Struct({
      maxTokens: Schema.optional(Schema.Number),
      temperature: Schema.optional(Schema.Number),
      topP: Schema.optional(Schema.Number),
      stopSequences: optionalArray(Schema.String),
    }),
  ),
  toolConfig: Schema.optional(
    Schema.Struct({
      tools: Schema.Array(BedrockTool),
      toolChoice: Schema.optional(BedrockToolChoice),
    }),
  ),
  additionalModelRequestFields: Schema.optional(JsonObject),
}
const BedrockConverseBody = Schema.Struct(BedrockBodyFields).annotate({ identifier: "BedrockConverse.Body" })
export type BedrockConverseBody = Schema.Schema.Type<typeof BedrockConverseBody>

const BedrockUsageSchema = Schema.Struct({
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  cacheReadInputTokens: Schema.optional(Schema.Number),
  cacheWriteInputTokens: Schema.optional(Schema.Number),
}).annotate({ identifier: "BedrockConverse.Usage" })
type BedrockUsageSchema = Schema.Schema.Type<typeof BedrockUsageSchema>

// Streaming event shape — the AWS event stream wraps each JSON payload by its
// `:event-type` header (e.g. `messageStart`, `contentBlockDelta`). We
// reconstruct that wrapping in `decodeFrames` below so the event schema can
// stay a plain discriminated record.
const BedrockEvent = Schema.Struct({
  messageStart: Schema.optional(Schema.Struct({ role: Schema.String })),
  contentBlockStart: Schema.optional(
    Schema.Struct({
      contentBlockIndex: Schema.Number,
      start: Schema.optional(
        Schema.Struct({
          toolUse: Schema.optional(Schema.Struct({ toolUseId: ToolUseId, name: Schema.String })),
        }),
      ),
    }),
  ),
  contentBlockDelta: Schema.optional(
    Schema.Struct({
      contentBlockIndex: Schema.Number,
      delta: Schema.optional(
        Schema.Struct({
          text: Schema.optional(Schema.String),
          toolUse: Schema.optional(Schema.Struct({ input: Schema.String })),
          reasoningContent: Schema.optional(
            Schema.Struct({
              text: Schema.optional(Schema.String),
              signature: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
  contentBlockStop: Schema.optional(Schema.Struct({ contentBlockIndex: Schema.Number })),
  messageStop: Schema.optional(
    Schema.Struct({
      stopReason: Schema.String,
      additionalModelResponseFields: Schema.optional(Schema.Json),
    }),
  ),
  metadata: Schema.optional(
    Schema.Struct({
      usage: Schema.optional(BedrockUsageSchema),
      metrics: Schema.optional(Schema.Json),
    }),
  ),
  internalServerException: Schema.optional(Schema.Struct({ message: Schema.String })),
  modelStreamErrorException: Schema.optional(Schema.Struct({ message: Schema.String })),
  validationException: Schema.optional(Schema.Struct({ message: Schema.String })),
  throttlingException: Schema.optional(Schema.Struct({ message: Schema.String })),
  serviceUnavailableException: Schema.optional(Schema.Struct({ message: Schema.String })),
}).annotate({ identifier: "BedrockConverse.Event" })
type BedrockEvent = Schema.Schema.Type<typeof BedrockEvent>

// =============================================================================
// Request Lowering
// =============================================================================
const lowerToolSpec = (tool: ToolDefinition, inputSchema: JsonSchema): BedrockToolSpec => ({
  toolSpec: {
    name: tool.name,
    description: tool.description,
    inputSchema: { json: inputSchema },
  },
})

const lowerTools = (
  compatibility: ModelToolSchemaCompatibility | undefined,
  breakpoints: BedrockCache.Breakpoints,
  tools: ReadonlyArray<ToolDefinition>,
): BedrockTool[] => {
  const result: BedrockTool[] = []
  for (const tool of tools) {
    result.push(lowerToolSpec(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, compatibility)))
    const cachePoint = BedrockCache.block(breakpoints, tool.cache)
    if (cachePoint) result.push(cachePoint)
  }
  return result
}

const textWithCache = (
  breakpoints: BedrockCache.Breakpoints,
  text: string,
  cache: CacheHint | undefined,
): Array<BedrockTextBlock | BedrockCache.CachePointBlock> => {
  const cachePoint = BedrockCache.block(breakpoints, cache)
  return cachePoint ? [{ text }, cachePoint] : [{ text }]
}

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Bedrock Converse", toolChoice, {
    auto: (): Option.Option<BedrockToolChoice> => Option.some({ auto: {} }),
    none: (): Option.Option<BedrockToolChoice> => Option.none(),
    required: (): Option.Option<BedrockToolChoice> => Option.some({ any: {} }),
    tool: (name): Option.Option<BedrockToolChoice> => Option.some({ tool: { name } }),
  })

const bedrockMetadata = (metadata: Schema.JsonObject): ProviderMetadata => ({ bedrock: metadata })

const metadataSignature = (part: ReasoningPart) => {
  const bedrock = part.providerMetadata?.bedrock
  return ProviderShared.isRecord(bedrock) ? Option.liftPredicate(bedrock.signature, Predicate.isString) : Option.none()
}

const reasoningSignature = (part: ReasoningPart) =>
  Option.orElse(Option.fromNullishOr(part.encrypted), () => metadataSignature(part))

const reasoningText = (part: ReasoningPart) =>
  Option.match(reasoningSignature(part), {
    onNone: () => ({ text: part.text }),
    onSome: (signature) => ({ text: part.text, signature }),
  })

// Tool inputs and JSON tool results are `unknown` in the common model. Encode
// them as the request body will, then read the text back as Schema.Json:
// undefined-valued keys drop out and Dates become strings, exactly as on the
// wire. A value that JSON cannot represent yields Option.none().
const WireJson = Schema.fromJsonString(Schema.Json)
const toWireJson = (value: unknown) =>
  Option.flatMap(Schema.encodeUnknownOption(ProviderShared.Json)(value), Schema.decodeUnknownOption(WireJson))

const lowerToolCall = Effect.fn("BedrockConverse.lowerToolCall")(function* (part: ToolCallPart) {
  const input = toWireJson(part.input)
  if (Option.isNone(input))
    return yield* ProviderShared.invalidRequest(`Bedrock Converse tool call ${part.name} input must be JSON`)
  return {
    toolUse: { toolUseId: ToolUseId.make(part.id), name: part.name, input: input.value },
  } satisfies BedrockToolUseBlock
})

const lowerToolResultItem = Effect.fn("BedrockConverse.lowerToolResultItem")(function* (item: ToolContent) {
  if (item.type === "text") return { text: item.text }
  const media = yield* BedrockMedia.lower({
    type: "media",
    mediaType: item.mime,
    data: item.uri,
    filename: item.name,
  })
  if (!("image" in media))
    return yield* ProviderShared.invalidRequest("Bedrock Converse only supports image media in tool results")
  return media
})

const lowerToolResultContent = Effect.fn("BedrockConverse.lowerToolResultContent")(function* (part: ToolResultPart) {
  if (part.result.type === "text" || part.result.type === "error")
    return [{ text: ProviderShared.toolResultText(part) }]
  if (part.result.type === "json") {
    const json = toWireJson(part.result.value)
    if (Option.isNone(json))
      return yield* ProviderShared.invalidRequest(`Bedrock Converse tool result ${part.name} must be JSON`)
    return [{ json: json.value }]
  }
  return yield* Effect.forEach(part.result.value, lowerToolResultItem)
})

const lowerToolResult = Effect.fn("BedrockConverse.lowerToolResult")(function* (part: ToolResultPart) {
  return {
    toolResult: {
      toolUseId: ToolUseId.make(part.id),
      content: yield* lowerToolResultContent(part),
      status: part.result.type === "error" ? "error" : "success",
    },
  } satisfies BedrockToolResultBlock
})

const lowerUserPart = Effect.fn("BedrockConverse.lowerUserPart")(function* (
  breakpoints: BedrockCache.Breakpoints,
  part: ContentPart,
) {
  if (!ProviderShared.supportsContent(part, ["text", "media"]))
    return yield* ProviderShared.unsupportedContent("Bedrock Converse", "user", ["text", "media"])
  if (part.type === "text") return textWithCache(breakpoints, part.text, part.cache)
  return [yield* BedrockMedia.lower(part)]
})

const lowerAssistantPart = Effect.fn("BedrockConverse.lowerAssistantPart")(function* (
  breakpoints: BedrockCache.Breakpoints,
  part: ContentPart,
) {
  if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
    return yield* ProviderShared.unsupportedContent("Bedrock Converse", "assistant", ["text", "reasoning", "tool-call"])
  if (part.type === "text") return textWithCache(breakpoints, part.text, part.cache)
  if (part.type === "reasoning") return [{ reasoningContent: { reasoningText: reasoningText(part) } }]
  return [yield* lowerToolCall(part)]
})

const lowerToolPart = Effect.fn("BedrockConverse.lowerToolPart")(function* (
  breakpoints: BedrockCache.Breakpoints,
  part: ContentPart,
) {
  if (!ProviderShared.supportsContent(part, ["tool-result"]))
    return yield* ProviderShared.unsupportedContent("Bedrock Converse", "tool", ["tool-result"])
  const result = yield* lowerToolResult(part)
  const cachePoint = BedrockCache.block(breakpoints, part.cache)
  return cachePoint ? [result, cachePoint] : [result]
})

// A chronological system update lowers to user text. It joins a directly
// preceding user turn instead of opening a second consecutive user turn.
interface LoweredMessage {
  readonly message: BedrockMessage
  readonly joinsPreviousUser: boolean
}

const lowerMessage = Effect.fn("BedrockConverse.lowerMessage")(function* (
  breakpoints: BedrockCache.Breakpoints,
  message: LLMRequest["messages"][number],
) {
  if (message.role === "system") {
    const part = yield* ProviderShared.wrappedSystemUpdate("Bedrock Converse", message)
    return {
      message: { role: "user", content: textWithCache(breakpoints, part.text, part.cache) },
      joinsPreviousUser: true,
    } satisfies LoweredMessage
  }
  if (message.role === "user") {
    const content = yield* Effect.forEach(message.content, (part) => lowerUserPart(breakpoints, part))
    return { message: { role: "user", content: content.flat() }, joinsPreviousUser: false } satisfies LoweredMessage
  }
  if (message.role === "assistant") {
    const content = yield* Effect.forEach(message.content, (part) => lowerAssistantPart(breakpoints, part))
    return {
      message: { role: "assistant", content: content.flat() },
      joinsPreviousUser: false,
    } satisfies LoweredMessage
  }
  const content = yield* Effect.forEach(message.content, (part) => lowerToolPart(breakpoints, part))
  return { message: { role: "user", content: content.flat() }, joinsPreviousUser: false } satisfies LoweredMessage
})

const appendMessage = (
  messages: ReadonlyArray<BedrockMessage>,
  lowered: LoweredMessage,
): ReadonlyArray<BedrockMessage> => {
  const previous = messages.at(-1)
  if (lowered.joinsPreviousUser && previous?.role === "user" && lowered.message.role === "user")
    return [...messages.slice(0, -1), { role: "user", content: [...previous.content, ...lowered.message.content] }]
  return [...messages, lowered.message]
}

const noMessages: ReadonlyArray<BedrockMessage> = []

const lowerMessages = Effect.fn("BedrockConverse.lowerMessages")(function* (
  request: LLMRequest,
  breakpoints: BedrockCache.Breakpoints,
) {
  const lowered = yield* Effect.forEach(request.messages, (message) => lowerMessage(breakpoints, message))
  return lowered.reduce(appendMessage, noMessages)
})

// System prompts share the cache-point convention: emit the text block, then
// optionally a positional `cachePoint` marker.
const lowerSystem = (
  breakpoints: BedrockCache.Breakpoints,
  system: ReadonlyArray<LLMRequest["system"][number]>,
): BedrockSystemBlock[] => system.flatMap((part) => textWithCache(breakpoints, part.text, part.cache))

const fromRequest = Effect.fn("BedrockConverse.fromRequest")(function* (request: LLMRequest) {
  const toolChoice: Option.Option<BedrockToolChoice> = request.toolChoice
    ? yield* lowerToolChoice(request.toolChoice)
    : Option.none()
  const generation = request.generation
  // Bedrock-Claude shares Anthropic's 4-breakpoint cap. Spend the budget in
  // tools → system → messages order to favour the highest-impact prefixes.
  const breakpoints = BedrockCache.breakpoints()
  const toolsEnabled = request.tools.length > 0 && request.toolChoice?.type !== "none"
  const tools = toolsEnabled ? lowerTools(request.model.compatibility?.toolSchema, breakpoints, request.tools) : []
  const system = lowerSystem(breakpoints, request.system)
  const messages = yield* lowerMessages(request, breakpoints)
  if (breakpoints.dropped > 0) {
    yield* Effect.logWarning(
      `Bedrock Converse: dropped ${breakpoints.dropped} cache breakpoint(s); the API allows at most ${BedrockCache.BEDROCK_BREAKPOINT_CAP} per request.`,
    )
  }
  return {
    modelId: request.model.id,
    messages,
    ...(system.length === 0 ? {} : { system }),
    ...(generation?.maxTokens === undefined &&
    generation?.temperature === undefined &&
    generation?.topP === undefined &&
    (generation?.stop === undefined || generation.stop.length === 0)
      ? {}
      : {
          inferenceConfig: {
            maxTokens: generation?.maxTokens,
            temperature: generation?.temperature,
            topP: generation?.topP,
            stopSequences: generation?.stop,
          },
        }),
    ...(toolsEnabled
      ? {
          toolConfig: {
            tools,
            ...Option.match(toolChoice, {
              onNone: () => ({}),
              onSome: (choice) => ({ toolChoice: choice }),
            }),
          },
        }
      : {}),
    // Converse's base inferenceConfig has no topK; Anthropic/Nova accept it
    // as a model-specific field, so it goes through additionalModelRequestFields.
    ...(generation?.topK === undefined ? {} : { additionalModelRequestFields: { top_k: generation.topK } }),
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
const mapFinishReason = (reason: string): FinishReason => {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop"
  if (reason === "max_tokens") return "length"
  if (reason === "tool_use") return "tool-calls"
  if (reason === "content_filtered" || reason === "guardrail_intervened") return "content-filter"
  return "unknown"
}

// AWS Bedrock Converse reports `inputTokens` (inclusive total) with
// `cacheReadInputTokens` and `cacheWriteInputTokens` as subsets. Pass
// the total through and derive the non-cached breakdown. Bedrock does
// not break reasoning out of `outputTokens` for any current model.
const mapUsage = (usage: BedrockUsageSchema): Usage => {
  const cacheTotal = (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)
  const nonCached = ProviderShared.subtractTokens(usage.inputTokens, cacheTotal)
  return new Usage({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    totalTokens: ProviderShared.totalTokens(usage.inputTokens, usage.outputTokens, usage.totalTokens),
    providerMetadata: { bedrock: usage },
  })
}

interface PendingFinish {
  readonly reason: FinishReason
  readonly usage: Option.Option<Usage>
}

interface ParserState {
  readonly tools: ToolStream.State<number>
  // Bedrock splits the finish into `messageStop` (carries `stopReason`) and
  // `metadata` (carries usage). Hold the terminal event in state so `onHalt`
  // can emit exactly one finish after both chunks have had a chance to arrive.
  readonly pendingFinish: Option.Option<PendingFinish>
  readonly hasToolCalls: boolean
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignatures: Readonly<Record<number, string>>
}

const step = (state: ParserState, event: BedrockEvent) =>
  Effect.gen(function* () {
    if (event.contentBlockStart?.start?.toolUse) {
      const index = event.contentBlockStart.contentBlockIndex
      const [lifecycle, started] = Lifecycle.stepStart(state.lifecycle)
      return [
        {
          ...state,
          lifecycle,
          tools: ToolStream.start(state.tools, index, {
            id: event.contentBlockStart.start.toolUse.toolUseId,
            name: event.contentBlockStart.start.toolUse.name,
          }),
        },
        Arr.append(
          started,
          LLMEvent.toolInputStart({
            id: event.contentBlockStart.start.toolUse.toolUseId,
            name: event.contentBlockStart.start.toolUse.name,
          }),
        ),
      ] as const
    }

    if (event.contentBlockDelta?.delta?.text) {
      const [lifecycle, events] = Lifecycle.textDelta(
        state.lifecycle,
        `text-${event.contentBlockDelta.contentBlockIndex}`,
        event.contentBlockDelta.delta.text,
      )
      return [{ ...state, lifecycle }, events] as const
    }

    if (event.contentBlockDelta?.delta?.reasoningContent) {
      const index = event.contentBlockDelta.contentBlockIndex
      const reasoning = event.contentBlockDelta.delta.reasoningContent
      const [lifecycle, events] = reasoning.text
        ? Lifecycle.reasoningDelta(state.lifecycle, `reasoning-${index}`, reasoning.text)
        : Lifecycle.unchanged(state.lifecycle)
      return [
        {
          ...state,
          lifecycle,
          reasoningSignatures: reasoning.signature
            ? { ...state.reasoningSignatures, [index]: reasoning.signature }
            : state.reasoningSignatures,
        },
        events,
      ] as const
    }

    if (event.contentBlockDelta?.delta?.toolUse) {
      const index = event.contentBlockDelta.contentBlockIndex
      const result = ToolStream.appendExisting(
        ADAPTER,
        state.tools,
        index,
        event.contentBlockDelta.delta.toolUse.input,
        "Bedrock Converse tool delta is missing its tool call",
      )
      if (ToolStream.isError(result)) return yield* result
      const [lifecycle, events] = Lifecycle.emit(state.lifecycle, result.events)
      return [{ ...state, lifecycle, tools: result.tools }, events] as const
    }

    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex
      const result = yield* ToolStream.finish(ADAPTER, state.tools, index)
      const resultEvents = result.events ?? []
      const reasoningMetadata = Option.getOrUndefined(
        Option.map(Option.fromNullishOr(state.reasoningSignatures[index]), (signature) =>
          bedrockMetadata({ signature }),
        ),
      )
      const [lifecycle, events] = resultEvents.length
        ? Lifecycle.emit(state.lifecycle, resultEvents)
        : Lifecycle.andThen(Lifecycle.textEnd(state.lifecycle, `text-${index}`), (closed) =>
            Lifecycle.reasoningEnd(closed, `reasoning-${index}`, reasoningMetadata),
          )
      return [
        {
          ...state,
          hasToolCalls: resultEvents.some(LLMEvent.is.toolCall) ? true : state.hasToolCalls,
          lifecycle,
          tools: result.tools,
          reasoningSignatures: Object.fromEntries(
            Object.entries(state.reasoningSignatures).filter(([key]) => key !== String(index)),
          ),
        },
        events,
      ] as const
    }

    if (event.messageStop) {
      return [
        {
          ...state,
          pendingFinish: Option.some({
            reason: mapFinishReason(event.messageStop.stopReason),
            usage: Option.flatMap(state.pendingFinish, (pending) => pending.usage),
          }),
        },
        [],
      ] as const
    }

    if (event.metadata) {
      const pendingFinish: PendingFinish = {
        reason: Option.getOrElse(
          Option.map(state.pendingFinish, (pending) => pending.reason),
          (): FinishReason => "stop",
        ),
        usage: Option.map(Option.fromNullishOr(event.metadata.usage), mapUsage),
      }
      return [{ ...state, pendingFinish: Option.some(pendingFinish) }, []] as const
    }

    if (event.internalServerException || event.modelStreamErrorException || event.serviceUnavailableException) {
      const message =
        event.internalServerException?.message ??
        event.modelStreamErrorException?.message ??
        event.serviceUnavailableException?.message ??
        "Bedrock Converse stream error"
      return [state, [LLMEvent.providerError({ message, retryable: true })]] as const
    }

    if (event.validationException || event.throttlingException) {
      const message =
        event.validationException?.message ?? event.throttlingException?.message ?? "Bedrock Converse error"
      return [
        state,
        [
          LLMEvent.providerError({
            message,
            ...(event.validationException && isContextOverflow(message)
              ? { classification: "context-overflow" as const }
              : {}),
            retryable: event.throttlingException !== undefined,
          }),
        ],
      ] as const
    }

    return [state, []] as const
  })

const framing = BedrockEventStream.framing(ADAPTER)

const onHalt = (state: ParserState): ReadonlyArray<LLMEvent> =>
  Option.match(state.pendingFinish, {
    onNone: () => [],
    onSome: (pending) => {
      const [, events] = Lifecycle.finish(state.lifecycle, {
        reason: pending.reason === "stop" && state.hasToolCalls ? "tool-calls" : pending.reason,
        usage: Option.getOrUndefined(pending.usage),
      })
      return events
    },
  })

// =============================================================================
// Protocol And Bedrock Route
// =============================================================================
/**
 * The Bedrock Converse protocol — request body construction, body schema, and
 * the streaming-event state machine.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: BedrockConverseBody,
    from: fromRequest,
  },
  stream: {
    event: BedrockEvent,
    initial: () => ({
      tools: ToolStream.empty<number>(),
      pendingFinish: Option.none(),
      hasToolCalls: false,
      lifecycle: Lifecycle.initial(),
      reasoningSignatures: {},
    }),
    step,
    onHalt,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "bedrock",
  protocol,
  // Bedrock's URL embeds the region in the route endpoint host and the
  // validated modelId in the path. We read the validated body so the URL
  // matches the body that gets signed.
  endpoint: Endpoint.path<BedrockConverseBody>(
    ({ body }) => `/model/${encodeURIComponent(body.modelId)}/converse-stream`,
  ),
  auth: BedrockAuth.auth,
  framing,
})

export const sigV4Auth = BedrockAuth.sigV4

export * as BedrockConverse from "./bedrock-converse"

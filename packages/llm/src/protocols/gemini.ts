import { Array as Arr, Effect, HashSet, Option, Predicate, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type ContentPart,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type ProviderMetadata,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { JsonObject, optionalArray, ProviderShared } from "./shared"
import { GeminiToolSchema } from "./utils/gemini-tool-schema"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"

const ADAPTER = "gemini"
const MEDIA_MIMES = HashSet.fromIterable(ProviderShared.MEDIA_MIMES)
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// =============================================================================
// Request Body Schema
// =============================================================================
const GeminiTextPart = Schema.Struct({
  text: Schema.String,
  thought: Schema.optional(Schema.Boolean),
  thoughtSignature: Schema.optional(Schema.String),
}).annotate({ identifier: "Gemini.TextPart" })

const GeminiInlineDataPart = Schema.Struct({
  inlineData: Schema.Struct({
    mimeType: Schema.String,
    data: Schema.String,
  }),
}).annotate({ identifier: "Gemini.InlineDataPart" })

const GeminiFunctionCallPart = Schema.Struct({
  functionCall: Schema.Struct({
    name: Schema.String,
    args: Schema.Json,
  }),
  thoughtSignature: Schema.optional(Schema.String),
}).annotate({ identifier: "Gemini.FunctionCallPart" })

const GeminiFunctionResponsePart = Schema.Struct({
  functionResponse: Schema.Struct({
    name: Schema.String,
    response: Schema.JsonObject,
  }),
}).annotate({ identifier: "Gemini.FunctionResponsePart" })

const GeminiContentPart = Schema.Union([
  GeminiTextPart,
  GeminiInlineDataPart,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
])

const GeminiContent = Schema.Struct({
  role: Schema.Literals(["user", "model"]),
  parts: Schema.Array(GeminiContentPart),
}).annotate({ identifier: "Gemini.Content" })
type GeminiContent = Schema.Schema.Type<typeof GeminiContent>

const GeminiSystemInstruction = Schema.Struct({
  parts: Schema.Array(Schema.Struct({ text: Schema.String })),
}).annotate({ identifier: "Gemini.SystemInstruction" })

const GeminiFunctionDeclaration = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optional(JsonObject),
}).annotate({ identifier: "Gemini.FunctionDeclaration" })

const GeminiTool = Schema.Struct({
  functionDeclarations: Schema.Array(GeminiFunctionDeclaration),
}).annotate({ identifier: "Gemini.Tool" })

const GeminiToolConfig = Schema.Struct({
  functionCallingConfig: Schema.Struct({
    mode: Schema.Literals(["AUTO", "NONE", "ANY"]),
    allowedFunctionNames: optionalArray(Schema.String),
  }),
}).annotate({ identifier: "Gemini.ToolConfig" })

const GeminiThinkingConfig = Schema.Struct({
  thinkingBudget: Schema.optional(Schema.Number),
  includeThoughts: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Gemini.ThinkingConfig" })

type GeminiThinkingConfig = Schema.Schema.Type<typeof GeminiThinkingConfig>

const GeminiGenerationConfig = Schema.Struct({
  maxOutputTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  stopSequences: optionalArray(Schema.String),
  thinkingConfig: Schema.optional(GeminiThinkingConfig),
}).annotate({ identifier: "Gemini.GenerationConfig" })

const GeminiBodyFields = {
  contents: Schema.Array(GeminiContent),
  systemInstruction: Schema.optional(GeminiSystemInstruction),
  tools: optionalArray(GeminiTool),
  toolConfig: Schema.optional(GeminiToolConfig),
  generationConfig: Schema.optional(GeminiGenerationConfig),
}
const GeminiBody = Schema.Struct(GeminiBodyFields).annotate({ identifier: "Gemini.Body" })
export type GeminiBody = Schema.Schema.Type<typeof GeminiBody>

const GeminiUsage = Schema.Struct({
  cachedContentTokenCount: Schema.optional(Schema.Number),
  thoughtsTokenCount: Schema.optional(Schema.Number),
  promptTokenCount: Schema.optional(Schema.Number),
  candidatesTokenCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
}).annotate({ identifier: "Gemini.Usage" })
type GeminiUsage = Schema.Schema.Type<typeof GeminiUsage>

const GeminiCandidate = Schema.Struct({
  content: Schema.optional(GeminiContent),
  finishReason: Schema.optional(Schema.String),
}).annotate({ identifier: "Gemini.Candidate" })

const GeminiEvent = Schema.Struct({
  candidates: optionalArray(GeminiCandidate),
  usageMetadata: Schema.optional(GeminiUsage),
}).annotate({ identifier: "Gemini.Event" })
type GeminiEvent = Schema.Schema.Type<typeof GeminiEvent>

interface ParserState {
  readonly finishReason?: string
  readonly hasToolCalls: boolean
  readonly nextToolCallId: number
  readonly usage?: Usage
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignature?: string
}

// =============================================================================
// Tool Schema Conversion
// =============================================================================
// Tool-schema conversion has two distinct concerns:
//
// 1. Sanitize — fix common authoring mistakes Gemini rejects: integer/number
//    enums (must be strings), `required` entries that don't match a property,
//    untyped arrays (`items` must be present), and `properties`/`required`
//    keys on non-object scalars. Mirrors OpenCode's historical Gemini rules.
//
// 2. Project — lossy mapping from JSON Schema to Gemini's schema dialect:
//    drop empty objects, derive `nullable: true` from `type: [..., "null"]`,
//    coerce `const` to `[const]` enum, recurse properties/items, propagate
//    only an allowlisted set of keys (description, required, format, type,
//    properties, items, allOf, anyOf, oneOf, minLength). Anything outside the
//    allowlist (e.g. `additionalProperties`, `$ref`) is silently dropped.
//
// Sanitize runs first, then project. The implementation lives in
// `utils/gemini-tool-schema` so this protocol keeps the same shape as the other
// provider protocols.

// =============================================================================
// Request Lowering
// =============================================================================
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema) => ({
  name: tool.name,
  description: tool.description,
  parameters: GeminiToolSchema.convert(inputSchema),
})

const lowerToolConfig = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Gemini", toolChoice, {
    auto: () => ({ functionCallingConfig: { mode: "AUTO" as const } }),
    none: () => ({ functionCallingConfig: { mode: "NONE" as const } }),
    required: () => ({ functionCallingConfig: { mode: "ANY" as const } }),
    tool: (name) => ({ functionCallingConfig: { mode: "ANY" as const, allowedFunctionNames: [name] } }),
  })

const lowerUserPart = Effect.fn("Gemini.lowerUserPart")(function* (part: ContentPart) {
  if (!ProviderShared.supportsContent(part, ["text", "media"]))
    return yield* ProviderShared.unsupportedContent("Gemini", "user", ["text", "media"])
  if (part.type === "text") return { text: part.text }
  const media = yield* ProviderShared.validateMedia("Gemini", part, MEDIA_MIMES)
  return { inlineData: { mimeType: media.mime, data: media.base64 } }
})

const googleMetadata = (metadata: Schema.JsonObject): ProviderMetadata => ({ google: metadata })

const thoughtSignature = (providerMetadata: ProviderMetadata | undefined) =>
  Option.fromNullishOr(providerMetadata?.google?.thoughtSignature).pipe(Option.filter(Predicate.isString))

// Gemini attaches a thought signature to reasoning and function-call parts.
// Carry a non-empty one forward as google provider metadata.
const signatureMetadata = (signature: string | undefined) =>
  Option.getOrUndefined(
    Option.fromUndefinedOr(signature).pipe(
      Option.filter((value) => value.length > 0),
      Option.map((value) => googleMetadata({ thoughtSignature: value })),
    ),
  )

// Function-call args are provider wire JSON. Narrow the common model's untyped
// input here so a non-JSON value fails as an invalid request instead of being
// coerced by JSON encoding.
const isJson = Schema.is(Schema.Json)

const lowerToolCall = Effect.fn("Gemini.lowerToolCall")(function* (part: ToolCallPart) {
  if (!isJson(part.input))
    return yield* ProviderShared.invalidRequest(`Gemini tool call ${part.name} input must be JSON`)
  return {
    functionCall: { name: part.name, args: part.input },
    thoughtSignature: Option.getOrUndefined(thoughtSignature(part.providerMetadata)),
  }
})

const lowerModelPart = Effect.fn("Gemini.lowerModelPart")(function* (part: ContentPart) {
  if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
    return yield* ProviderShared.unsupportedContent("Gemini", "assistant", ["text", "reasoning", "tool-call"])
  if (part.type === "text") return { text: part.text }
  if (part.type === "reasoning")
    return {
      text: part.text,
      thought: true,
      thoughtSignature: Option.getOrUndefined(thoughtSignature(part.providerMetadata)),
    }
  return yield* lowerToolCall(part)
})

// One tool result lowers to a functionResponse part with the joined text, then
// one inlineData part for each media item, in content order.
const lowerToolResultParts = Effect.fn("Gemini.lowerToolResultParts")(function* (part: ContentPart) {
  if (!ProviderShared.supportsContent(part, ["tool-result"]))
    return yield* ProviderShared.unsupportedContent("Gemini", "tool", ["tool-result"])
  if (part.result.type !== "content")
    return [
      {
        functionResponse: {
          name: part.name,
          response: {
            name: part.name,
            content: ProviderShared.toolResultText(part),
          },
        },
      },
    ]
  const content: ReadonlyArray<ToolContent> = part.result.value
  const text = content.filter((item) => item.type === "text").map((item) => item.text)
  const media = yield* Effect.forEach(
    content.filter((item) => item.type !== "text"),
    (item) => ProviderShared.validateToolFile("Gemini", item, MEDIA_MIMES),
  )
  return [
    {
      functionResponse: {
        name: part.name,
        response: {
          name: part.name,
          content: text.join("\n"),
        },
      },
    },
    ...media.map((file) => ({ inlineData: { mimeType: file.mime, data: file.base64 } })),
  ]
})

// A wrapped system update joins the previous user turn when there is one, so
// the lowered conversation keeps alternating user and model turns.
const appendUserText = (contents: ReadonlyArray<GeminiContent>, text: string): ReadonlyArray<GeminiContent> => {
  const previous = contents.at(-1)
  if (previous?.role === "user")
    return Arr.append(contents.slice(0, -1), { role: "user" as const, parts: Arr.append(previous.parts, { text }) })
  return Arr.append(contents, { role: "user" as const, parts: [{ text }] })
}

const lowerMessage = Effect.fn("Gemini.lowerMessage")(function* (
  contents: ReadonlyArray<GeminiContent>,
  message: LLMRequest["messages"][number],
) {
  if (message.role === "system") {
    const part = yield* ProviderShared.wrappedSystemUpdate("Gemini", message)
    return appendUserText(contents, part.text)
  }
  if (message.role === "user")
    return Arr.append(contents, {
      role: "user" as const,
      parts: yield* Effect.forEach(message.content, (part) => lowerUserPart(part)),
    })
  if (message.role === "assistant")
    return Arr.append(contents, {
      role: "model" as const,
      parts: yield* Effect.forEach(message.content, (part) => lowerModelPart(part)),
    })
  const parts = yield* Effect.forEach(message.content, (part) => lowerToolResultParts(part))
  return Arr.append(contents, { role: "user" as const, parts: parts.flat() })
})

const lowerMessages = Effect.fn("Gemini.lowerMessages")(function* (request: LLMRequest) {
  return yield* Effect.reduce(
    request.messages,
    (): ReadonlyArray<GeminiContent> => [],
    (contents, message) => lowerMessage(contents, message),
  )
})

const geminiOptions = (request: LLMRequest) => request.providerOptions?.gemini

const thinkingConfig = (request: LLMRequest): Option.Option<GeminiThinkingConfig> => {
  const value = geminiOptions(request)?.thinkingConfig
  if (!ProviderShared.isRecord(value)) return Option.none()
  const result = {
    ...(Predicate.isNumber(value.thinkingBudget) ? { thinkingBudget: value.thinkingBudget } : {}),
    ...(Predicate.isBoolean(value.includeThoughts) ? { includeThoughts: value.includeThoughts } : {}),
  }
  return Object.keys(result).length > 0 ? Option.some(result) : Option.none()
}

const fromRequest = Effect.fn("Gemini.fromRequest")(function* (request: LLMRequest) {
  const toolsEnabled = request.tools.length > 0 && request.toolChoice?.type !== "none"
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const generationConfig = {
    maxOutputTokens: generation?.maxTokens,
    temperature: generation?.temperature,
    topP: generation?.topP,
    topK: generation?.topK,
    stopSequences: generation?.stop,
    thinkingConfig: Option.getOrUndefined(thinkingConfig(request)),
  }

  return {
    contents: yield* lowerMessages(request),
    ...(request.system.length === 0
      ? {}
      : { systemInstruction: { parts: [{ text: ProviderShared.joinText(request.system) }] } }),
    ...(toolsEnabled
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) =>
                lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
              ),
            },
          ],
        }
      : {}),
    ...(toolsEnabled && request.toolChoice ? { toolConfig: yield* lowerToolConfig(request.toolChoice) } : {}),
    ...(Object.values(generationConfig).some((value) => value !== undefined) ? { generationConfig } : {}),
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Gemini reports `promptTokenCount` (inclusive total) with a
// `cachedContentTokenCount` subset. `candidatesTokenCount` is *exclusive*
// of `thoughtsTokenCount` — visible-only, not a total — so we sum the two
// to produce the inclusive `outputTokens` the rest of the contract expects.
const mapUsage = (usage: GeminiUsage | undefined) => {
  if (!usage) return undefined
  const cached = usage.cachedContentTokenCount
  const nonCached = ProviderShared.subtractTokens(usage.promptTokenCount, cached)
  // `candidatesTokenCount` is visible-only; sum with thoughts to produce the
  // inclusive `outputTokens` the contract expects. Only compute the total
  // when the visible component is reported — otherwise we'd fabricate an
  // inclusive number from a partial breakdown.
  const outputTokens = Option.getOrUndefined(
    Option.map(
      Option.fromUndefinedOr(usage.candidatesTokenCount),
      (visible) => visible + (usage.thoughtsTokenCount ?? 0),
    ),
  )
  return new Usage({
    inputTokens: usage.promptTokenCount,
    outputTokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: usage.thoughtsTokenCount,
    totalTokens: ProviderShared.totalTokens(usage.promptTokenCount, outputTokens, usage.totalTokenCount),
    providerMetadata: { google: usage },
  })
}

const mapFinishReason = (finishReason: string | undefined, hasToolCalls: boolean): FinishReason => {
  if (finishReason === "STOP") return hasToolCalls ? "tool-calls" : "stop"
  if (finishReason === "MAX_TOKENS") return "length"
  if (
    finishReason === "IMAGE_SAFETY" ||
    finishReason === "RECITATION" ||
    finishReason === "SAFETY" ||
    finishReason === "BLOCKLIST" ||
    finishReason === "PROHIBITED_CONTENT" ||
    finishReason === "SPII"
  )
    return "content-filter"
  if (finishReason === "MALFORMED_FUNCTION_CALL") return "error"
  return "unknown"
}

const finish = (state: ParserState): ReadonlyArray<LLMEvent> =>
  state.finishReason || state.usage
    ? (() => {
        const events: LLMEvent[] = []
        const lifecycle = state.reasoningSignature
          ? Lifecycle.reasoningEnd(
              state.lifecycle,
              events,
              "reasoning-0",
              googleMetadata({ thoughtSignature: state.reasoningSignature }),
            )
          : state.lifecycle
        Lifecycle.finish(lifecycle, events, {
          reason: mapFinishReason(state.finishReason, state.hasToolCalls),
          usage: state.usage,
        })
        return events
      })()
    : []

const step = (state: ParserState, event: GeminiEvent) => {
  const nextState = {
    ...state,
    usage: event.usageMetadata ? (mapUsage(event.usageMetadata) ?? state.usage) : state.usage,
  }
  const candidate = event.candidates?.[0]
  if (!candidate?.content)
    return Effect.succeed([
      { ...nextState, finishReason: candidate?.finishReason ?? nextState.finishReason },
      [],
    ] as const)

  const events: LLMEvent[] = []
  let hasToolCalls = nextState.hasToolCalls
  let lifecycle = nextState.lifecycle
  let nextToolCallId = nextState.nextToolCallId
  let reasoningSignature = nextState.reasoningSignature

  for (const part of candidate.content.parts) {
    if ("thoughtSignature" in part && part.thoughtSignature && "thought" in part && part.thought)
      reasoningSignature = part.thoughtSignature
    if ("text" in part && part.text.length > 0) {
      if (part.thought) {
        lifecycle = Lifecycle.reasoningDelta(
          lifecycle,
          events,
          "reasoning-0",
          part.text,
          signatureMetadata(part.thoughtSignature),
        )
        continue
      }
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0", signatureMetadata(reasoningSignature))
      lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", part.text)
      continue
    }

    if ("functionCall" in part) {
      const input = part.functionCall.args
      const id = `tool_${nextToolCallId++}`
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0", signatureMetadata(reasoningSignature))
      lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(
        LLMEvent.toolCall({
          id,
          name: part.functionCall.name,
          input,
          providerMetadata: signatureMetadata(part.thoughtSignature),
        }),
      )
      hasToolCalls = true
    }
  }

  return Effect.succeed([
    {
      ...nextState,
      hasToolCalls,
      lifecycle,
      nextToolCallId,
      reasoningSignature,
      finishReason: candidate.finishReason ?? nextState.finishReason,
    },
    events,
  ] as const)
}

// =============================================================================
// Protocol And Gemini Route
// =============================================================================
/**
 * The Gemini protocol — request body construction, body schema, and the
 * streaming-event state machine. Used by Google AI Studio Gemini and (once
 * registered) Vertex Gemini.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: GeminiBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(GeminiEvent),
    initial: () => ({ hasToolCalls: false, nextToolCallId: 0, lifecycle: Lifecycle.initial() }),
    step,
    onHalt: finish,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "google",
  protocol,
  // Gemini's path embeds the model id and pins SSE framing at the URL level.
  endpoint: Endpoint.path(({ request }) => `/models/${request.model.id}:streamGenerateContent?alt=sse`, {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  framing: Framing.sse,
})

export * as Gemini from "./gemini"

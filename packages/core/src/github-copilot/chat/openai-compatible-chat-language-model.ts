import {
  APICallError,
  InvalidResponseDataError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3StreamPart,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import {
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonErrorResponseHandler,
  createJsonResponseHandler,
  type FetchFunction,
  generateId,
  isParsableJson,
  parseProviderOptions,
  type ParseResult,
  postJsonToApi,
  type ResponseHandler,
} from "@ai-sdk/provider-utils"
import { Effect, Option, Predicate, Schema } from "effect"
import { convertToOpenAICompatibleChatMessages } from "./convert-to-openai-compatible-chat-messages"
import { getResponseMetadata } from "./get-response-metadata"
import { mapOpenAICompatibleFinishReason } from "./map-openai-compatible-finish-reason"
import { type OpenAICompatibleChatModelId, openaiCompatibleProviderOptions } from "./openai-compatible-chat-options"
import {
  defaultOpenAICompatibleErrorStructure,
  type OpenAICompatibleErrorData,
  type ProviderErrorStructure,
} from "../openai-compatible-error"
import type { MetadataExtractor } from "./openai-compatible-metadata-extractor"
import { prepareTools } from "./openai-compatible-prepare-tools"

export type OpenAICompatibleChatConfig = {
  provider: string
  headers: () => Record<string, string | undefined>
  url: (options: { modelId: string; path: string }) => string
  fetch?: FetchFunction
  includeUsage?: boolean
  errorStructure?: ProviderErrorStructure<any>
  metadataExtractor?: MetadataExtractor

  /**
   * Whether the model supports structured outputs.
   */
  supportsStructuredOutputs?: boolean

  /**
   * The supported URLs for the model.
   */
  supportedUrls?: () => LanguageModelV3["supportedUrls"]
}

const providerOptionsSchema = Schema.toStandardSchemaV1(openaiCompatibleProviderOptions)

// The request args hold undefined-valued settings and JSON schemas typed outside Schema.Json.
// The codec writes the same text as JSON.stringify, which drops the undefined members.
const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// The finish event's raw usage is OpenAI wire JSON, where an absent count is `null`.
// Code holds each count as an Option and the codec writes the null.
const RawStreamUsage = Schema.Struct({
  prompt_tokens: Schema.OptionFromNullOr(Schema.Number),
  completion_tokens: Schema.OptionFromNullOr(Schema.Number),
  total_tokens: Schema.OptionFromNullOr(Schema.Number),
}).annotate({ identifier: "GithubCopilot.RawStreamUsage" })
const encodeRawStreamUsage = Schema.encodeSync(RawStreamUsage)

/**
 * A failure from an AI SDK helper: provider option parsing, the HTTP request with its
 * response parsing, or the metadata extractor. The AI SDK reads the original error
 * (APICallError retries, error classification), so the error rides in `cause`.
 */
export class CopilotChatError extends Schema.TaggedError<CopilotChatError>()("GithubCopilot.ChatError", {
  cause: Schema.Defect(),
}) {}

const fromAISDK = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new CopilotChatError({ cause }) })

// doGenerate and doStream hand a Promise to the AI SDK, which inspects the rejection.
// A wrapped helper failure therefore rejects with the error that it carries.
const runForAISDK = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.mapError(effect, (error) => (error instanceof CopilotChatError ? error.cause : error)))

const parseCompatibleOptions = (provider: string, providerOptions: LanguageModelV3CallOptions["providerOptions"]) =>
  fromAISDK(() => parseProviderOptions({ provider, providerOptions, schema: providerOptionsSchema }))

export class OpenAICompatibleChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"

  readonly supportsStructuredOutputs: boolean

  readonly modelId: OpenAICompatibleChatModelId
  private readonly config: OpenAICompatibleChatConfig
  private readonly failedResponseHandler: ResponseHandler<APICallError>
  private readonly chunkSchema // type inferred via constructor

  constructor(modelId: OpenAICompatibleChatModelId, config: OpenAICompatibleChatConfig) {
    this.modelId = modelId
    this.config = config

    // initialize error handling:
    const errorStructure = config.errorStructure ?? defaultOpenAICompatibleErrorStructure
    this.chunkSchema = Schema.toStandardSchemaV1(createOpenAICompatibleChatChunkSchema(errorStructure.errorSchema))
    this.failedResponseHandler = createJsonErrorResponseHandler({
      ...errorStructure,
      errorSchema: Schema.toStandardSchemaV1(errorStructure.errorSchema),
    })

    this.supportsStructuredOutputs = config.supportsStructuredOutputs ?? false
  }

  get provider(): string {
    return this.config.provider
  }

  private get providerOptionsName(): string {
    return this.config.provider.split(".")[0].trim()
  }

  get supportedUrls() {
    return this.config.supportedUrls?.() ?? {}
  }

  private getArgs({
    prompt,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    providerOptions,
    stopSequences,
    responseFormat,
    seed,
    toolChoice,
    tools,
  }: LanguageModelV3CallOptions) {
    return Effect.gen({ self: this }, function* () {
      // Parse provider options
      const compatibleOptions = Object.assign(
        (yield* parseCompatibleOptions("copilot", providerOptions)) ?? {},
        (yield* parseCompatibleOptions(this.providerOptionsName, providerOptions)) ?? {},
      )

      const topKWarnings: SharedV3Warning[] = Predicate.isNotNullish(topK)
        ? [{ type: "unsupported", feature: "topK" }]
        : []
      const responseFormatWarnings: SharedV3Warning[] =
        responseFormat?.type === "json" &&
        Predicate.isNotNullish(responseFormat.schema) &&
        !this.supportsStructuredOutputs
          ? [
              {
                type: "unsupported",
                feature: "responseFormat",
                details: "JSON response format schema is only supported with structuredOutputs",
              },
            ]
          : []

      const {
        tools: openaiTools,
        toolChoice: openaiToolChoice,
        toolWarnings,
      } = yield* prepareTools({
        tools,
        toolChoice,
      })

      return {
        args: {
          // model id:
          model: this.modelId,

          // model specific settings:
          user: compatibleOptions.user,

          // standardized settings:
          max_tokens: maxOutputTokens,
          temperature,
          top_p: topP,
          frequency_penalty: frequencyPenalty,
          presence_penalty: presencePenalty,
          ...(responseFormat?.type === "json"
            ? {
                response_format:
                  this.supportsStructuredOutputs && Predicate.isNotNullish(responseFormat.schema)
                    ? {
                        type: "json_schema",
                        json_schema: {
                          schema: responseFormat.schema,
                          name: responseFormat.name ?? "response",
                          description: responseFormat.description,
                        },
                      }
                    : { type: "json_object" },
              }
            : {}),

          stop: stopSequences,
          seed,
          ...Object.fromEntries(
            Object.entries(providerOptions?.[this.providerOptionsName] ?? {}).filter(
              ([key]) => !Object.keys(openaiCompatibleProviderOptions.fields).includes(key),
            ),
          ),

          reasoning_effort: compatibleOptions.reasoningEffort,
          verbosity: compatibleOptions.textVerbosity,

          // messages:
          messages: yield* convertToOpenAICompatibleChatMessages(prompt),

          // tools:
          tools: openaiTools,
          tool_choice: openaiToolChoice,

          // thinking_budget
          thinking_budget: compatibleOptions.thinking_budget,
        },
        warnings: [...topKWarnings, ...responseFormatWarnings, ...toolWarnings],
      }
    })
  }

  doGenerate(options: LanguageModelV3CallOptions) {
    return runForAISDK(this.generate(options))
  }

  doStream(options: LanguageModelV3CallOptions) {
    return runForAISDK(this.stream(options))
  }

  private generate(options: LanguageModelV3CallOptions) {
    return Effect.gen({ self: this }, function* () {
      const { args, warnings } = yield* this.getArgs({ ...options })

      const body = yield* encodeJsonText(args)

      const {
        responseHeaders,
        value: responseBody,
        rawValue: rawResponse,
      } = yield* fromAISDK(() =>
        postJsonToApi({
          url: this.config.url({
            path: "/chat/completions",
            modelId: this.modelId,
          }),
          headers: combineHeaders(this.config.headers(), options.headers),
          body: args,
          failedResponseHandler: this.failedResponseHandler,
          successfulResponseHandler: createJsonResponseHandler(Schema.toStandardSchemaV1(OpenAICompatibleChatResponse)),
          abortSignal: options.abortSignal,
          fetch: this.config.fetch,
        }),
      )

      const choice = responseBody.choices[0]
      // Include reasoning_opaque for Copilot multi-turn reasoning
      const opaqueMetadata = reasoningOpaqueMetadata(nonEmpty(choice.message.reasoning_opaque))

      const content: LanguageModelV3Content[] = [
        // text content:
        ...Option.toArray(
          Option.map(
            nonEmpty(choice.message.content),
            (text): LanguageModelV3Content => ({ type: "text", text, ...opaqueMetadata }),
          ),
        ),
        // reasoning content (Copilot uses reasoning_text):
        ...Option.toArray(
          Option.map(
            nonEmpty(choice.message.reasoning_text),
            (text): LanguageModelV3Content => ({ type: "reasoning", text, ...opaqueMetadata }),
          ),
        ),
        // tool calls:
        ...(choice.message.tool_calls ?? []).map(
          (toolCall): LanguageModelV3Content => ({
            type: "tool-call",
            toolCallId: toolCall.id ?? generateId(),
            toolName: toolCall.function.name,
            input: toolCall.function.arguments,
            ...opaqueMetadata,
          }),
        ),
      ]

      const usage = Option.match(Option.fromNullishOr(responseBody.usage), {
        onNone: () => noTokenUsage,
        onSome: (wireUsage) => mergeTokenUsage(noTokenUsage, wireUsage),
      })

      // provider metadata:
      const extractedMetadata = yield* Option.match(Option.fromNullishOr(this.config.metadataExtractor), {
        onNone: () => Effect.succeed({}),
        onSome: (extractor) => fromAISDK(() => extractor.extractMetadata({ parsedBody: rawResponse })),
      })
      const baseMetadata: SharedV3ProviderMetadata = {
        [this.providerOptionsName]: {},
        ...extractedMetadata,
      }
      const providerMetadata: SharedV3ProviderMetadata = {
        ...baseMetadata,
        [this.providerOptionsName]: {
          ...baseMetadata[this.providerOptionsName],
          ...predictionTokenMetadata(usage),
        },
      }

      return {
        content,
        finishReason: encodeFinishReason(finishReasonOf(Option.fromNullishOr(choice.finish_reason))),
        usage: {
          ...encodeUsage(usage, Option.none()),
          ...Option.match(Option.fromNullishOr(responseBody.usage), {
            onNone: () => ({}),
            onSome: (raw) => ({ raw }),
          }),
        },
        providerMetadata,
        request: { body },
        response: {
          ...getResponseMetadata(responseBody),
          headers: responseHeaders,
          body: rawResponse,
        },
        warnings,
      }
    })
  }

  private stream(options: LanguageModelV3CallOptions) {
    return Effect.gen({ self: this }, function* () {
      const { args, warnings } = yield* this.getArgs({ ...options })

      const body = {
        ...args,
        stream: true,

        // only include stream_options when in strict compatibility mode:
        ...(this.config.includeUsage ? { stream_options: { include_usage: true } } : {}),
      }

      const metadataExtractor = this.config.metadataExtractor?.createStreamExtractor()

      const { responseHeaders, value: response } = yield* fromAISDK(() =>
        postJsonToApi({
          url: this.config.url({
            path: "/chat/completions",
            modelId: this.modelId,
          }),
          headers: combineHeaders(this.config.headers(), options.headers),
          body,
          failedResponseHandler: this.failedResponseHandler,
          successfulResponseHandler: createEventSourceResponseHandler(this.chunkSchema),
          abortSignal: options.abortSignal,
          fetch: this.config.fetch,
        }),
      )

      const toolCalls: Array<{
        id: string
        type: "function"
        function: {
          name: string
          arguments: string
        }
        hasFinished: boolean
      }> = []

      let finishReason = finishReasonOf(Option.none())
      let usage = noTokenUsage
      let isFirstChunk = true
      const providerOptionsName = this.providerOptionsName
      let isActiveReasoning = false
      let isActiveText = false
      let reasoningOpaque: Option.Option<string> = Option.none()

      return {
        stream: response.pipeThrough(
          new TransformStream<ParseResult<OpenAICompatibleChatChunkEvent>, LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings })
            },

            transform(chunk, controller) {
              // Emit raw chunk if requested (before anything else)
              if (options.includeRawChunks) {
                controller.enqueue({ type: "raw", rawValue: chunk.rawValue })
              }

              // handle failed chunk parsing / validation:
              if (!chunk.success) {
                finishReason = { unified: "error", raw: Option.none() }
                controller.enqueue({ type: "error", error: chunk.error })
                return
              }
              const value = chunk.value

              metadataExtractor?.processChunk(chunk.rawValue)

              // handle error chunks:
              if ("error" in value) {
                finishReason = { unified: "error", raw: Option.none() }
                controller.enqueue({ type: "error", error: value.error.message })
                return
              }

              if (isFirstChunk) {
                isFirstChunk = false

                controller.enqueue({
                  type: "response-metadata",
                  ...getResponseMetadata(value),
                })
              }

              if (Predicate.isNotNullish(value.usage)) {
                usage = mergeTokenUsage(usage, value.usage)
              }

              const choice = value.choices[0]

              const rawFinishReason = Option.fromNullishOr(choice?.finish_reason)
              if (Option.isSome(rawFinishReason)) {
                finishReason = finishReasonOf(rawFinishReason)
              }

              const delta = choice?.delta
              if (Predicate.isNullish(delta)) {
                return
              }

              // Capture reasoning_opaque for Copilot multi-turn reasoning.
              // An invalid chunk errors the stream through its controller, as a throw from transform did.
              if (delta.reasoning_opaque) {
                if (Option.isSome(reasoningOpaque)) {
                  controller.error(
                    new InvalidResponseDataError({
                      data: delta,
                      message:
                        "Multiple reasoning_opaque values received in a single response. Only one thinking part per response is supported.",
                    }),
                  )
                  return
                }
                reasoningOpaque = Option.some(delta.reasoning_opaque)
              }

              // enqueue reasoning before text deltas (Copilot uses reasoning_text):
              const reasoningContent = delta.reasoning_text
              if (reasoningContent) {
                if (!isActiveReasoning) {
                  controller.enqueue({
                    type: "reasoning-start",
                    id: "reasoning-0",
                  })
                  isActiveReasoning = true
                }

                controller.enqueue({
                  type: "reasoning-delta",
                  id: "reasoning-0",
                  delta: reasoningContent,
                })
              }

              if (delta.content) {
                // If reasoning was active and we're starting text, end reasoning first
                // This handles the case where reasoning_opaque and content come in the same chunk
                if (isActiveReasoning && !isActiveText) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: "reasoning-0",
                    ...reasoningOpaqueMetadata(reasoningOpaque),
                  })
                  isActiveReasoning = false
                }

                if (!isActiveText) {
                  controller.enqueue({
                    type: "text-start",
                    id: "txt-0",
                    ...reasoningOpaqueMetadata(reasoningOpaque),
                  })
                  isActiveText = true
                }

                controller.enqueue({
                  type: "text-delta",
                  id: "txt-0",
                  delta: delta.content,
                })
              }

              if (Predicate.isNotNullish(delta.tool_calls)) {
                // If reasoning was active and we're starting tool calls, end reasoning first
                // This handles the case where reasoning goes directly to tool calls with no content
                if (isActiveReasoning) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: "reasoning-0",
                    ...reasoningOpaqueMetadata(reasoningOpaque),
                  })
                  isActiveReasoning = false
                }
                for (const toolCallDelta of delta.tool_calls) {
                  const index = toolCallDelta.index

                  if (Predicate.isNullish(toolCalls[index])) {
                    if (Predicate.isNullish(toolCallDelta.id)) {
                      controller.error(
                        new InvalidResponseDataError({
                          data: toolCallDelta,
                          message: `Expected 'id' to be a string.`,
                        }),
                      )
                      return
                    }

                    if (Predicate.isNullish(toolCallDelta.function.name)) {
                      controller.error(
                        new InvalidResponseDataError({
                          data: toolCallDelta,
                          message: `Expected 'function.name' to be a string.`,
                        }),
                      )
                      return
                    }

                    controller.enqueue({
                      type: "tool-input-start",
                      id: toolCallDelta.id,
                      toolName: toolCallDelta.function.name,
                    })

                    toolCalls[index] = {
                      id: toolCallDelta.id,
                      type: "function",
                      function: {
                        name: toolCallDelta.function.name,
                        arguments: toolCallDelta.function.arguments ?? "",
                      },
                      hasFinished: false,
                    }

                    const toolCall = toolCalls[index]

                    // send delta if the argument text has already started:
                    if (toolCall.function.arguments.length > 0) {
                      controller.enqueue({
                        type: "tool-input-delta",
                        id: toolCall.id,
                        delta: toolCall.function.arguments,
                      })
                    }

                    // check if tool call is complete
                    // (some providers send the full tool call in one chunk):
                    if (isParsableJson(toolCall.function.arguments)) {
                      controller.enqueue({
                        type: "tool-input-end",
                        id: toolCall.id,
                      })

                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: toolCall.id ?? generateId(),
                        toolName: toolCall.function.name,
                        input: toolCall.function.arguments,
                        ...reasoningOpaqueMetadata(reasoningOpaque),
                      })
                      toolCall.hasFinished = true
                    }

                    continue
                  }

                  // existing tool call, merge if not finished
                  const toolCall = toolCalls[index]

                  if (toolCall.hasFinished) {
                    continue
                  }

                  toolCall.function.arguments += toolCallDelta.function.arguments ?? ""

                  // send delta
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: toolCall.id,
                    delta: toolCallDelta.function.arguments ?? "",
                  })

                  // check if tool call is complete
                  if (isParsableJson(toolCall.function.arguments)) {
                    controller.enqueue({
                      type: "tool-input-end",
                      id: toolCall.id,
                    })

                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: toolCall.id ?? generateId(),
                      toolName: toolCall.function.name,
                      input: toolCall.function.arguments,
                      ...reasoningOpaqueMetadata(reasoningOpaque),
                    })
                    toolCall.hasFinished = true
                  }
                }
              }
            },

            flush(controller) {
              if (isActiveReasoning) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: "reasoning-0",
                  // Include reasoning_opaque for Copilot multi-turn reasoning
                  ...reasoningOpaqueMetadata(reasoningOpaque),
                })
              }

              if (isActiveText) {
                controller.enqueue({ type: "text-end", id: "txt-0" })
              }

              // go through all tool calls and send the ones that are not finished
              for (const toolCall of toolCalls.filter((toolCall) => !toolCall.hasFinished)) {
                controller.enqueue({
                  type: "tool-input-end",
                  id: toolCall.id,
                })

                controller.enqueue({
                  type: "tool-call",
                  toolCallId: toolCall.id ?? generateId(),
                  toolName: toolCall.function.name,
                  input: toolCall.function.arguments,
                })
              }

              const baseMetadata: SharedV3ProviderMetadata = {
                [providerOptionsName]: {},
                // Include reasoning_opaque for Copilot multi-turn reasoning
                ...Option.match(reasoningOpaque, {
                  onNone: () => ({}),
                  onSome: (reasoningOpaque) => ({ copilot: { reasoningOpaque } }),
                }),
                ...metadataExtractor?.buildMetadata(),
              }
              const providerMetadata: SharedV3ProviderMetadata = {
                ...baseMetadata,
                [providerOptionsName]: {
                  ...baseMetadata[providerOptionsName],
                  ...predictionTokenMetadata(usage),
                },
              }

              controller.enqueue({
                type: "finish",
                finishReason: encodeFinishReason(finishReason),
                usage: {
                  ...encodeUsage(
                    usage,
                    Option.zipWith(usage.promptTokens, usage.cachedTokens, (prompt, cached) => prompt - cached),
                  ),
                  raw: encodeRawStreamUsage({
                    prompt_tokens: usage.promptTokens,
                    completion_tokens: usage.completionTokens,
                    total_tokens: usage.totalTokens,
                  }),
                },
                providerMetadata,
              })
            },
          }),
        ),
        request: { body },
        response: { headers: responseHeaders },
      }
    })
  }
}

const NullishString = Schema.optional(Schema.NullOr(Schema.String))
const NullishNumber = Schema.optional(Schema.NullOr(Schema.Number))

const OpenAICompatibleTokenUsage = Schema.Struct({
  prompt_tokens: NullishNumber,
  completion_tokens: NullishNumber,
  total_tokens: NullishNumber,
  prompt_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: NullishNumber,
      }),
    ),
  ),
  completion_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: NullishNumber,
        accepted_prediction_tokens: NullishNumber,
        rejected_prediction_tokens: NullishNumber,
      }),
    ),
  ),
}).annotate({ identifier: "GithubCopilot.OpenAICompatibleTokenUsage" })

// limited version of the schema, focussed on what is needed for the implementation
// this approach limits breakages when the API changes and increases efficiency
const OpenAICompatibleChatResponse = Schema.Struct({
  id: NullishString,
  created: NullishNumber,
  model: NullishString,
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        role: Schema.optional(Schema.NullOr(Schema.Literal("assistant"))),
        content: NullishString,
        // Copilot-specific reasoning fields
        reasoning_text: NullishString,
        reasoning_opaque: NullishString,
        tool_calls: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                id: NullishString,
                function: Schema.Struct({
                  name: Schema.String,
                  arguments: Schema.String,
                }),
              }),
            ),
          ),
        ),
      }),
      finish_reason: NullishString,
    }),
  ),
  usage: Schema.optional(Schema.NullOr(OpenAICompatibleTokenUsage)),
}).annotate({ identifier: "GithubCopilot.OpenAICompatibleChatResponse" })

// limited version of the schema, focussed on what is needed for the implementation
// this approach limits breakages when the API changes and increases efficiency
const OpenAICompatibleChatChunk = Schema.Struct({
  id: NullishString,
  created: NullishNumber,
  model: NullishString,
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            role: Schema.optional(Schema.NullOr(Schema.Literal("assistant"))),
            content: NullishString,
            // Copilot-specific reasoning fields
            reasoning_text: NullishString,
            reasoning_opaque: NullishString,
            tool_calls: Schema.optional(
              Schema.NullOr(
                Schema.Array(
                  Schema.Struct({
                    index: Schema.Number,
                    id: NullishString,
                    function: Schema.Struct({
                      name: NullishString,
                      arguments: NullishString,
                    }),
                  }),
                ),
              ),
            ),
          }),
        ),
      ),
      finish_reason: NullishString,
    }),
  ),
  usage: Schema.optional(Schema.NullOr(OpenAICompatibleTokenUsage)),
}).annotate({ identifier: "GithubCopilot.OpenAICompatibleChatChunk" })

// The stream reads `error.message` from an error chunk, so the error schema decodes
// the default OpenAI-compatible error shape.
const createOpenAICompatibleChatChunkSchema = (errorSchema: Schema.Decoder<OpenAICompatibleErrorData>) =>
  Schema.Union([OpenAICompatibleChatChunk, errorSchema])

type OpenAICompatibleChatChunkEvent = typeof OpenAICompatibleChatChunk.Type | OpenAICompatibleErrorData

const nonEmpty = (text: string | null | undefined) =>
  Option.fromNullishOr(text).pipe(Option.filter((value) => value.length > 0))

// Copilot multi-turn reasoning: a part carries the reasoning_opaque signature under the copilot namespace.
const reasoningOpaqueMetadata = (reasoningOpaque: Option.Option<string>) =>
  Option.match(reasoningOpaque, {
    onNone: () => ({}),
    onSome: (reasoningOpaque) => ({ providerMetadata: { copilot: { reasoningOpaque } } }),
  })

interface TokenUsage {
  readonly promptTokens: Option.Option<number>
  readonly completionTokens: Option.Option<number>
  readonly totalTokens: Option.Option<number>
  readonly cachedTokens: Option.Option<number>
  readonly reasoningTokens: Option.Option<number>
  readonly acceptedPredictionTokens: Option.Option<number>
  readonly rejectedPredictionTokens: Option.Option<number>
}

const noTokenUsage: TokenUsage = {
  promptTokens: Option.none(),
  completionTokens: Option.none(),
  totalTokens: Option.none(),
  cachedTokens: Option.none(),
  reasoningTokens: Option.none(),
  acceptedPredictionTokens: Option.none(),
  rejectedPredictionTokens: Option.none(),
}

// A usage record replaces the prompt, completion and total counts. A detail count replaces the
// earlier one only when the record carries it.
const mergeTokenUsage = (previous: TokenUsage, usage: typeof OpenAICompatibleTokenUsage.Type): TokenUsage => ({
  promptTokens: Option.fromNullishOr(usage.prompt_tokens),
  completionTokens: Option.fromNullishOr(usage.completion_tokens),
  totalTokens: Option.fromNullishOr(usage.total_tokens),
  cachedTokens: Option.orElse(
    Option.fromNullishOr(usage.prompt_tokens_details?.cached_tokens),
    () => previous.cachedTokens,
  ),
  reasoningTokens: Option.orElse(
    Option.fromNullishOr(usage.completion_tokens_details?.reasoning_tokens),
    () => previous.reasoningTokens,
  ),
  acceptedPredictionTokens: Option.orElse(
    Option.fromNullishOr(usage.completion_tokens_details?.accepted_prediction_tokens),
    () => previous.acceptedPredictionTokens,
  ),
  rejectedPredictionTokens: Option.orElse(
    Option.fromNullishOr(usage.completion_tokens_details?.rejected_prediction_tokens),
    () => previous.rejectedPredictionTokens,
  ),
})

const predictionTokenMetadata = (usage: TokenUsage) => ({
  ...Option.match(usage.acceptedPredictionTokens, {
    onNone: () => ({}),
    onSome: (acceptedPredictionTokens) => ({ acceptedPredictionTokens }),
  }),
  ...Option.match(usage.rejectedPredictionTokens, {
    onNone: () => ({}),
    onSome: (rejectedPredictionTokens) => ({ rejectedPredictionTokens }),
  }),
})

// The AI SDK result types hold an absent count or raw finish reason as `undefined`.
// Code holds these values as Option and the codecs write the undefined.
const UsageCount = Schema.OptionFromUndefinedOr(Schema.Number)

const LanguageModelUsage = Schema.Struct({
  inputTokens: Schema.Struct({
    total: UsageCount,
    noCache: UsageCount,
    cacheRead: UsageCount,
    cacheWrite: UsageCount,
  }),
  outputTokens: Schema.Struct({
    total: UsageCount,
    text: UsageCount,
    reasoning: UsageCount,
  }),
}).annotate({ identifier: "GithubCopilot.LanguageModelUsage" })
const encodeLanguageModelUsage = Schema.encodeSync(LanguageModelUsage)

// Copilot reports no cache-write or text-only output counts.
const encodeUsage = (usage: TokenUsage, noCache: Option.Option<number>) =>
  encodeLanguageModelUsage({
    inputTokens: { total: usage.promptTokens, noCache, cacheRead: usage.cachedTokens, cacheWrite: Option.none() },
    outputTokens: { total: usage.completionTokens, text: Option.none(), reasoning: usage.reasoningTokens },
  })

const LanguageModelFinishReason = Schema.Struct({
  unified: Schema.Literals(["stop", "length", "content-filter", "tool-calls", "error", "other"]),
  raw: Schema.OptionFromUndefinedOr(Schema.String),
}).annotate({ identifier: "GithubCopilot.LanguageModelFinishReason" })
const encodeFinishReason = Schema.encodeSync(LanguageModelFinishReason)

const finishReasonOf = (raw: Option.Option<string>): typeof LanguageModelFinishReason.Type => ({
  unified: mapOpenAICompatibleFinishReason(Option.getOrUndefined(raw)),
  raw,
})

import {
  APICallError,
  type JSONObject,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3ProviderTool,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider"
import {
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonResponseHandler,
  generateId,
  parseProviderOptions,
  type ParseResult,
  postJsonToApi,
} from "@ai-sdk/provider-utils"
import { Chunk, DateTime, Effect, MutableHashMap, Option, Predicate, Schema } from "effect"
import type { OpenAIConfig } from "./openai-config"
import { openaiFailedResponseHandler, ResponsesCallError } from "./openai-error"
import { codeInterpreterInputSchema, codeInterpreterOutputSchema, ContainerID } from "./tool/code-interpreter"
import { FileID, fileSearchOutputSchema } from "./tool/file-search"
import { imageGenerationOutputSchema } from "./tool/image-generation"
import { convertToOpenAIResponsesInput } from "./convert-to-openai-responses-input"
import { mapOpenAIResponseFinishReason } from "./map-openai-responses-finish-reason"
import type { OpenAIResponsesIncludeOptions, OpenAIResponsesIncludeValue } from "./openai-responses-api-types"
import { prepareResponsesTools } from "./openai-responses-prepare-tools"
import type { OpenAIResponsesModelId } from "./openai-responses-settings"
import { localShellInputSchema } from "./tool/local-shell"

// Output item ids and function call ids from the Responses API.
const ItemID = Schema.String.pipe(Schema.brand("CopilotResponses.ItemID"))
const CallID = Schema.String.pipe(Schema.brand("CopilotResponses.CallID"))

const webSearchCallItem = Schema.Struct({
  type: Schema.Literal("web_search_call"),
  id: ItemID,
  status: Schema.String,
  action: Schema.optional(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal("search"),
          query: Schema.optional(Schema.NullOr(Schema.String)),
        }),
        Schema.Struct({
          type: Schema.Literal("open_page"),
          url: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("find"),
          url: Schema.String,
          pattern: Schema.String,
        }),
      ]),
    ),
  ),
}).annotate({ identifier: "CopilotResponses.WebSearchCallItem" })

const fileSearchCallItem = Schema.Struct({
  type: Schema.Literal("file_search_call"),
  id: ItemID,
  queries: Schema.mutable(Schema.Array(Schema.String)),
  results: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          attributes: Schema.Record(Schema.String, Schema.MutableJson),
          file_id: FileID,
          filename: Schema.String,
          score: Schema.Finite,
          text: Schema.String,
        }),
      ),
    ),
  ),
}).annotate({ identifier: "CopilotResponses.FileSearchCallItem" })

const codeInterpreterCallItem = Schema.Struct({
  type: Schema.Literal("code_interpreter_call"),
  id: ItemID,
  code: Schema.NullOr(Schema.String),
  container_id: ContainerID,
  outputs: Schema.NullOr(
    Schema.mutable(
      Schema.Array(
        Schema.Union([
          Schema.Struct({ type: Schema.Literal("logs"), logs: Schema.String }),
          Schema.Struct({ type: Schema.Literal("image"), url: Schema.String }),
        ]),
      ),
    ),
  ),
}).annotate({ identifier: "CopilotResponses.CodeInterpreterCallItem" })

const localShellCallItem = Schema.Struct({
  type: Schema.Literal("local_shell_call"),
  id: ItemID,
  call_id: CallID,
  action: Schema.Struct({
    type: Schema.Literal("exec"),
    command: Schema.mutable(Schema.Array(Schema.String)),
    timeout_ms: Schema.optional(Schema.Finite),
    user: Schema.optional(Schema.String),
    working_directory: Schema.optional(Schema.String),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
}).annotate({ identifier: "CopilotResponses.LocalShellCallItem" })

const imageGenerationCallItem = Schema.Struct({
  type: Schema.Literal("image_generation_call"),
  id: ItemID,
  result: Schema.String,
}).annotate({ identifier: "CopilotResponses.ImageGenerationCallItem" })

// Tool call inputs are JSON text. generate writes the local shell action as the Responses API names it
// (snake_case keys); the stream maps it to the camelCase tool input first.
const webSearchCallInputSchema = Schema.Struct({ action: webSearchCallItem.fields.action }).annotate({
  identifier: "CopilotResponses.WebSearchCallInput",
})
const localShellCallInputSchema = Schema.Struct({ action: localShellCallItem.fields.action }).annotate({
  identifier: "CopilotResponses.LocalShellCallInput",
})
const encodeWebSearchCallInput = Schema.encodeSync(Schema.fromJsonString(webSearchCallInputSchema))
const encodeLocalShellCallInput = Schema.encodeSync(Schema.fromJsonString(localShellCallInputSchema))
const encodeLocalShellInput = Schema.encodeSync(Schema.fromJsonString(localShellInputSchema))
const encodeCodeInterpreterInput = Schema.encodeSync(Schema.fromJsonString(codeInterpreterInputSchema))
const quoteJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))
// The response body as JSON text; the JSON response handler returns it parsed, with no fixed shape.
const encodeResponseBody = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

// Provider metadata keeps the wire nulls that callers read: reasoningEncryptedContent is null until the
// Responses API sends the encrypted content, and a stream without response.created has a null responseId.
const reasoningMetadataSchema = Schema.Struct({
  itemId: ItemID,
  reasoningEncryptedContent: Schema.OptionFromNullOr(Schema.String),
}).annotate({ identifier: "CopilotResponses.ReasoningMetadata" })
const encodeReasoningMetadata = Schema.encodeSync(reasoningMetadataSchema)
const encodeNullableString = Schema.encodeSync(Schema.OptionFromNullOr(Schema.String))

// A file search call result with the key names of the file search tool output.
const toFileSearchResult = (result: NonNullable<(typeof fileSearchCallItem.Type)["results"]>[number]) => ({
  attributes: result.attributes,
  fileId: result.file_id,
  filename: result.filename,
  score: result.score,
  text: result.text,
})

// The token counts that the Responses API reports.
type TokenUsage = {
  readonly input: Option.Option<number>
  readonly output: Option.Option<number>
  readonly cachedInput: Option.Option<number>
  readonly reasoning: Option.Option<number>
}

// AI SDK usage from Responses token counts. The Responses API reports no cache writes and no separate text tokens.
const toUsage = (tokens: TokenUsage, raw: JSONObject): LanguageModelV3Usage => ({
  inputTokens: {
    total: Option.getOrUndefined(tokens.input),
    noCache: Option.getOrUndefined(Option.zipWith(tokens.input, tokens.cachedInput, (input, cached) => input - cached)),
    cacheRead: Option.getOrUndefined(tokens.cachedInput),
    cacheWrite: Option.getOrUndefined(Option.none()),
  },
  outputTokens: {
    total: Option.getOrUndefined(tokens.output),
    text: Option.getOrUndefined(Option.none()),
    reasoning: Option.getOrUndefined(tokens.reasoning),
  },
  raw,
})

// A streaming tool call whose input deltas are still arriving.
type OngoingToolCall = {
  readonly toolName: string
  readonly toolCallId: string
  readonly codeInterpreter?: {
    readonly containerId: typeof ContainerID.Type
  }
}

// A streaming reasoning item, keyed by its output index.
type ActiveReasoning = {
  readonly canonicalId: typeof ItemID.Type // the item.id from output_item.added
  readonly encryptedContent: Option.Option<string>
  readonly summaryParts: ReadonlyArray<number>
}

/**
 * `top_logprobs` request body argument can be set to an integer between
 * 0 and 20 specifying the number of most likely tokens to return at each
 * token position, each with an associated log probability.
 *
 * @see https://platform.openai.com/docs/api-reference/responses/create#responses_create-top_logprobs
 */
const TOP_LOGPROBS_MAX = 20

const LOGPROBS_SCHEMA = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      token: Schema.String,
      logprob: Schema.Finite,
      top_logprobs: Schema.mutable(
        Schema.Array(
          Schema.Struct({
            token: Schema.String,
            logprob: Schema.Finite,
          }),
        ),
      ),
    }),
  ),
)

const usageSchema = Schema.Struct({
  input_tokens: Schema.Finite,
  input_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.NullOr(Schema.Finite)) })),
  ),
  output_tokens: Schema.Finite,
  output_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.NullOr(Schema.Finite)) })),
  ),
}).annotate({ identifier: "CopilotResponses.Usage" })

const responsesResponseSchema = Schema.Struct({
  id: ItemID,
  created_at: Schema.Finite,
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
      }),
    ),
  ),
  model: Schema.String,
  output: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("message"),
        role: Schema.Literal("assistant"),
        id: ItemID,
        content: Schema.Array(
          Schema.Struct({
            type: Schema.Literal("output_text"),
            text: Schema.String,
            logprobs: Schema.optional(Schema.NullOr(LOGPROBS_SCHEMA)),
            annotations: Schema.Array(
              Schema.Union([
                Schema.Struct({
                  type: Schema.Literal("url_citation"),
                  start_index: Schema.Finite,
                  end_index: Schema.Finite,
                  url: Schema.String,
                  title: Schema.String,
                }),
                Schema.Struct({
                  type: Schema.Literal("file_citation"),
                  file_id: FileID,
                  filename: Schema.optional(Schema.NullOr(Schema.String)),
                  index: Schema.optional(Schema.NullOr(Schema.Finite)),
                  start_index: Schema.optional(Schema.NullOr(Schema.Finite)),
                  end_index: Schema.optional(Schema.NullOr(Schema.Finite)),
                  quote: Schema.optional(Schema.NullOr(Schema.String)),
                }),
                Schema.Struct({
                  type: Schema.Literal("container_file_citation"),
                }),
              ]),
            ),
          }),
        ),
      }),
      webSearchCallItem,
      fileSearchCallItem,
      codeInterpreterCallItem,
      imageGenerationCallItem,
      localShellCallItem,
      Schema.Struct({
        type: Schema.Literal("function_call"),
        call_id: CallID,
        name: Schema.String,
        arguments: Schema.String,
        id: ItemID,
      }),
      Schema.Struct({
        type: Schema.Literal("computer_call"),
        id: ItemID,
        status: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        type: Schema.Literal("reasoning"),
        id: ItemID,
        encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
        summary: Schema.mutable(
          Schema.Array(
            Schema.Struct({
              type: Schema.Literal("summary_text"),
              text: Schema.String,
            }),
          ),
        ),
      }),
    ]),
  ),
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
  usage: usageSchema,
}).annotate({ identifier: "CopilotResponses.Response" })

export class OpenAIResponsesLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"

  readonly modelId: OpenAIResponsesModelId

  private readonly config: OpenAIConfig

  constructor(modelId: OpenAIResponsesModelId, config: OpenAIConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {
    "image/*": [/^https?:\/\/.*$/],
    "application/pdf": [/^https?:\/\/.*$/],
  }

  get provider(): string {
    return this.config.provider
  }

  doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return runAtSdkBoundary(generateResponse(this.modelId, this.config, options))
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return runAtSdkBoundary(streamResponse(this.modelId, this.config, options))
  }
}

// The AI SDK reads its own error classes from a rejected call (APICallError.isRetryable drives its retries), so a
// failed call rejects with the original cause.
const runAtSdkBoundary = <A>(effect: Effect.Effect<A, ResponsesCallError>): Promise<A> =>
  Effect.runPromise(Effect.mapError(effect, (error) => error.cause))

// A warning list with one entry when the condition holds.
const warnIf = (condition: boolean, warning: SharedV3Warning): ReadonlyArray<SharedV3Warning> =>
  condition ? [warning] : []

const getArgs = Effect.fn("CopilotResponses.getArgs")(function* (
  modelId: OpenAIResponsesModelId,
  config: OpenAIConfig,
  {
    maxOutputTokens,
    temperature,
    stopSequences,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    seed,
    prompt,
    providerOptions,
    tools,
    toolChoice,
    responseFormat,
  }: LanguageModelV3CallOptions,
) {
  const modelConfig = getResponsesModelConfig(modelId)

  const callWarnings = [
    ...warnIf(Predicate.isNotNullish(topK), { type: "unsupported", feature: "topK" }),
    ...warnIf(Predicate.isNotNullish(seed), { type: "unsupported", feature: "seed" }),
    ...warnIf(Predicate.isNotNullish(presencePenalty), { type: "unsupported", feature: "presencePenalty" }),
    ...warnIf(Predicate.isNotNullish(frequencyPenalty), { type: "unsupported", feature: "frequencyPenalty" }),
    ...warnIf(Predicate.isNotNullish(stopSequences), { type: "unsupported", feature: "stopSequences" }),
  ]

  const openaiOptions = yield* Effect.tryPromise({
    try: () =>
      parseProviderOptions({
        provider: "copilot",
        providerOptions,
        schema: Schema.toStandardSchemaV1(openaiResponsesProviderOptionsSchema),
      }),
    catch: (cause) => new ResponsesCallError({ cause }),
  })

  const hasOpenAITool = (id: string) => tools?.some((tool) => tool.type === "provider" && tool.id === id) === true

  const { input, warnings: inputWarnings } = yield* convertToOpenAIResponsesInput({
    prompt,
    systemMessageMode: modelConfig.systemMessageMode,
    fileIdPrefixes: config.fileIdPrefixes,
    store: openaiOptions?.store ?? true,
    hasLocalShellTool: hasOpenAITool("openai.local_shell"),
  })

  const strictJsonSchema = openaiOptions?.strictJsonSchema ?? false

  // when logprobs are requested, automatically include them:
  const topLogprobs =
    typeof openaiOptions?.logprobs === "number"
      ? Option.some(openaiOptions.logprobs)
      : openaiOptions?.logprobs === true
        ? Option.some(TOP_LOGPROBS_MAX)
        : Option.none<number>()

  // when a web search tool is present, automatically include the sources:
  const webSearchToolName = tools?.find(
    (tool): tool is LanguageModelV3ProviderTool =>
      tool.type === "provider" && (tool.id === "openai.web_search" || tool.id === "openai.web_search_preview"),
  )?.name

  // requested logprobs, web search sources and code interpreter outputs are included automatically:
  const autoInclude: ReadonlyArray<OpenAIResponsesIncludeValue> = [
    ...(Option.isSome(topLogprobs) ? ["message.output_text.logprobs" as const] : []),
    ...(webSearchToolName ? ["web_search_call.action.sources" as const] : []),
    ...(hasOpenAITool("openai.code_interpreter") ? ["code_interpreter_call.outputs" as const] : []),
  ]
  const include: OpenAIResponsesIncludeOptions =
    autoInclude.length === 0 ? openaiOptions?.include : [...(openaiOptions?.include ?? []), ...autoInclude]

  // remove unsupported settings for reasoning models
  // see https://platform.openai.com/docs/guides/reasoning#limitations
  const dropsTemperature = modelConfig.isReasoningModel && Predicate.isNotNullish(temperature)
  const dropsTopP = modelConfig.isReasoningModel && Predicate.isNotNullish(topP)
  // flex and priority processing need a model that supports them; the args leave out an unsupported service tier
  const unsupportedFlex = openaiOptions?.serviceTier === "flex" && !modelConfig.supportsFlexProcessing
  const unsupportedPriority = openaiOptions?.serviceTier === "priority" && !modelConfig.supportsPriorityProcessing

  const baseArgs = {
    model: modelId,
    input,
    ...(!dropsTemperature && { temperature }),
    ...(!dropsTopP && { top_p: topP }),
    max_output_tokens: maxOutputTokens,

    ...((responseFormat?.type === "json" || openaiOptions?.textVerbosity) && {
      text: {
        ...(responseFormat?.type === "json" && {
          format: Predicate.isNotNullish(responseFormat.schema)
            ? {
                type: "json_schema",
                strict: strictJsonSchema,
                name: responseFormat.name ?? "response",
                description: responseFormat.description,
                schema: responseFormat.schema,
              }
            : { type: "json_object" },
        }),
        ...(openaiOptions?.textVerbosity && {
          verbosity: openaiOptions.textVerbosity,
        }),
      },
    }),

    // provider options:
    max_tool_calls: openaiOptions?.maxToolCalls,
    metadata: openaiOptions?.metadata,
    parallel_tool_calls: openaiOptions?.parallelToolCalls,
    previous_response_id: openaiOptions?.previousResponseId,
    store: openaiOptions?.store,
    user: openaiOptions?.user,
    instructions: openaiOptions?.instructions,
    ...(!unsupportedFlex && !unsupportedPriority && { service_tier: openaiOptions?.serviceTier }),
    include,
    prompt_cache_key: openaiOptions?.promptCacheKey,
    safety_identifier: openaiOptions?.safetyIdentifier,
    ...(Option.isSome(topLogprobs) && { top_logprobs: topLogprobs.value }),

    // model-specific settings:
    ...(modelConfig.isReasoningModel &&
      (Predicate.isNotNullish(openaiOptions?.reasoningEffort) ||
        Predicate.isNotNullish(openaiOptions?.reasoningSummary)) && {
        reasoning: {
          ...(Predicate.isNotNullish(openaiOptions?.reasoningEffort) && {
            effort: openaiOptions.reasoningEffort,
          }),
          ...(Predicate.isNotNullish(openaiOptions?.reasoningSummary) && {
            summary: openaiOptions.reasoningSummary,
          }),
        },
      }),
    ...(modelConfig.requiredAutoTruncation && {
      truncation: "auto",
    }),
  }

  const settingWarnings = modelConfig.isReasoningModel
    ? [
        ...warnIf(dropsTemperature, {
          type: "unsupported",
          feature: "temperature",
          details: "temperature is not supported for reasoning models",
        }),
        ...warnIf(dropsTopP, {
          type: "unsupported",
          feature: "topP",
          details: "topP is not supported for reasoning models",
        }),
      ]
    : [
        ...warnIf(Predicate.isNotNullish(openaiOptions?.reasoningEffort), {
          type: "unsupported",
          feature: "reasoningEffort",
          details: "reasoningEffort is not supported for non-reasoning models",
        }),
        ...warnIf(Predicate.isNotNullish(openaiOptions?.reasoningSummary), {
          type: "unsupported",
          feature: "reasoningSummary",
          details: "reasoningSummary is not supported for non-reasoning models",
        }),
      ]

  const serviceTierWarnings = [
    ...warnIf(unsupportedFlex, {
      type: "unsupported",
      feature: "serviceTier",
      details: "flex processing is only available for o3, o4-mini, and gpt-5 models",
    }),
    ...warnIf(unsupportedPriority, {
      type: "unsupported",
      feature: "serviceTier",
      details:
        "priority processing is only available for supported models (gpt-4, gpt-5, gpt-5-mini, o3, o4-mini) and requires Enterprise access. gpt-5-nano is not supported",
    }),
  ]

  const {
    tools: openaiTools,
    toolChoice: openaiToolChoice,
    toolWarnings,
  } = yield* prepareResponsesTools({
    tools,
    toolChoice,
    strictJsonSchema,
  })

  return {
    webSearchToolName,
    args: {
      ...baseArgs,
      tools: openaiTools,
      tool_choice: openaiToolChoice,
    },
    warnings: [...callWarnings, ...inputWarnings, ...settingWarnings, ...serviceTierWarnings, ...toolWarnings],
  }
})

const generateResponse = Effect.fn("CopilotResponses.generate")(function* (
  modelId: OpenAIResponsesModelId,
  config: OpenAIConfig,
  options: LanguageModelV3CallOptions,
) {
  const { args: body, warnings, webSearchToolName } = yield* getArgs(modelId, config, options)
  const url = config.url({
    path: "/responses",
    modelId: modelId,
  })

  const {
    responseHeaders,
    value: response,
    rawValue: rawResponse,
  } = yield* Effect.tryPromise({
    try: () =>
      postJsonToApi({
        url,
        headers: combineHeaders(config.headers(), options.headers),
        body,
        failedResponseHandler: openaiFailedResponseHandler,
        successfulResponseHandler: createJsonResponseHandler(Schema.toStandardSchemaV1(responsesResponseSchema)),
        abortSignal: options.abortSignal,
        fetch: config.fetch,
      }),
    catch: (cause) => new ResponsesCallError({ cause }),
  })

  if (response.error) {
    // APICallError.responseBody is text, and the handler returns the parsed body, so it is written back as JSON.
    const responseBody = yield* encodeResponseBody(rawResponse).pipe(
      Effect.mapError((cause) => new ResponsesCallError({ cause })),
    )
    return yield* new ResponsesCallError({
      cause: new APICallError({
        message: response.error.message,
        url,
        requestBodyValues: body,
        statusCode: 400,
        responseHeaders,
        responseBody,
        isRetryable: false,
      }),
    })
  }

  // map response content to content array
  const content = response.output.flatMap((part): Array<LanguageModelV3Content> => {
    switch (part.type) {
      case "reasoning": {
        // when there are no summary parts, we need to add an empty reasoning part:
        const summaryTexts = part.summary.length === 0 ? [""] : part.summary.map((summary) => summary.text)

        return summaryTexts.map((text) => ({
          type: "reasoning",
          text,
          providerMetadata: {
            copilot: encodeReasoningMetadata({
              itemId: part.id,
              reasoningEncryptedContent: Option.fromNullishOr(part.encrypted_content),
            }),
          },
        }))
      }

      case "image_generation_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.id,
            toolName: "image_generation",
            input: "{}",
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: part.id,
            toolName: "image_generation",
            result: {
              result: part.result,
            } satisfies typeof imageGenerationOutputSchema.Type,
          },
        ]
      }

      case "local_shell_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.call_id,
            toolName: "local_shell",
            input: encodeLocalShellCallInput({ action: part.action }),
            providerMetadata: {
              copilot: {
                itemId: part.id,
              },
            },
          },
        ]
      }

      case "message": {
        return part.content.flatMap(
          (contentPart): Array<LanguageModelV3Content> => [
            {
              type: "text",
              text: contentPart.text,
              providerMetadata: {
                copilot: {
                  itemId: part.id,
                },
              },
            },
            ...contentPart.annotations.flatMap((annotation): Array<LanguageModelV3Content> => {
              if (annotation.type === "url_citation") {
                return [
                  {
                    type: "source",
                    sourceType: "url",
                    id: config.generateId?.() ?? generateId(),
                    url: annotation.url,
                    title: annotation.title,
                  },
                ]
              }
              if (annotation.type === "file_citation") {
                return [
                  {
                    type: "source",
                    sourceType: "document",
                    id: config.generateId?.() ?? generateId(),
                    mediaType: "text/plain",
                    title: annotation.quote ?? annotation.filename ?? "Document",
                    filename: annotation.filename ?? annotation.file_id,
                  },
                ]
              }
              return []
            }),
          ],
        )
      }

      case "function_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.call_id,
            toolName: part.name,
            input: part.arguments,
            providerMetadata: {
              copilot: {
                itemId: part.id,
              },
            },
          },
        ]
      }

      case "web_search_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.id,
            toolName: webSearchToolName ?? "web_search",
            input: encodeWebSearchCallInput({ action: part.action }),
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: part.id,
            toolName: webSearchToolName ?? "web_search",
            result: { status: part.status },
          },
        ]
      }

      case "computer_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.id,
            toolName: "computer_use",
            input: "",
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: part.id,
            toolName: "computer_use",
            result: {
              type: "computer_use_tool_result",
              status: part.status || "completed",
            },
          },
        ]
      }

      case "file_search_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.id,
            toolName: "file_search",
            input: "{}",
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: part.id,
            toolName: "file_search",
            result: {
              queries: part.queries,
              results: Option.getOrNull(
                Option.map(Option.fromNullishOr(part.results), (results) => results.map(toFileSearchResult)),
              ),
            } satisfies typeof fileSearchOutputSchema.Type,
          },
        ]
      }

      case "code_interpreter_call": {
        return [
          {
            type: "tool-call",
            toolCallId: part.id,
            toolName: "code_interpreter",
            input: encodeCodeInterpreterInput({
              code: part.code,
              containerId: part.container_id,
            }),
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: part.id,
            toolName: "code_interpreter",
            result: {
              outputs: part.outputs,
            } satisfies typeof codeInterpreterOutputSchema.Type,
          },
        ]
      }

      // The response schema admits no other output item type.
      default:
        return []
    }
  })

  const logprobs = options.providerOptions?.copilot?.logprobs
    ? response.output.flatMap((part) =>
        part.type === "message"
          ? part.content.flatMap((contentPart) => (contentPart.logprobs ? [contentPart.logprobs] : []))
          : [],
      )
    : []

  // flag that checks if there have been client-side tool calls (not executed by openai)
  const hasFunctionCall = response.output.some((part) => part.type === "function_call")

  const providerMetadata: SharedV3ProviderMetadata = {
    copilot: {
      responseId: response.id,
      ...(logprobs.length > 0 && { logprobs }),
      ...(typeof response.service_tier === "string" && { serviceTier: response.service_tier }),
    },
  }

  return {
    content,
    finishReason: {
      unified: mapOpenAIResponseFinishReason({
        finishReason: response.incomplete_details?.reason,
        hasFunctionCall,
      }),
      raw: response.incomplete_details?.reason,
    },
    usage: toUsage(
      {
        input: Option.some(response.usage.input_tokens),
        output: Option.some(response.usage.output_tokens),
        cachedInput: Option.fromNullishOr(response.usage.input_tokens_details?.cached_tokens),
        reasoning: Option.fromNullishOr(response.usage.output_tokens_details?.reasoning_tokens),
      },
      response.usage,
    ),
    request: { body },
    response: {
      id: response.id,
      timestamp: DateTime.toDateUtc(DateTime.fromEpochSeconds(response.created_at)),
      modelId: response.model,
      headers: responseHeaders,
      body: rawResponse,
    },
    providerMetadata,
    warnings,
  }
})

const streamResponse = Effect.fn("CopilotResponses.stream")(function* (
  modelId: OpenAIResponsesModelId,
  config: OpenAIConfig,
  options: LanguageModelV3CallOptions,
) {
  const { args: body, warnings, webSearchToolName } = yield* getArgs(modelId, config, options)

  const { responseHeaders, value: response } = yield* Effect.tryPromise({
    try: () =>
      postJsonToApi({
        url: config.url({
          path: "/responses",
          modelId: modelId,
        }),
        headers: combineHeaders(config.headers(), options.headers),
        body: {
          ...body,
          stream: true,
        },
        failedResponseHandler: openaiFailedResponseHandler,
        successfulResponseHandler: createEventSourceResponseHandler(
          Schema.toStandardSchemaV1(openaiResponsesChunkSchema),
        ),
        abortSignal: options.abortSignal,
        fetch: config.fetch,
      }),
    catch: (cause) => new ResponsesCallError({ cause }),
  })

  let finishReason: {
    readonly unified: ReturnType<typeof mapOpenAIResponseFinishReason>
    readonly raw: Option.Option<string>
  } = {
    unified: "other",
    raw: Option.none(),
  }
  // Token counts arrive with the response.completed or response.incomplete chunk.
  let usage: TokenUsage & { readonly total: Option.Option<number> } = {
    input: Option.none(),
    output: Option.none(),
    total: Option.none(),
    cachedInput: Option.none(),
    reasoning: Option.none(),
  }
  let logprobs = Chunk.empty<typeof LOGPROBS_SCHEMA.Type>()
  let responseId = Option.none<string>()
  // Tool calls whose input is still streaming, by output index.
  const ongoingToolCalls = MutableHashMap.empty<number, OngoingToolCall>()

  // flag that checks if there have been client-side tool calls (not executed by openai)
  let hasFunctionCall = false

  // Track reasoning by output_index instead of item_id
  // GitHub Copilot rotates encrypted item IDs on every event
  const activeReasoning = MutableHashMap.empty<number, ActiveReasoning>()

  // Track current active reasoning output_index for correlating summary events
  let currentReasoningOutputIndex = Option.none<number>()

  // Track a stable text part id for the current assistant message.
  // Copilot may change item_id across text deltas; normalize to one id.
  let currentTextId = Option.none<string>()

  let serviceTier = Option.none<string>()

  return {
    stream: response.pipeThrough(
      new TransformStream<ParseResult<OpenAIResponsesChunk>, LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
        },

        transform(chunk, controller) {
          if (options.includeRawChunks) {
            controller.enqueue({ type: "raw", rawValue: chunk.rawValue })
          }

          // handle failed chunk parsing / validation:
          if (!chunk.success) {
            finishReason = {
              unified: "error",
              raw: Option.none(),
            }
            controller.enqueue({ type: "error", error: chunk.error })
            return
          }

          const value = chunk.value

          if (isResponseOutputItemAddedChunk(value)) {
            if (value.item.type === "function_call") {
              MutableHashMap.set(ongoingToolCalls, value.output_index, {
                toolName: value.item.name,
                toolCallId: value.item.call_id,
              })

              controller.enqueue({
                type: "tool-input-start",
                id: value.item.call_id,
                toolName: value.item.name,
              })
            } else if (value.item.type === "web_search_call") {
              MutableHashMap.set(ongoingToolCalls, value.output_index, {
                toolName: webSearchToolName ?? "web_search",
                toolCallId: value.item.id,
              })

              controller.enqueue({
                type: "tool-input-start",
                id: value.item.id,
                toolName: webSearchToolName ?? "web_search",
              })
            } else if (value.item.type === "computer_call") {
              MutableHashMap.set(ongoingToolCalls, value.output_index, {
                toolName: "computer_use",
                toolCallId: value.item.id,
              })

              controller.enqueue({
                type: "tool-input-start",
                id: value.item.id,
                toolName: "computer_use",
              })
            } else if (value.item.type === "code_interpreter_call") {
              MutableHashMap.set(ongoingToolCalls, value.output_index, {
                toolName: "code_interpreter",
                toolCallId: value.item.id,
                codeInterpreter: {
                  containerId: value.item.container_id,
                },
              })

              controller.enqueue({
                type: "tool-input-start",
                id: value.item.id,
                toolName: "code_interpreter",
              })

              controller.enqueue({
                type: "tool-input-delta",
                id: value.item.id,
                delta: `{"containerId":"${value.item.container_id}","code":"`,
              })
            } else if (value.item.type === "file_search_call") {
              controller.enqueue({
                type: "tool-call",
                toolCallId: value.item.id,
                toolName: "file_search",
                input: "{}",
                providerExecuted: true,
              })
            } else if (value.item.type === "image_generation_call") {
              controller.enqueue({
                type: "tool-call",
                toolCallId: value.item.id,
                toolName: "image_generation",
                input: "{}",
                providerExecuted: true,
              })
            } else if (value.item.type === "message") {
              // Start a stable text part for this assistant message
              currentTextId = Option.some(value.item.id)
              controller.enqueue({
                type: "text-start",
                id: value.item.id,
                providerMetadata: {
                  copilot: {
                    itemId: value.item.id,
                  },
                },
              })
            } else if (isResponseOutputItemAddedReasoningChunk(value)) {
              MutableHashMap.set(activeReasoning, value.output_index, {
                canonicalId: value.item.id,
                encryptedContent: Option.fromNullishOr(value.item.encrypted_content),
                summaryParts: [0],
              })
              currentReasoningOutputIndex = Option.some(value.output_index)

              controller.enqueue({
                type: "reasoning-start",
                id: `${value.item.id}:0`,
                providerMetadata: {
                  copilot: encodeReasoningMetadata({
                    itemId: value.item.id,
                    reasoningEncryptedContent: Option.fromNullishOr(value.item.encrypted_content),
                  }),
                },
              })
            }
          } else if (isResponseOutputItemDoneChunk(value)) {
            if (value.item.type === "function_call") {
              MutableHashMap.remove(ongoingToolCalls, value.output_index)
              hasFunctionCall = true

              controller.enqueue({
                type: "tool-input-end",
                id: value.item.call_id,
              })

              controller.enqueue({
                type: "tool-call",
                toolCallId: value.item.call_id,
                toolName: value.item.name,
                input: value.item.arguments,
                providerMetadata: {
                  copilot: {
                    itemId: value.item.id,
                  },
                },
              })
            } else if (value.item.type === "web_search_call") {
              MutableHashMap.remove(ongoingToolCalls, value.output_index)

              controller.enqueue({
                type: "tool-input-end",
                id: value.item.id,
              })

              controller.enqueue({
                type: "tool-call",
                toolCallId: value.item.id,
                toolName: "web_search",
                input: encodeWebSearchCallInput({ action: value.item.action }),
                providerExecuted: true,
              })

              controller.enqueue({
                type: "tool-result",
                toolCallId: value.item.id,
                toolName: "web_search",
                result: { status: value.item.status },
              })
            } else if (value.item.type === "computer_call") {
              MutableHashMap.remove(ongoingToolCalls, value.output_index)

              controller.enqueue({
                type: "tool-input-end",
                id: value.item.id,
              })

              controller.enqueue({
                type: "tool-call",
                toolCallId: value.item.id,
                toolName: "computer_use",
                input: "",
                providerExecuted: true,
              })

              controller.enqueue({
                type: "tool-result",
                toolCallId: value.item.id,
                toolName: "computer_use",
                result: {
                  type: "computer_use_tool_result",
                  status: value.item.status || "completed",
                },
              })
            } else if (value.item.type === "file_search_call") {
              MutableHashMap.remove(ongoingToolCalls, value.output_index)

              controller.enqueue({
                type: "tool-result",
                toolCallId: value.item.id,
                toolName: "file_search",
                result: {
                  queries: value.item.queries,
                  results: Option.getOrNull(
                    Option.map(Option.fromNullishOr(value.item.results), (results) => results.map(toFileSearchResult)),
                  ),
                } satisfies typeof fileSearchOutputSchema.Type,
              })
            } else if (value.item.type === "code_interpreter_call") {
              MutableHashMap.remove(ongoingToolCalls, value.output_index)

              controller.enqueue({
                type: "tool-result",
                toolCallId: value.item.id,
                toolName: "code_interpreter",
                result: {
                  outputs: value.item.outputs,
                } satisfies typeof codeInterpreterOutputSchema.Type,
              })
            } else if (value.item.type === "image_generation_call") {
              controller.enqueue({
                type: "tool-result",
                toolCallId: value.item.id,
                toolName: "image_generation",
                result: {
                  result: value.item.result,
                } satisfies typeof imageGenerationOutputSchema.Type,
              })
            } else if (value.item.type === "local_shell_call") {
              MutableHashMap.remove(ongoingToolCalls, value.output_index)

              controller.enqueue({
                type: "tool-call",
                toolCallId: value.item.call_id,
                toolName: "local_shell",
                input: encodeLocalShellInput({
                  action: {
                    type: "exec",
                    command: value.item.action.command,
                    timeoutMs: value.item.action.timeout_ms,
                    user: value.item.action.user,
                    workingDirectory: value.item.action.working_directory,
                    env: value.item.action.env,
                  },
                }),
                providerMetadata: {
                  copilot: { itemId: value.item.id },
                },
              })
            } else if (value.item.type === "message") {
              if (Option.isSome(currentTextId)) {
                controller.enqueue({
                  type: "text-end",
                  id: currentTextId.value,
                })
                currentTextId = Option.none()
              }
            } else if (isResponseOutputItemDoneReasoningChunk(value)) {
              const activeReasoningPart = MutableHashMap.get(activeReasoning, value.output_index)
              if (Option.isSome(activeReasoningPart)) {
                for (const summaryIndex of activeReasoningPart.value.summaryParts) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: `${activeReasoningPart.value.canonicalId}:${summaryIndex}`,
                    providerMetadata: {
                      copilot: encodeReasoningMetadata({
                        itemId: activeReasoningPart.value.canonicalId,
                        reasoningEncryptedContent: Option.fromNullishOr(value.item.encrypted_content),
                      }),
                    },
                  })
                }
                MutableHashMap.remove(activeReasoning, value.output_index)
                if (Option.exists(currentReasoningOutputIndex, (index) => index === value.output_index)) {
                  currentReasoningOutputIndex = Option.none()
                }
              }
            }
          } else if (isResponseFunctionCallArgumentsDeltaChunk(value)) {
            const toolCall = MutableHashMap.get(ongoingToolCalls, value.output_index)

            if (Option.isSome(toolCall)) {
              controller.enqueue({
                type: "tool-input-delta",
                id: toolCall.value.toolCallId,
                delta: value.delta,
              })
            }
          } else if (isResponseImageGenerationCallPartialImageChunk(value)) {
            controller.enqueue({
              type: "tool-result",
              toolCallId: value.item_id,
              toolName: "image_generation",
              result: {
                result: value.partial_image_b64,
              } satisfies typeof imageGenerationOutputSchema.Type,
            })
          } else if (isResponseCodeInterpreterCallCodeDeltaChunk(value)) {
            const toolCall = MutableHashMap.get(ongoingToolCalls, value.output_index)

            if (Option.isSome(toolCall)) {
              controller.enqueue({
                type: "tool-input-delta",
                id: toolCall.value.toolCallId,
                // The delta is code, which is embedded in a JSON string.
                // To escape it, we quote it as a JSON string and slice off the outer quotes.
                delta: quoteJsonString(value.delta).slice(1, -1),
              })
            }
          } else if (isResponseCodeInterpreterCallCodeDoneChunk(value)) {
            const toolCall = MutableHashMap.get(ongoingToolCalls, value.output_index)

            if (Option.isSome(toolCall)) {
              controller.enqueue({
                type: "tool-input-delta",
                id: toolCall.value.toolCallId,
                delta: '"}',
              })

              controller.enqueue({
                type: "tool-input-end",
                id: toolCall.value.toolCallId,
              })

              // immediately send the tool call after the input end:
              controller.enqueue({
                type: "tool-call",
                toolCallId: toolCall.value.toolCallId,
                toolName: "code_interpreter",
                input: encodeCodeInterpreterInput({
                  code: value.code,
                  containerId: toolCall.value.codeInterpreter!.containerId,
                }),
                providerExecuted: true,
              })
            }
          } else if (isResponseCreatedChunk(value)) {
            responseId = Option.some(value.response.id)
            controller.enqueue({
              type: "response-metadata",
              id: value.response.id,
              timestamp: DateTime.toDateUtc(DateTime.fromEpochSeconds(value.response.created_at)),
              modelId: value.response.model,
            })
          } else if (isTextDeltaChunk(value)) {
            // Ensure a text-start exists, and normalize deltas to a stable id
            const textId = Option.getOrElse(currentTextId, () => value.item_id)
            if (Option.isNone(currentTextId)) {
              controller.enqueue({
                type: "text-start",
                id: textId,
                providerMetadata: {
                  copilot: { itemId: value.item_id },
                },
              })
            }
            currentTextId = Option.some(textId)

            controller.enqueue({
              type: "text-delta",
              id: textId,
              delta: value.delta,
            })

            if (options.providerOptions?.copilot?.logprobs && value.logprobs) {
              logprobs = Chunk.append(logprobs, value.logprobs)
            }
          } else if (isResponseReasoningSummaryPartAddedChunk(value)) {
            const outputIndex = currentReasoningOutputIndex
            const activeItem = Option.flatMap(outputIndex, (index) => MutableHashMap.get(activeReasoning, index))

            // the first reasoning start is pushed in isResponseOutputItemAddedReasoningChunk.
            if (Option.isSome(outputIndex) && Option.isSome(activeItem) && value.summary_index > 0) {
              MutableHashMap.set(activeReasoning, outputIndex.value, {
                ...activeItem.value,
                summaryParts: [...activeItem.value.summaryParts, value.summary_index],
              })

              controller.enqueue({
                type: "reasoning-start",
                id: `${activeItem.value.canonicalId}:${value.summary_index}`,
                providerMetadata: {
                  copilot: encodeReasoningMetadata({
                    itemId: activeItem.value.canonicalId,
                    reasoningEncryptedContent: activeItem.value.encryptedContent,
                  }),
                },
              })
            }
          } else if (isResponseReasoningSummaryTextDeltaChunk(value)) {
            const activeItem = Option.flatMap(currentReasoningOutputIndex, (index) =>
              MutableHashMap.get(activeReasoning, index),
            )

            if (Option.isSome(activeItem)) {
              controller.enqueue({
                type: "reasoning-delta",
                id: `${activeItem.value.canonicalId}:${value.summary_index}`,
                delta: value.delta,
                providerMetadata: {
                  copilot: {
                    itemId: activeItem.value.canonicalId,
                  },
                },
              })
            }
          } else if (isResponseFinishedChunk(value)) {
            finishReason = {
              unified: mapOpenAIResponseFinishReason({
                finishReason: value.response.incomplete_details?.reason,
                hasFunctionCall,
              }),
              raw: Option.fromNullishOr(value.response.incomplete_details?.reason),
            }
            usage = {
              input: Option.some(value.response.usage.input_tokens),
              output: Option.some(value.response.usage.output_tokens),
              total: Option.some(value.response.usage.input_tokens + value.response.usage.output_tokens),
              cachedInput: Option.fromNullishOr(value.response.usage.input_tokens_details?.cached_tokens),
              reasoning: Option.fromNullishOr(value.response.usage.output_tokens_details?.reasoning_tokens),
            }
            if (typeof value.response.service_tier === "string") {
              serviceTier = Option.some(value.response.service_tier)
            }
          } else if (isResponseAnnotationAddedChunk(value)) {
            if (value.annotation.type === "url_citation") {
              controller.enqueue({
                type: "source",
                sourceType: "url",
                id: config.generateId?.() ?? generateId(),
                url: value.annotation.url,
                title: value.annotation.title,
              })
            } else if (value.annotation.type === "file_citation") {
              controller.enqueue({
                type: "source",
                sourceType: "document",
                id: config.generateId?.() ?? generateId(),
                mediaType: "text/plain",
                title: value.annotation.quote ?? value.annotation.filename ?? "Document",
                filename: value.annotation.filename ?? value.annotation.file_id,
              })
            }
          } else if (isErrorChunk(value)) {
            controller.enqueue({ type: "error", error: value })
          }
        },

        flush(controller) {
          // Close any dangling text part
          if (Option.isSome(currentTextId)) {
            controller.enqueue({ type: "text-end", id: currentTextId.value })
            currentTextId = Option.none()
          }

          const providerMetadata: SharedV3ProviderMetadata = {
            copilot: {
              responseId: encodeNullableString(responseId),
              ...(Chunk.isNonEmpty(logprobs) && { logprobs: Chunk.toArray(logprobs) }),
              ...(Option.isSome(serviceTier) && { serviceTier: serviceTier.value }),
            },
          }

          controller.enqueue({
            type: "finish",
            finishReason: { unified: finishReason.unified, raw: Option.getOrUndefined(finishReason.raw) },
            usage: toUsage(usage, {
              input_tokens: Option.getOrUndefined(usage.input),
              output_tokens: Option.getOrUndefined(usage.output),
              total_tokens: Option.getOrUndefined(usage.total),
            }),
            providerMetadata,
          })
        },
      }),
    ),
    request: { body },
    response: { headers: responseHeaders },
  }
})

const textDeltaChunkSchema = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  item_id: ItemID,
  delta: Schema.String,
  logprobs: Schema.optional(Schema.NullOr(LOGPROBS_SCHEMA)),
}).annotate({ identifier: "CopilotResponses.TextDeltaChunk" })

const errorChunkSchema = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.String,
  message: Schema.String,
  param: Schema.optional(Schema.NullOr(Schema.String)),
  sequence_number: Schema.Finite,
}).annotate({ identifier: "CopilotResponses.ErrorChunk" })

const responseFinishedChunkSchema = Schema.Struct({
  type: Schema.Literals(["response.completed", "response.incomplete"]),
  response: Schema.Struct({
    incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
    usage: usageSchema,
    service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  }),
}).annotate({ identifier: "CopilotResponses.ResponseFinishedChunk" })

const responseCreatedChunkSchema = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Schema.Struct({
    id: ItemID,
    created_at: Schema.Finite,
    model: Schema.String,
    service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  }),
}).annotate({ identifier: "CopilotResponses.ResponseCreatedChunk" })

const responseOutputItemAddedSchema = Schema.Struct({
  type: Schema.Literal("response.output_item.added"),
  output_index: Schema.Finite,
  item: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("message"),
      id: ItemID,
    }),
    Schema.Struct({
      type: Schema.Literal("reasoning"),
      id: ItemID,
      encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    Schema.Struct({
      type: Schema.Literal("function_call"),
      id: ItemID,
      call_id: CallID,
      name: Schema.String,
      arguments: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("web_search_call"),
      id: ItemID,
      status: Schema.String,
      action: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            type: Schema.Literal("search"),
            query: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
    Schema.Struct({
      type: Schema.Literal("computer_call"),
      id: ItemID,
      status: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("file_search_call"),
      id: ItemID,
    }),
    Schema.Struct({
      type: Schema.Literal("image_generation_call"),
      id: ItemID,
    }),
    Schema.Struct({
      type: Schema.Literal("code_interpreter_call"),
      id: ItemID,
      container_id: ContainerID,
      code: Schema.NullOr(Schema.String),
      outputs: Schema.NullOr(
        Schema.Array(
          Schema.Union([
            Schema.Struct({ type: Schema.Literal("logs"), logs: Schema.String }),
            Schema.Struct({ type: Schema.Literal("image"), url: Schema.String }),
          ]),
        ),
      ),
      status: Schema.String,
    }),
  ]),
}).annotate({ identifier: "CopilotResponses.OutputItemAddedChunk" })

const responseOutputItemDoneSchema = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  output_index: Schema.Finite,
  item: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("message"),
      id: ItemID,
    }),
    Schema.Struct({
      type: Schema.Literal("reasoning"),
      id: ItemID,
      encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    Schema.Struct({
      type: Schema.Literal("function_call"),
      id: ItemID,
      call_id: CallID,
      name: Schema.String,
      arguments: Schema.String,
      status: Schema.Literal("completed"),
    }),
    codeInterpreterCallItem,
    imageGenerationCallItem,
    webSearchCallItem,
    fileSearchCallItem,
    localShellCallItem,
    Schema.Struct({
      type: Schema.Literal("computer_call"),
      id: ItemID,
      status: Schema.Literal("completed"),
    }),
  ]),
}).annotate({ identifier: "CopilotResponses.OutputItemDoneChunk" })

const responseFunctionCallArgumentsDeltaSchema = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.delta"),
  item_id: ItemID,
  output_index: Schema.Finite,
  delta: Schema.String,
}).annotate({ identifier: "CopilotResponses.FunctionCallArgumentsDeltaChunk" })

const responseImageGenerationCallPartialImageSchema = Schema.Struct({
  type: Schema.Literal("response.image_generation_call.partial_image"),
  item_id: ItemID,
  output_index: Schema.Finite,
  partial_image_b64: Schema.String,
}).annotate({ identifier: "CopilotResponses.ImageGenerationCallPartialImageChunk" })

const responseCodeInterpreterCallCodeDeltaSchema = Schema.Struct({
  type: Schema.Literal("response.code_interpreter_call_code.delta"),
  item_id: ItemID,
  output_index: Schema.Finite,
  delta: Schema.String,
}).annotate({ identifier: "CopilotResponses.CodeInterpreterCallCodeDeltaChunk" })

const responseCodeInterpreterCallCodeDoneSchema = Schema.Struct({
  type: Schema.Literal("response.code_interpreter_call_code.done"),
  item_id: ItemID,
  output_index: Schema.Finite,
  code: Schema.String,
}).annotate({ identifier: "CopilotResponses.CodeInterpreterCallCodeDoneChunk" })

const responseAnnotationAddedSchema = Schema.Struct({
  type: Schema.Literal("response.output_text.annotation.added"),
  annotation: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("url_citation"),
      url: Schema.String,
      title: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("file_citation"),
      file_id: FileID,
      filename: Schema.optional(Schema.NullOr(Schema.String)),
      index: Schema.optional(Schema.NullOr(Schema.Finite)),
      start_index: Schema.optional(Schema.NullOr(Schema.Finite)),
      end_index: Schema.optional(Schema.NullOr(Schema.Finite)),
      quote: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ]),
}).annotate({ identifier: "CopilotResponses.AnnotationAddedChunk" })

const responseReasoningSummaryPartAddedSchema = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_part.added"),
  item_id: ItemID,
  summary_index: Schema.Finite,
}).annotate({ identifier: "CopilotResponses.ReasoningSummaryPartAddedChunk" })

const responseReasoningSummaryTextDeltaSchema = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  item_id: ItemID,
  summary_index: Schema.Finite,
  delta: Schema.String,
}).annotate({ identifier: "CopilotResponses.ReasoningSummaryTextDeltaChunk" })

// A chunk of another type keeps every key that the Responses API sent.
const unknownChunkSchema = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]).annotate({ identifier: "CopilotResponses.UnknownChunk" })

const openaiResponsesChunkSchema = Schema.Union([
  textDeltaChunkSchema,
  responseFinishedChunkSchema,
  responseCreatedChunkSchema,
  responseOutputItemAddedSchema,
  responseOutputItemDoneSchema,
  responseFunctionCallArgumentsDeltaSchema,
  responseImageGenerationCallPartialImageSchema,
  responseCodeInterpreterCallCodeDeltaSchema,
  responseCodeInterpreterCallCodeDoneSchema,
  responseAnnotationAddedSchema,
  responseReasoningSummaryPartAddedSchema,
  responseReasoningSummaryTextDeltaSchema,
  errorChunkSchema,
  unknownChunkSchema, // fallback for unknown chunks
])

type OpenAIResponsesChunk = typeof openaiResponsesChunkSchema.Type

type ExtractByType<T, K extends T extends { type: infer U } ? U : never> = T extends { type: K } ? T : never

function isTextDeltaChunk(chunk: OpenAIResponsesChunk): chunk is typeof textDeltaChunkSchema.Type {
  return chunk.type === "response.output_text.delta"
}

function isResponseOutputItemDoneChunk(chunk: OpenAIResponsesChunk): chunk is typeof responseOutputItemDoneSchema.Type {
  return chunk.type === "response.output_item.done"
}

function isResponseOutputItemDoneReasoningChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseOutputItemDoneSchema.Type & {
  item: ExtractByType<(typeof responseOutputItemDoneSchema.Type)["item"], "reasoning">
} {
  return isResponseOutputItemDoneChunk(chunk) && chunk.item.type === "reasoning"
}

function isResponseFinishedChunk(chunk: OpenAIResponsesChunk): chunk is typeof responseFinishedChunkSchema.Type {
  return chunk.type === "response.completed" || chunk.type === "response.incomplete"
}

function isResponseCreatedChunk(chunk: OpenAIResponsesChunk): chunk is typeof responseCreatedChunkSchema.Type {
  return chunk.type === "response.created"
}

function isResponseFunctionCallArgumentsDeltaChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseFunctionCallArgumentsDeltaSchema.Type {
  return chunk.type === "response.function_call_arguments.delta"
}
function isResponseImageGenerationCallPartialImageChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseImageGenerationCallPartialImageSchema.Type {
  return chunk.type === "response.image_generation_call.partial_image"
}

function isResponseCodeInterpreterCallCodeDeltaChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseCodeInterpreterCallCodeDeltaSchema.Type {
  return chunk.type === "response.code_interpreter_call_code.delta"
}

function isResponseCodeInterpreterCallCodeDoneChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseCodeInterpreterCallCodeDoneSchema.Type {
  return chunk.type === "response.code_interpreter_call_code.done"
}

function isResponseOutputItemAddedChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseOutputItemAddedSchema.Type {
  return chunk.type === "response.output_item.added"
}

function isResponseOutputItemAddedReasoningChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseOutputItemAddedSchema.Type & {
  item: ExtractByType<(typeof responseOutputItemAddedSchema.Type)["item"], "reasoning">
} {
  return isResponseOutputItemAddedChunk(chunk) && chunk.item.type === "reasoning"
}

function isResponseAnnotationAddedChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseAnnotationAddedSchema.Type {
  return chunk.type === "response.output_text.annotation.added"
}

function isResponseReasoningSummaryPartAddedChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseReasoningSummaryPartAddedSchema.Type {
  return chunk.type === "response.reasoning_summary_part.added"
}

function isResponseReasoningSummaryTextDeltaChunk(
  chunk: OpenAIResponsesChunk,
): chunk is typeof responseReasoningSummaryTextDeltaSchema.Type {
  return chunk.type === "response.reasoning_summary_text.delta"
}

function isErrorChunk(chunk: OpenAIResponsesChunk): chunk is typeof errorChunkSchema.Type {
  return chunk.type === "error"
}

type ResponsesModelConfig = {
  isReasoningModel: boolean
  systemMessageMode: "remove" | "system" | "developer"
  requiredAutoTruncation: boolean
  supportsFlexProcessing: boolean
  supportsPriorityProcessing: boolean
}

function getResponsesModelConfig(modelId: string): ResponsesModelConfig {
  const supportsFlexProcessing =
    modelId.startsWith("o3") ||
    modelId.startsWith("o4-mini") ||
    (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat"))
  const supportsPriorityProcessing =
    modelId.startsWith("gpt-4") ||
    modelId.startsWith("gpt-5-mini") ||
    (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-nano") && !modelId.startsWith("gpt-5-chat")) ||
    modelId.startsWith("o3") ||
    modelId.startsWith("o4-mini")
  const defaults = {
    requiredAutoTruncation: false,
    systemMessageMode: "system" as const,
    supportsFlexProcessing,
    supportsPriorityProcessing,
  }

  // gpt-5-chat models are non-reasoning
  if (modelId.startsWith("gpt-5-chat")) {
    return {
      ...defaults,
      isReasoningModel: false,
    }
  }

  // o series reasoning models:
  if (
    modelId.startsWith("o") ||
    modelId.startsWith("gpt-5") ||
    modelId.startsWith("codex-") ||
    modelId.startsWith("computer-use")
  ) {
    if (modelId.startsWith("o1-mini") || modelId.startsWith("o1-preview")) {
      return {
        ...defaults,
        isReasoningModel: true,
        systemMessageMode: "remove",
      }
    }

    return {
      ...defaults,
      isReasoningModel: true,
      systemMessageMode: "developer",
    }
  }

  // gpt models:
  return {
    ...defaults,
    isReasoningModel: false,
  }
}

// TODO AI SDK 6: use optional here instead of nullish
const openaiResponsesProviderOptionsSchema = Schema.Struct({
  include: Schema.optional(
    Schema.NullOr(
      Schema.mutable(
        Schema.Array(
          Schema.Literals(["reasoning.encrypted_content", "file_search_call.results", "message.output_text.logprobs"]),
        ),
      ),
    ),
  ),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),

  /**
   * Return the log probabilities of the tokens.
   *
   * Setting to true will return the log probabilities of the tokens that
   * were generated.
   *
   * Setting to a number will return the log probabilities of the top n
   * tokens that were generated.
   *
   * @see https://platform.openai.com/docs/api-reference/responses/create
   * @see https://cookbook.openai.com/examples/using_logprobs
   */
  logprobs: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: TOP_LOGPROBS_MAX }))]),
  ),

  /**
   * The maximum number of total calls to built-in tools that can be processed in a response.
   * This maximum number applies across all built-in tool calls, not per individual tool.
   * Any further attempts to call a tool by the model will be ignored.
   */
  maxToolCalls: Schema.optional(Schema.NullOr(Schema.Finite)),

  metadata: Schema.optional(Schema.NullOr(Schema.MutableJson)),
  parallelToolCalls: Schema.optional(Schema.NullOr(Schema.Boolean)),
  previousResponseId: Schema.optional(Schema.NullOr(Schema.String)),
  promptCacheKey: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningSummary: Schema.optional(Schema.NullOr(Schema.String)),
  safetyIdentifier: Schema.optional(Schema.NullOr(Schema.String)),
  serviceTier: Schema.optional(Schema.NullOr(Schema.Literals(["auto", "flex", "priority"]))),
  store: Schema.optional(Schema.NullOr(Schema.Boolean)),
  strictJsonSchema: Schema.optional(Schema.NullOr(Schema.Boolean)),
  textVerbosity: Schema.optional(Schema.NullOr(Schema.Literals(["low", "medium", "high"]))),
  user: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "CopilotResponses.ProviderOptions" })

export type OpenAIResponsesProviderOptions = typeof openaiResponsesProviderOptionsSchema.Type

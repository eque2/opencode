import {
  type LanguageModelV3FilePart,
  type LanguageModelV3Prompt,
  type LanguageModelV3TextPart,
  type SharedV3Warning,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider"
import { convertToBase64, parseProviderOptions } from "@ai-sdk/provider-utils"
import { Chunk, Effect, HashMap, HashSet, Option, Schema } from "effect"
import type {
  OpenAIResponsesInputItem,
  OpenAIResponsesReasoning,
  OpenAIResponsesUserMessage,
} from "./openai-responses-api-types"
import { ResponsesCallError } from "./openai-error"
import { localShellInputSchema, localShellOutputSchema } from "./tool/local-shell"

const openaiResponsesReasoningProviderOptionsSchema = Schema.Struct({
  itemId: Schema.optional(Schema.NullOr(Schema.String)),
  reasoningEncryptedContent: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "CopilotResponses.ReasoningProviderOptions" })

export type OpenAIResponsesReasoningProviderOptions = typeof openaiResponsesReasoningProviderOptionsSchema.Type

/**
 * Check if a string is a file ID based on the given prefixes
 * Returns false if prefixes is undefined (disables file ID detection)
 */
function isFileId(data: string, prefixes?: readonly string[]): boolean {
  if (!prefixes) return false
  return prefixes.some((prefix) => data.startsWith(prefix))
}

export const convertToOpenAIResponsesInput = Effect.fn("CopilotResponses.convertToOpenAIResponsesInput")(function* ({
  prompt,
  systemMessageMode,
  fileIdPrefixes,
  store,
  hasLocalShellTool = false,
}: {
  prompt: LanguageModelV3Prompt
  systemMessageMode: "system" | "developer" | "remove"
  fileIdPrefixes?: readonly string[]
  store: boolean
  hasLocalShellTool?: boolean
}) {
  let input = Chunk.empty<OpenAIResponsesInputItem>()
  let warnings = Chunk.empty<SharedV3Warning>()
  let processedApprovalIds = HashSet.empty<string>()

  for (const { role, content } of prompt) {
    switch (role) {
      case "system": {
        switch (systemMessageMode) {
          case "system": {
            input = Chunk.append(input, { role: "system", content })
            break
          }
          case "developer": {
            input = Chunk.append(input, { role: "developer", content })
            break
          }
          case "remove": {
            warnings = Chunk.append(warnings, {
              type: "other",
              message: "system messages are removed for this model",
            })
            break
          }
          default: {
            const _exhaustiveCheck: never = systemMessageMode
            return yield* unsupported(`system message mode ${String(_exhaustiveCheck)}`)
          }
        }
        break
      }

      case "user": {
        const userContent = yield* Effect.forEach(content, (part, index) =>
          toUserContentPart(part, index, fileIdPrefixes),
        )
        input = Chunk.append(input, { role: "user", content: userContent })

        break
      }

      case "assistant": {
        let messageInput: ReadonlyArray<OpenAIResponsesInputItem> = []
        // Position in messageInput of the item for each reasoning id: later parts with the id extend that item.
        let reasoningIndex = HashMap.empty<string, number>()

        for (const part of content) {
          switch (part.type) {
            case "text": {
              messageInput = [
                ...messageInput,
                {
                  role: "assistant",
                  content: [{ type: "output_text", text: part.text }],
                  id: (part.providerOptions?.copilot?.itemId as string) ?? undefined,
                },
              ]
              break
            }
            case "tool-call": {
              if (part.providerExecuted) {
                break
              }

              if (hasLocalShellTool && part.toolName === "local_shell") {
                const parsedInput = yield* decodeLocalShellInput(part.input)
                messageInput = [
                  ...messageInput,
                  {
                    type: "local_shell_call",
                    call_id: part.toolCallId,
                    id: (part.providerOptions?.copilot?.itemId as string) ?? undefined,
                    action: {
                      type: "exec",
                      command: parsedInput.action.command,
                      timeout_ms: parsedInput.action.timeoutMs,
                      user: parsedInput.action.user,
                      working_directory: parsedInput.action.workingDirectory,
                      env: parsedInput.action.env,
                    },
                  },
                ]

                break
              }

              const functionArguments = yield* encodeJsonText(part.input)
              messageInput = [
                ...messageInput,
                {
                  type: "function_call",
                  call_id: part.toolCallId,
                  name: part.toolName,
                  arguments: functionArguments,
                  id: (part.providerOptions?.copilot?.itemId as string) ?? undefined,
                },
              ]
              break
            }

            // assistant tool result parts are from provider-executed tools:
            case "tool-result": {
              if (store) {
                // use item references to refer to tool results from built-in tools
                messageInput = [...messageInput, { type: "item_reference", id: part.toolCallId }]
              } else {
                warnings = Chunk.append(warnings, {
                  type: "other",
                  message: `Results for OpenAI tool ${part.toolName} are not sent to the API when store is false`,
                })
              }

              break
            }

            case "reasoning": {
              const providerOptions = yield* Effect.tryPromise({
                try: () =>
                  parseProviderOptions({
                    provider: "copilot",
                    providerOptions: part.providerOptions,
                    schema: Schema.toStandardSchemaV1(openaiResponsesReasoningProviderOptionsSchema),
                  }),
                catch: (cause) => new ResponsesCallError({ cause }),
              })

              const reasoningId = providerOptions?.itemId

              if (reasoningId != null) {
                const reasoningAt = HashMap.get(reasoningIndex, reasoningId)

                if (store) {
                  if (Option.isNone(reasoningAt)) {
                    // use item references to refer to reasoning (single reference)
                    reasoningIndex = HashMap.set(reasoningIndex, reasoningId, messageInput.length)
                    messageInput = [...messageInput, { type: "item_reference", id: reasoningId }]
                  }
                } else {
                  const summaryParts: OpenAIResponsesReasoning["summary"] =
                    part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : []

                  if (part.text.length === 0 && Option.isSome(reasoningAt)) {
                    const partJson = yield* encodeJsonText(part)
                    warnings = Chunk.append(warnings, {
                      type: "other",
                      message: `Cannot append empty reasoning part to existing reasoning sequence. Skipping reasoning part: ${partJson}.`,
                    })
                  }

                  if (Option.isNone(reasoningAt)) {
                    reasoningIndex = HashMap.set(reasoningIndex, reasoningId, messageInput.length)
                    messageInput = [
                      ...messageInput,
                      {
                        type: "reasoning",
                        id: reasoningId,
                        encrypted_content: providerOptions?.reasoningEncryptedContent,
                        summary: summaryParts,
                      },
                    ]
                  } else {
                    messageInput = appendReasoningSummary(messageInput, reasoningAt.value, summaryParts)
                  }
                }
              } else {
                const partJson = yield* encodeJsonText(part)
                warnings = Chunk.append(warnings, {
                  type: "other",
                  message: `Non-OpenAI reasoning parts are not supported. Skipping reasoning part: ${partJson}.`,
                })
              }
              break
            }
          }
        }

        input = Chunk.appendAll(input, Chunk.fromIterable(messageInput))
        break
      }

      case "tool": {
        for (const part of content) {
          if (part.type === "tool-approval-response") {
            if (HashSet.has(processedApprovalIds, part.approvalId)) {
              continue
            }
            processedApprovalIds = HashSet.add(processedApprovalIds, part.approvalId)

            if (store) {
              input = Chunk.append(input, {
                type: "item_reference",
                id: part.approvalId,
              })
            }

            input = Chunk.append(input, {
              type: "mcp_approval_response",
              approval_request_id: part.approvalId,
              approve: part.approved,
            })
            continue
          }
          const output = part.output

          if (output.type === "execution-denied") {
            const approvalId = (output.providerOptions?.copilot as { approvalId?: string } | undefined)?.approvalId

            if (approvalId) {
              continue
            }
          }

          if (hasLocalShellTool && part.toolName === "local_shell" && output.type === "json") {
            const localShellOutput = yield* decodeLocalShellOutput(output.value)
            input = Chunk.append(input, {
              type: "local_shell_call_output",
              call_id: part.toolCallId,
              output: localShellOutput.output,
            })
            break
          }

          let contentValue: string
          switch (output.type) {
            case "text":
            case "error-text":
              contentValue = output.value
              break
            case "execution-denied":
              contentValue = output.reason ?? "Tool execution denied."
              break
            case "content":
            case "json":
            case "error-json":
              contentValue = yield* encodeJsonText(output.value)
              break
          }

          input = Chunk.append(input, {
            type: "function_call_output",
            call_id: part.toolCallId,
            output: contentValue,
          })
        }

        break
      }

      default: {
        const _exhaustiveCheck: never = role
        return yield* unsupported(`role ${String(_exhaustiveCheck)}`)
      }
    }
  }

  return { input: Chunk.toArray(input), warnings: Chunk.toArray(warnings) }
})

// Extend the reasoning item at `index` with more summary parts.
const appendReasoningSummary = (
  items: ReadonlyArray<OpenAIResponsesInputItem>,
  index: number,
  summaryParts: OpenAIResponsesReasoning["summary"],
): ReadonlyArray<OpenAIResponsesInputItem> =>
  items.map((item, position) =>
    position === index && "type" in item && item.type === "reasoning"
      ? { ...item, summary: [...item.summary, ...summaryParts] }
      : item,
  )

// An input that the Responses API cannot take fails the call with the AI SDK error for it.
const unsupported = (functionality: string) =>
  Effect.fail(new ResponsesCallError({ cause: new UnsupportedFunctionalityError({ functionality }) }))

// JSON text for values that the AI SDK types as unknown or JSONValue: tool inputs, tool outputs and prompt parts.
const encodeJsonText = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError((cause) => new ResponsesCallError({ cause })),
  )

const decodeLocalShellInput = (input: unknown) =>
  Schema.decodeUnknownEffect(localShellInputSchema)(input).pipe(
    Effect.mapError((cause) => new ResponsesCallError({ cause })),
  )

const decodeLocalShellOutput = (output: unknown) =>
  Schema.decodeUnknownEffect(localShellOutputSchema)(output).pipe(
    Effect.mapError((cause) => new ResponsesCallError({ cause })),
  )

type OpenAIResponsesUserContentPart = OpenAIResponsesUserMessage["content"][number]

// A user text or file part as a Responses input part. Images and PDFs are the only supported files.
function toUserContentPart(
  part: LanguageModelV3TextPart | LanguageModelV3FilePart,
  index: number,
  fileIdPrefixes: readonly string[] | undefined,
): Effect.Effect<OpenAIResponsesUserContentPart, ResponsesCallError> {
  if (part.type === "text") return Effect.succeed({ type: "input_text", text: part.text })

  if (part.mediaType.startsWith("image/")) {
    const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType
    // The Responses API reads `detail`, but the input types here do not declare it.
    const image = {
      type: "input_image" as const,
      ...(part.data instanceof URL
        ? { image_url: part.data.toString() }
        : typeof part.data === "string" && isFileId(part.data, fileIdPrefixes)
          ? { file_id: part.data }
          : {
              image_url: `data:${mediaType};base64,${convertToBase64(part.data)}`,
            }),
      detail: part.providerOptions?.copilot?.imageDetail,
    }
    return Effect.succeed(image)
  }

  if (part.mediaType === "application/pdf") {
    if (part.data instanceof URL) {
      return Effect.succeed({
        type: "input_file",
        file_url: part.data.toString(),
      })
    }
    return Effect.succeed({
      type: "input_file",
      ...(typeof part.data === "string" && isFileId(part.data, fileIdPrefixes)
        ? { file_id: part.data }
        : {
            filename: part.filename ?? `part-${index}.pdf`,
            file_data: `data:application/pdf;base64,${convertToBase64(part.data)}`,
          }),
    })
  }

  return unsupported(`file part media type ${part.mediaType}`)
}

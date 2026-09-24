import {
  type LanguageModelV3FilePart,
  type LanguageModelV3Prompt,
  type LanguageModelV3TextPart,
  type LanguageModelV3ToolCallPart,
  type SharedV3Warning,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider"
import { convertToBase64, parseProviderOptions } from "@ai-sdk/provider-utils"
import { Effect, HashSet, Schema } from "effect"
import type {
  OpenAIResponsesInput,
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
  const input: OpenAIResponsesInput = []
  const warnings: Array<SharedV3Warning> = []
  let processedApprovalIds = HashSet.empty<string>()

  for (const { role, content } of prompt) {
    switch (role) {
      case "system": {
        switch (systemMessageMode) {
          case "system": {
            input.push({ role: "system", content })
            break
          }
          case "developer": {
            input.push({ role: "developer", content })
            break
          }
          case "remove": {
            warnings.push({
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
        input.push({ role: "user", content: userContent })

        break
      }

      case "assistant": {
        const reasoningMessages: Record<string, OpenAIResponsesReasoning> = {}
        const toolCallParts: Record<string, LanguageModelV3ToolCallPart> = {}

        for (const part of content) {
          switch (part.type) {
            case "text": {
              input.push({
                role: "assistant",
                content: [{ type: "output_text", text: part.text }],
                id: (part.providerOptions?.copilot?.itemId as string) ?? undefined,
              })
              break
            }
            case "tool-call": {
              toolCallParts[part.toolCallId] = part

              if (part.providerExecuted) {
                break
              }

              if (hasLocalShellTool && part.toolName === "local_shell") {
                const parsedInput = yield* decodeLocalShellInput(part.input)
                input.push({
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
                })

                break
              }

              input.push({
                type: "function_call",
                call_id: part.toolCallId,
                name: part.toolName,
                arguments: JSON.stringify(part.input),
                id: (part.providerOptions?.copilot?.itemId as string) ?? undefined,
              })
              break
            }

            // assistant tool result parts are from provider-executed tools:
            case "tool-result": {
              if (store) {
                // use item references to refer to tool results from built-in tools
                input.push({ type: "item_reference", id: part.toolCallId })
              } else {
                warnings.push({
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
                const reasoningMessage = reasoningMessages[reasoningId]

                if (store) {
                  if (reasoningMessage === undefined) {
                    // use item references to refer to reasoning (single reference)
                    input.push({ type: "item_reference", id: reasoningId })

                    // store unused reasoning message to mark id as used
                    reasoningMessages[reasoningId] = {
                      type: "reasoning",
                      id: reasoningId,
                      summary: [],
                    }
                  }
                } else {
                  const summaryParts: Array<{
                    type: "summary_text"
                    text: string
                  }> = []

                  if (part.text.length > 0) {
                    summaryParts.push({
                      type: "summary_text",
                      text: part.text,
                    })
                  } else if (reasoningMessage !== undefined) {
                    warnings.push({
                      type: "other",
                      message: `Cannot append empty reasoning part to existing reasoning sequence. Skipping reasoning part: ${JSON.stringify(part)}.`,
                    })
                  }

                  if (reasoningMessage === undefined) {
                    reasoningMessages[reasoningId] = {
                      type: "reasoning",
                      id: reasoningId,
                      encrypted_content: providerOptions?.reasoningEncryptedContent,
                      summary: summaryParts,
                    }
                    input.push(reasoningMessages[reasoningId])
                  } else {
                    reasoningMessage.summary.push(...summaryParts)
                  }
                }
              } else {
                warnings.push({
                  type: "other",
                  message: `Non-OpenAI reasoning parts are not supported. Skipping reasoning part: ${JSON.stringify(part)}.`,
                })
              }
              break
            }
          }
        }

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
              input.push({
                type: "item_reference",
                id: part.approvalId,
              })
            }

            input.push({
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
            input.push({
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
              contentValue = JSON.stringify(output.value)
              break
          }

          input.push({
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

  return { input, warnings }
})

// An input that the Responses API cannot take fails the call with the AI SDK error for it.
const unsupported = (functionality: string) =>
  Effect.fail(new ResponsesCallError({ cause: new UnsupportedFunctionalityError({ functionality }) }))

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

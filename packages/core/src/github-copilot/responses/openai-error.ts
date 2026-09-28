import type { APICallError } from "@ai-sdk/provider"
import { createJsonErrorResponseHandler, type ResponseHandler } from "@ai-sdk/provider-utils"
import { Schema } from "effect"

export const openaiErrorDataSchema = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,

    // The additional information below is handled loosely to support
    // OpenAI-compatible providers that have slightly different error
    // responses:
    type: Schema.optional(Schema.NullOr(Schema.String)),
    param: Schema.optional(Schema.Json),
    code: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
  }),
}).annotate({ identifier: "CopilotResponses.OpenAIErrorData" })

export type OpenAIErrorData = typeof openaiErrorDataSchema.Type

export const openaiFailedResponseHandler: ResponseHandler<APICallError> = createJsonErrorResponseHandler({
  errorSchema: Schema.toStandardSchemaV1(openaiErrorDataSchema),
  errorToMessage: (data) => data.error.message,
})

/**
 * A failed Copilot Responses call. The cause is the original AI SDK error (for example APICallError or an abort
 * error): the language model rejects with it unchanged, because the AI SDK reads its own error classes.
 */
export class ResponsesCallError extends Schema.TaggedError<ResponsesCallError>()("CopilotResponses.CallError", {
  cause: Schema.Defect(),
}) {}

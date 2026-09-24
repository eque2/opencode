import { Schema } from "effect"

export const openaiCompatibleErrorDataSchema = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,

    // The additional information below is handled loosely to support
    // OpenAI-compatible providers that have slightly different error
    // responses:
    type: Schema.optional(Schema.NullOr(Schema.String)),
    param: Schema.optional(Schema.Json),
    code: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  }),
}).annotate({ identifier: "GithubCopilot.OpenAICompatibleErrorData" })

export type OpenAICompatibleErrorData = typeof openaiCompatibleErrorDataSchema.Type

export type ProviderErrorStructure<T> = {
  errorSchema: Schema.Decoder<T>
  errorToMessage: (error: T) => string
  isRetryable?: (response: Response, error?: T) => boolean
}

export const defaultOpenAICompatibleErrorStructure: ProviderErrorStructure<OpenAICompatibleErrorData> = {
  errorSchema: openaiCompatibleErrorDataSchema,
  errorToMessage: (data) => data.error.message,
}

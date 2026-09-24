import { createProviderToolFactoryWithOutputSchema } from "@ai-sdk/provider-utils"
import type {
  OpenAIResponsesFileSearchToolComparisonFilter,
  OpenAIResponsesFileSearchToolCompoundFilter,
} from "../openai-responses-api-types"
import { Schema } from "effect"

// The Responses API names an uploaded file with this id.
export const FileID = Schema.String.pipe(Schema.brand("CopilotResponses.FileID"))

const comparisonFilterSchema = Schema.Struct({
  key: Schema.String,
  type: Schema.Literals(["eq", "ne", "gt", "gte", "lt", "lte"]),
  value: Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]),
}).annotate({ identifier: "CopilotResponses.FileSearchComparisonFilter" })

const compoundFilterSchema: Schema.Codec<OpenAIResponsesFileSearchToolCompoundFilter> = Schema.Struct({
  type: Schema.Literals(["and", "or"]),
  filters: Schema.mutable(
    Schema.Array(
      Schema.Union([
        comparisonFilterSchema,
        Schema.suspend((): Schema.Codec<OpenAIResponsesFileSearchToolCompoundFilter> => compoundFilterSchema),
      ]),
    ),
  ),
}).annotate({ identifier: "CopilotResponses.FileSearchCompoundFilter" })

export const fileSearchArgsSchema = Schema.Struct({
  vectorStoreIds: Schema.mutable(Schema.Array(Schema.String)),
  maxNumResults: Schema.optional(Schema.Finite),
  ranking: Schema.optional(
    Schema.Struct({
      ranker: Schema.optional(Schema.String),
      scoreThreshold: Schema.optional(Schema.Finite),
    }),
  ),
  filters: Schema.optional(Schema.Union([comparisonFilterSchema, compoundFilterSchema])),
}).annotate({ identifier: "CopilotResponses.FileSearchArgs" })

export const fileSearchOutputSchema = Schema.Struct({
  queries: Schema.mutable(Schema.Array(Schema.String)),
  results: Schema.NullOr(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          attributes: Schema.Record(Schema.String, Schema.MutableJson),
          fileId: FileID,
          filename: Schema.String,
          score: Schema.Finite,
          text: Schema.String,
        }),
      ),
    ),
  ),
}).annotate({ identifier: "CopilotResponses.FileSearchOutput" })

export const fileSearch = createProviderToolFactoryWithOutputSchema<
  {},
  {
    /**
     * The search query to execute.
     */
    queries: string[]

    /**
     * The results of the file search tool call.
     */
    results:
      | null
      | {
          /**
           * Set of 16 key-value pairs that can be attached to an object.
           * This can be useful for storing additional information about the object
           * in a structured format, and querying for objects via API or the dashboard.
           * Keys are strings with a maximum length of 64 characters.
           * Values are strings with a maximum length of 512 characters, booleans, or numbers.
           */
          attributes: Record<string, unknown>

          /**
           * The unique ID of the file.
           */
          fileId: string

          /**
           * The name of the file.
           */
          filename: string

          /**
           * The relevance score of the file - a value between 0 and 1.
           */
          score: number

          /**
           * The text that was retrieved from the file.
           */
          text: string
        }[]
  },
  {
    /**
     * List of vector store IDs to search through.
     */
    vectorStoreIds: string[]

    /**
     * Maximum number of search results to return. Defaults to 10.
     */
    maxNumResults?: number

    /**
     * Ranking options for the search.
     */
    ranking?: {
      /**
       * The ranker to use for the file search.
       */
      ranker?: string

      /**
       * The score threshold for the file search, a number between 0 and 1.
       * Numbers closer to 1 will attempt to return only the most relevant results,
       * but may return fewer results.
       */
      scoreThreshold?: number
    }

    /**
     * A filter to apply.
     */
    filters?: OpenAIResponsesFileSearchToolComparisonFilter | OpenAIResponsesFileSearchToolCompoundFilter
  }
>({
  id: "openai.file_search",
  inputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(Schema.Struct({}))),
  outputSchema: Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(fileSearchOutputSchema)),
})

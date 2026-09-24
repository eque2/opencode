import { createProviderToolFactory } from "@ai-sdk/provider-utils"
import { Schema } from "effect"

export const webSearchArgsSchema = Schema.Struct({
  filters: Schema.optional(
    Schema.Struct({
      allowedDomains: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ),

  searchContextSize: Schema.optional(Schema.Literals(["low", "medium", "high"])),

  userLocation: Schema.optional(
    Schema.Struct({
      type: Schema.Literal("approximate"),
      country: Schema.optional(Schema.String),
      city: Schema.optional(Schema.String),
      region: Schema.optional(Schema.String),
      timezone: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "CopilotResponses.WebSearchArgs" })

export const webSearchToolFactory = createProviderToolFactory<
  {
    // Web search doesn't take input parameters - it's controlled by the prompt
  },
  {
    /**
     * Filters for the search.
     */
    filters?: {
      /**
       * Allowed domains for the search.
       * If not provided, all domains are allowed.
       * Subdomains of the provided domains are allowed as well.
       */
      allowedDomains?: string[]
    }

    /**
     * Search context size to use for the web search.
     * - high: Most comprehensive context, highest cost, slower response
     * - medium: Balanced context, cost, and latency (default)
     * - low: Least context, lowest cost, fastest response
     */
    searchContextSize?: "low" | "medium" | "high"

    /**
     * User location information to provide geographically relevant search results.
     */
    userLocation?: {
      /**
       * Type of location (always 'approximate')
       */
      type: "approximate"
      /**
       * Two-letter ISO country code (e.g., 'US', 'GB')
       */
      country?: string
      /**
       * City name (free text, e.g., 'Minneapolis')
       */
      city?: string
      /**
       * Region name (free text, e.g., 'Minnesota')
       */
      region?: string
      /**
       * IANA timezone (e.g., 'America/Chicago')
       */
      timezone?: string
    }
  }
>({
  id: "openai.web_search",
  inputSchema: Schema.toStandardSchemaV1(
    Schema.toStandardJSONSchemaV1(
      Schema.Struct({
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
      }),
    ),
  ),
})

export const webSearch = (
  args: Parameters<typeof webSearchToolFactory>[0] = {}, // default
) => {
  return webSearchToolFactory(args)
}

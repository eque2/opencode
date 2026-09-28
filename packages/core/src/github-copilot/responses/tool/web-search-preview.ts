import { createProviderToolFactory } from "@ai-sdk/provider-utils"
import { Schema } from "effect"

// Args validation schema
export const webSearchPreviewArgsSchema = Schema.Struct({
  /**
   * Search context size to use for the web search.
   * - high: Most comprehensive context, highest cost, slower response
   * - medium: Balanced context, cost, and latency (default)
   * - low: Least context, lowest cost, fastest response
   */
  searchContextSize: Schema.optional(Schema.Literals(["low", "medium", "high"])),

  /**
   * User location information to provide geographically relevant search results.
   */
  userLocation: Schema.optional(
    Schema.Struct({
      /**
       * Type of location (always 'approximate')
       */
      type: Schema.Literal("approximate"),
      /**
       * Two-letter ISO country code (e.g., 'US', 'GB')
       */
      country: Schema.optional(Schema.String),
      /**
       * City name (free text, e.g., 'Minneapolis')
       */
      city: Schema.optional(Schema.String),
      /**
       * Region name (free text, e.g., 'Minnesota')
       */
      region: Schema.optional(Schema.String),
      /**
       * IANA timezone (e.g., 'America/Chicago')
       */
      timezone: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "CopilotResponses.WebSearchPreviewArgs" })

export const webSearchPreview = createProviderToolFactory<
  {
    // Web search doesn't take input parameters - it's controlled by the prompt
  },
  {
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
  id: "openai.web_search_preview",
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

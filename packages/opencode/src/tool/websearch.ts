import { Config, DateTime, Effect, Option, Predicate, Redacted, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

export function selectWebSearchProvider(sessionID: string, flags = { exa: false, parallel: false }): WebSearchProvider {
  // eslint-disable-next-line effect/no-process-env-use-config -- (c) sync export; test/tool/websearch.test.ts pins that it reads the live process.env override on each call
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return override
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

/** The model name for Parallel analytics: the provider API model id, else the model id, cut to 100 characters. */
export function webSearchModelName(extra: Tool.Context["extra"]): Option.Option<string> {
  const model = extra?.model
  if (!model || typeof model !== "object") return Option.none()
  const apiID =
    "api" in model && Predicate.hasProperty(model.api, "id") && typeof model.api.id === "string"
      ? Option.some(model.api.id)
      : Option.none<string>()
  const id = "id" in model && typeof model.id === "string" ? Option.some(model.id) : Option.none<string>()
  return Option.orElse(apiID, () => id).pipe(Option.map((name) => name.slice(0, 100)))
}

const parallelAuthHeaders = Config.Redacted("PARALLEL_API_KEY").pipe(
  Config.option,
  Config.map((key) => ({
    "User-Agent": `opencode/${InstallationVersion}`,
    ...Option.match(key, { onNone: () => ({}), onSome: (value) => ({ Authorization: `Bearer ${Redacted.value(value)}` }) }),
  })),
)

const callProvider = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "parallel") {
    return yield* McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        ...Option.match(webSearchModelName(ctx.extra), {
          onNone: () => ({}),
          onSome: (model_name) => ({ model_name }),
        }),
      },
      "25 seconds",
      yield* parallelAuthHeaders,
    )
  }

  return yield* McpWebSearch.call(
    http,
    yield* McpWebSearch.exaUrl,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
})

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        // A sync getter has no Effect context, so it reads the wall clock directly, in the local zone as before.
        const year = DateTime.getPart(DateTime.setZone(DateTime.nowUnsafe(), DateTime.zoneMakeLocal()), "year")
        return DESCRIPTION.replace("{{year}}", year.toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
          })
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              ...(params.numResults === undefined ? {} : { numResults: params.numResults }),
              ...(params.livecrawl === undefined ? {} : { livecrawl: params.livecrawl }),
              ...(params.type === undefined ? {} : { type: params.type }),
              ...(params.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: params.contextMaxCharacters }),
              provider,
            },
          })

          const result = yield* callProvider(http, provider, params, ctx)

          return {
            output: Option.getOrElse(result, () => "No search results found. Please try a different query."),
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

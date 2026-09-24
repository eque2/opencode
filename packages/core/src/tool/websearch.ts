export * as WebSearchTool from "./websearch"

import { ToolFailure } from "@opencode-ai/llm"
import {
  Array as Arr,
  Config as EffectConfig,
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { truthyConfig } from "../flag/flag"
import { InstallationVersion } from "../installation/version"
import { PositiveInt } from "../schema"
import { PermissionV2 } from "../permission"
import { SessionSchema } from "../session/schema"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { collectBoundedResponseBody } from "./http-body"
import { checksum } from "../util/encode"
import { ToolRegistry } from "./registry"

export const name = "websearch"
export const NO_RESULTS = "No search results found. Please try a different query."
export const EXA_URL = "https://mcp.exa.ai/mcp"
export const PARALLEL_URL = "https://search.parallel.ai/mcp"
export const MAX_NUM_RESULTS = 20
export const MAX_CONTEXT_CHARACTERS = 50_000
export const MAX_RESPONSE_BYTES = 256 * 1024

/** The local calendar year when the module loads. */
const currentYear = DateTime.getPart(DateTime.setZone(DateTime.nowUnsafe(), DateTime.zoneMakeLocal()), "year")

/**
 * Provider-independent local web search retained in V2 core for launch parity.
 * This invokes the legacy Exa/Parallel product backends itself. It is distinct
 * from provider-hosted web search tools, which remain route-owned and execute
 * at the model provider. Ownership of this compromise can be revisited later.
 */
export const description = `Search the web using the session's local web search provider. Use this for current information beyond knowledge cutoff.

This is a provider-independent local tool backed by Exa or Parallel. Provider-hosted web search tools are separate and execute at the model provider.

Optional controls support result count, live crawling ('fallback' or 'preferred'), search type ('auto', 'fast', or 'deep'), and maximum context characters.

The current year is ${currentYear}. Use this year when searching for recent information or current events.`

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))).annotate({
    description: `Number of search results to return (default: 8, maximum: ${MAX_NUM_RESULTS})`,
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_CONTEXT_CHARACTERS))).annotate(
    {
      description: `Maximum characters for context string optimized for models (default: 10000, maximum: ${MAX_CONTEXT_CHARACTERS})`,
    },
  ),
})

export const Provider = Schema.Literals(["exa", "parallel"])
export type Provider = typeof Provider.Type

export interface Config {
  readonly provider?: Provider
  readonly enableExa: boolean
  readonly enableParallel: boolean
  readonly exaApiKey?: string
  readonly parallelApiKey?: string
}

/** An MCP search call failed before it returned a usable body. */
export class SearchError extends Schema.TaggedError<SearchError>()("WebSearchTool.SearchError", {
  message: Schema.String,
}) {}

export class ConfigService extends Context.Service<ConfigService, Config>()("@opencode/v2/WebSearchConfig") {}

/** True when any of the variables is "true" or "1", in any case. */
const anyTruthy = (keys: ReadonlyArray<string>) =>
  EffectConfig.all(keys.map((key) => truthyConfig(key))).pipe(EffectConfig.map((flags) => flags.includes(true)))

const environment = EffectConfig.all({
  provider: EffectConfig.String("OPENCODE_WEBSEARCH_PROVIDER").pipe(EffectConfig.option),
  enableExa: anyTruthy(["OPENCODE_EXPERIMENTAL", "OPENCODE_ENABLE_EXA", "OPENCODE_EXPERIMENTAL_EXA"]),
  enableParallel: anyTruthy(["OPENCODE_ENABLE_PARALLEL", "OPENCODE_EXPERIMENTAL_PARALLEL"]),
  exaApiKey: EffectConfig.String("EXA_API_KEY").pipe(EffectConfig.option),
  parallelApiKey: EffectConfig.String("PARALLEL_API_KEY").pipe(EffectConfig.option),
})

/**
 * Isolates the retained product environment contract from the generic tool implementation.
 *
 * The ambient ConfigProvider copies process.env once per process, so each layer build reads a
 * fresh environment snapshot, as the former Layer.sync read of process.env did. Empty strings
 * stay values. Optional configs cannot fail on a missing variable, so a ConfigError is a defect.
 */
export const defaultConfigLayer = Layer.effect(
  ConfigService,
  Effect.gen(function* () {
    const env = yield* Effect.suspend(() =>
      environment.parse(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
    ).pipe(Effect.orDie)
    const provider = env.provider.pipe(Option.filter(Schema.is(Provider)))
    return ConfigService.of({
      ...(Option.isSome(provider) ? { provider: provider.value } : {}),
      enableExa: env.enableExa,
      enableParallel: env.enableParallel,
      ...(Option.isSome(env.exaApiKey) ? { exaApiKey: env.exaApiKey.value } : {}),
      ...(Option.isSome(env.parallelApiKey) ? { parallelApiKey: env.parallelApiKey.value } : {}),
    })
  }),
)

export const configNode = makeLocationNode({ service: ConfigService, layer: defaultConfigLayer, deps: [] })

export function selectProvider(
  sessionID: string,
  flags: Pick<Config, "enableExa" | "enableParallel"> = { enableExa: false, enableParallel: false },
  override?: Provider,
): Provider {
  if (override) return override
  if (flags.enableParallel) return "parallel"
  if (flags.enableExa) return "exa"
  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  }),
}).annotate({ identifier: "WebSearchTool.McpResult" })
const decodeMcpResult = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

/** Returns the first non-empty text item of a JSON-RPC payload, or none for a non-JSON frame. */
const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return Option.none<string>()
    const content = (yield* decodeMcpResult(trimmed)).result.content
    return Arr.findFirst(content, (item) => item.text !== "").pipe(Option.map((item) => item.text))
  })

/** Returns the search text of a plain JSON-RPC or SSE body, or none when no payload holds text. */
export const parseResponse = Effect.fn("WebSearchTool.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  if (trimmed) {
    const direct = yield* parsePayload(trimmed)
    if (Option.isSome(direct)) return direct
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (Option.isSome(data)) return data
  }
  return Option.none<string>()
})

const ExaArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
}).annotate({ identifier: "WebSearchTool.ExaArgs" })
const ParallelArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: SessionSchema.ID,
}).annotate({ identifier: "WebSearchTool.ParallelArgs" })
const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({ name: Schema.String, arguments: args }),
  })

const exaUrl = (apiKey: string | undefined) => {
  if (!apiKey) return EXA_URL
  const url = new URL(EXA_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.toString()
}

const callMcp = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    return yield* Effect.gen(function* () {
      const response = yield* HttpClient.filterStatusOk(http).execute(request)
      const body = yield* collectBoundedResponseBody(
        response,
        MAX_RESPONSE_BYTES,
        () => new SearchError({ message: `${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes` }),
      )
      return yield* parseResponse(body.toString("utf8"))
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(25),
        orElse: () => Effect.fail(new SearchError({ message: `${tool} request timed out` })),
      }),
    )
  })

const Output = Schema.Struct({
  provider: Provider,
  text: Schema.String,
}).annotate({ identifier: "WebSearchTool.Output" })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const http = yield* HttpClient.HttpClient
    const config = yield* ConfigService
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          execute: (input, context) => {
            const provider = selectProvider(context.sessionID, config, config.provider)
            return Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.query],
                save: ["*"],
                metadata: { ...input, provider },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })

              const text =
                provider === "exa"
                  ? yield* callMcp(http, exaUrl(config.exaApiKey), "web_search_exa", ExaArgs, {
                      query: input.query,
                      type: input.type || "auto",
                      numResults: input.numResults || 8,
                      livecrawl: input.livecrawl || "fallback",
                      contextMaxCharacters: input.contextMaxCharacters,
                    })
                  : yield* callMcp(
                      http,
                      PARALLEL_URL,
                      "web_search",
                      ParallelArgs,
                      {
                        objective: input.query,
                        search_queries: [input.query],
                        session_id: context.sessionID,
                        // V2 invocation context does not safely expose the model yet.
                      },
                      {
                        "User-Agent": `opencode/${InstallationVersion}`,
                        ...(config.parallelApiKey ? { Authorization: `Bearer ${config.parallelApiKey}` } : {}),
                      },
                    )
              return {
                provider,
                text: Option.getOrElse(text, () => NO_RESULTS),
              }
            }).pipe(Effect.mapError(() => new ToolFailure({ message: `Unable to search the web for ${input.query}` })))
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/websearch",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, LayerNodePlatform.httpClient, configNode],
})

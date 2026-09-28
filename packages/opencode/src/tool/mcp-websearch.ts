import { Config, Duration, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

const EXA_BASE_URL = "https://mcp.exa.ai/mcp"

/** The Exa MCP URL, carrying EXA_API_KEY when the environment sets a non-empty key. */
export const exaUrl = Config.Redacted("EXA_API_KEY").pipe(
  Config.option,
  Config.map(
    Option.match({
      onNone: () => EXA_BASE_URL,
      onSome: (key) => `${EXA_BASE_URL}?exaApiKey=${encodeURIComponent(Redacted.value(key))}`,
    }),
  ),
)
export const PARALLEL_URL = "https://search.parallel.ai/mcp"

const McpResult = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.String,
      }),
    ),
  }),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const parsePayload = (payload: string) =>
  Effect.gen(function* () {
    const trimmed = payload.trim()
    if (!trimmed.startsWith("{")) return Option.none<string>()
    const data = yield* decode(trimmed)
    return Option.fromUndefinedOr(data.result.content.find((item) => item.text)?.text)
  })

/** The first non-empty text result in a JSON-RPC body or in its SSE data frames. */
export const parseResponse = Effect.fn("McpWebSearch.parseResponse")(function* (body: string) {
  const trimmed = body.trim()
  const direct = trimmed ? yield* parsePayload(trimmed) : Option.none<string>()
  if (Option.isSome(direct)) return direct

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = yield* parsePayload(line.substring(6))
    if (Option.isSome(data)) return data
  }
  return Option.none<string>()
})

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const ParallelSearchArgs = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.optional(Schema.String),
  model_name: Schema.optional(Schema.String),
})

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  url: string,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(headers ?? {}),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(request)
      .pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error(`${tool} request timed out`)) }),
      )
    const body = yield* response.text
    return yield* parseResponse(body)
  })

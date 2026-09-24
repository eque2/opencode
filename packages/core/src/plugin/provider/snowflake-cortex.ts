import { Config, Effect, Option, Predicate, Redacted, Schema, String as Str } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"
import { readEnvSnapshot } from "./env-snapshot"

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

const tokenEnv = Config.option(
  Config.Redacted("SNOWFLAKE_CORTEX_TOKEN").pipe(Config.orElse(() => Config.Redacted("SNOWFLAKE_CORTEX_PAT"))),
)

const JsonObjectText = Schema.fromJsonString(Schema.JsonObject)
const decodeJsonObject = Schema.decodeUnknownOption(JsonObjectText)
const encodeJsonObject = Schema.encodeOption(JsonObjectText)

// The OpenAI-compatible reply that ends a turn with finish_reason "stop".
const stopResponseBody = Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
  choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }],
})

const stringOption = (value: unknown) => (Predicate.isString(value) ? Option.some(value) : Option.none())

// Cortex reads max_completion_tokens where OpenAI-compatible clients send max_tokens.
// A body that is not a JSON object with max_tokens stays unchanged (None).
const renameMaxTokens = (body: string) =>
  decodeJsonObject(body).pipe(
    Option.filter((json) => "max_tokens" in json),
    Option.flatMap(({ max_tokens: maxTokens, ...rest }) =>
      encodeJsonObject({ ...rest, max_completion_tokens: maxTokens }),
    ),
  )

// Cortex sends role:"" in streaming deltas, where the AI SDK schema requires "assistant".
const assistantRole = (text: string) => text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')

// Cortex reports the end of a conversation as an error whose message or error field says so.
const isConversationComplete = (json: Schema.JsonObject) => {
  const detail = json.message || json.error
  return Predicate.isString(detail) && detail.toLowerCase().includes("conversation complete")
}

// Exported for testing: intercepts Cortex-specific request/response quirks.
export function cortexFetch(upstream: FetchLike = fetch) {
  const intercept = Effect.fn("SnowflakeCortex.fetch")(function* (url: string | URL | Request, init?: RequestInit) {
    const body = init?.body
    const renamed = typeof body === "string" ? renameMaxTokens(body) : Option.none()
    const request = Option.match(renamed, { onNone: () => init, onSome: (body) => ({ ...init, body }) })

    // An upstream rejection, such as an abort, reaches the AI SDK unchanged.
    const response = yield* Effect.promise(() => upstream(url, request))

    // Cortex returns 400 "conversation complete" as a normal stop condition
    if (!response.ok && response.status === 400) {
      const text = yield* Effect.option(Effect.tryPromise(() => response.clone().text()))
      if (Option.exists(Option.flatMap(text, decodeJsonObject), isConversationComplete)) {
        return new Response(stopResponseBody, {
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
        })
      }
    }

    // Cortex returns role:"" in streaming deltas; the AI SDK schema requires "assistant"
    if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
      const reader = response.body.getReader()
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      const stream = new ReadableStream<Uint8Array>({
        pull: (ctrl) =>
          Effect.runPromise(
            Effect.promise(() => reader.read()).pipe(
              Effect.map((chunk) =>
                chunk.done
                  ? ctrl.close()
                  : ctrl.enqueue(encoder.encode(assistantRole(decoder.decode(chunk.value, { stream: true })))),
              ),
            ),
          ),
        cancel: () => reader.cancel(),
      })
      return new Response(stream, { headers: response.headers, status: response.status })
    }

    return response
  })
  return (url: string | URL | Request, init?: RequestInit): Promise<Response> => Effect.runPromise(intercept(url, init))
}

export const SnowflakeCortexPlugin = define({
  id: "snowflake-cortex",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("snowflake-cortex")) return
        // Env tokens win even when empty; an empty token keeps the configured apiKey.
        const token = Option.map(yield* readEnvSnapshot(tokenEnv), Redacted.value).pipe(
          Option.orElse(() => stringOption(evt.options.token)),
          Option.orElse(() => stringOption(evt.options.apiKey)),
          Option.filter(Str.isNonEmpty),
        )
        const upstream = typeof evt.options.fetch === "function" ? evt.options.fetch : fetch
        if (evt.options.includeUsage !== false) evt.options.includeUsage = true
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible({
          ...evt.options,
          // Name the two settings that the SDK type requires; both come from the host's SDK options.
          name: evt.options.name,
          baseURL: evt.options.baseURL,
          ...Option.match(token, { onNone: () => ({}), onSome: (apiKey) => ({ apiKey }) }),
          // The SDK fetch setting is typeof fetch, which includes Bun's preconnect helper.
          fetch: Object.assign(cortexFetch(upstream), { preconnect: fetch.preconnect }),
        })
      }),
    )
  }),
})

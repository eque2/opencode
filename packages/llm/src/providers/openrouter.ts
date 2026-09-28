import { Effect, Schema } from "effect"
import { Route, type RouteDefaultsInput } from "../route/client"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options"
import { ProviderID, type LLMRequest, type ModelID, type ProviderOptions } from "../schema"
import * as OpenAICompatibleProfiles from "./openai-compatible-profile"
import * as OpenAIChat from "../protocols/openai-chat"
import { isRecord, ProviderShared } from "../protocols/shared"

export const profile = OpenAICompatibleProfiles.profiles.openrouter
export const id = ProviderID.make(profile.provider)
const ADAPTER = "openrouter"

export interface OpenRouterOptions {
  readonly [key: string]: unknown
  readonly usage?: boolean | Record<string, unknown>
  readonly reasoning?: Record<string, unknown>
  readonly promptCacheKey?: string
}

export type OpenRouterProviderOptionsInput = ProviderOptions & {
  readonly openrouter?: OpenRouterOptions
}

export type ModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly baseURL?: string
    readonly providerOptions?: OpenRouterProviderOptionsInput
  }

// The OpenAI Chat body plus the three payload options that `bodyOptions` adds.
const OpenRouterBody = Schema.Struct({
  ...OpenAIChat.bodyFields,
  usage: Schema.optional(Schema.JsonObject),
  reasoning: Schema.optional(Schema.JsonObject),
  prompt_cache_key: Schema.optional(Schema.String),
}).annotate({ identifier: "OpenRouter.Body" })
export type OpenRouterBody = Schema.Schema.Type<typeof OpenRouterBody>

const isJsonObject = Schema.is(Schema.JsonObject)

// Route.make validates the body against OpenRouterBody, so a record option
// that is not JSON fails as an invalid request here instead of at validation.
const jsonOption = (name: string, value: Record<string, unknown>) =>
  isJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(ProviderShared.invalidRequest(`OpenRouter ${name} option must be a JSON object`))

const bodyOptions = Effect.fn("OpenRouter.bodyOptions")(function* (input: unknown) {
  const openrouter = isRecord(input) ? input : {}
  return {
    ...(openrouter.usage === true
      ? { usage: { include: true } }
      : isRecord(openrouter.usage)
        ? { usage: yield* jsonOption("usage", openrouter.usage) }
        : {}),
    ...(isRecord(openrouter.reasoning) ? { reasoning: yield* jsonOption("reasoning", openrouter.reasoning) } : {}),
    ...(typeof openrouter.promptCacheKey === "string" ? { prompt_cache_key: openrouter.promptCacheKey } : {}),
  }
})

export const protocol = Protocol.make({
  id: "openrouter-chat",
  body: {
    schema: OpenRouterBody,
    from: Effect.fn("OpenRouter.fromRequest")(function* (request: LLMRequest) {
      const body = yield* OpenAIChat.protocol.body.from(request)
      return { ...body, ...(yield* bodyOptions(request.providerOptions?.openrouter)) }
    }),
  },
  stream: OpenAIChat.protocol.stream,
})

export const route = Route.make({
  id: ADAPTER,
  provider: profile.provider,
  protocol,
  endpoint: Endpoint.path("/chat/completions", { baseURL: profile.baseURL }),
  framing: Framing.sse,
})

export const routes = [route]

const configuredRoute = (input: ModelOptions) => {
  const { apiKey: _, auth: _auth, baseURL, ...rest } = input
  return route.with({
    ...rest,
    endpoint: { baseURL: baseURL ?? profile.baseURL },
    auth: AuthOptions.bearer(input, "OPENROUTER_API_KEY"),
  })
}

export const configure = (input: ModelOptions = {}) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = configure()
export const model = provider.model

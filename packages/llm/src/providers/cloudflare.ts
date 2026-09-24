import { Option, type Config, type Redacted } from "effect"
import * as OpenAICompatibleChat from "../protocols/openai-compatible-chat"
import * as ProviderShared from "../protocols/shared"
import { Auth } from "../route/auth"
import { AuthOptions, type AtLeastOne, type ProviderAuthOption } from "../route/auth-options"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"

export const aiGatewayID = ProviderID.make("cloudflare-ai-gateway")
export const workersAIID = ProviderID.make("cloudflare-workers-ai")
export const aiGatewayAuthEnvVars = ["CLOUDFLARE_API_TOKEN", "CF_AIG_TOKEN"] as const
export const workersAIAuthEnvVars = ["CLOUDFLARE_API_KEY", "CLOUDFLARE_WORKERS_AI_TOKEN"] as const

type CloudflareSecret = string | Redacted.Redacted | Config.Config<string | Redacted.Redacted>

type GatewayURL = AtLeastOne<{
  readonly accountId: string
  readonly baseURL: string
}> & {
  readonly gatewayId?: string
}

export type AIGatewayOptions = GatewayURL &
  RouteDefaultsInput &
  ProviderAuthOption<"optional"> & {
    /** Cloudflare AI Gateway authentication token. Sent as `cf-aig-authorization`. */
    readonly gatewayApiKey?: CloudflareSecret
  }

type WorkersAIURL = AtLeastOne<{
  readonly accountId: string
  readonly baseURL: string
}>

export type WorkersAIOptions = WorkersAIURL & RouteDefaultsInput & ProviderAuthOption<"optional">

const nonEmpty = (value: string | undefined) =>
  Option.fromNullishOr(value).pipe(Option.filter((text) => text.length > 0))

// `AtLeastOne` rejects a missing pair at compile time; an empty string still
// type-checks, so the configure call fails with a typed `LLMError` for it.
const accountBaseURL = (
  facade: string,
  input: WorkersAIURL,
  fromAccount: (accountId: string) => string,
): string =>
  nonEmpty(input.baseURL).pipe(
    Option.orElse(() => Option.map(nonEmpty(input.accountId), fromAccount)),
    Option.getOrThrowWith(() =>
      ProviderShared.invalidRequest(`${facade}.configure requires accountId unless baseURL is supplied`),
    ),
  )

export const aiGatewayBaseURL = (input: GatewayURL) =>
  accountBaseURL(
    "CloudflareAIGateway",
    input,
    (accountId) =>
      `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(input.gatewayId?.trim() || "default")}/compat`,
  )

const aiGatewayAuth = (input: AIGatewayOptions) => {
  if ("auth" in input && input.auth) return input.auth
  const gateway = Auth.optional(input.gatewayApiKey, "gatewayApiKey")
    .orElse(Auth.config("CLOUDFLARE_API_TOKEN"))
    .orElse(Auth.config("CF_AIG_TOKEN"))
    .pipe(Auth.bearerHeader("cf-aig-authorization"))
  if (!("apiKey" in input) || input.apiKey === undefined) return gateway
  if (input.gatewayApiKey === undefined) return Auth.bearer(input.apiKey)
  return Auth.bearerHeader("cf-aig-authorization", input.gatewayApiKey).andThen(Auth.bearer(input.apiKey))
}

export const workersAIBaseURL = (input: WorkersAIURL) =>
  accountBaseURL(
    "CloudflareWorkersAI",
    input,
    (accountId) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`,
  )

const workersAIAuth = (input: WorkersAIOptions) => {
  return AuthOptions.bearer(input, workersAIAuthEnvVars)
}

export const aiGatewayRoute = OpenAICompatibleChat.route.with({
  id: "cloudflare-ai-gateway",
  provider: aiGatewayID,
})

export const workersAIRoute = OpenAICompatibleChat.route.with({
  id: "cloudflare-workers-ai",
  provider: workersAIID,
})

export const routes = [aiGatewayRoute, workersAIRoute]

const aiGatewayDefaults = (options: AIGatewayOptions) => {
  const {
    accountId: _accountId,
    gatewayId: _gatewayId,
    apiKey: _apiKey,
    gatewayApiKey: _gatewayApiKey,
    baseURL: _baseURL,
    auth: _auth,
    ...rest
  } = options
  return rest
}

const workersAIDefaults = (options: WorkersAIOptions) => {
  const { accountId: _accountId, apiKey: _apiKey, auth: _auth, baseURL: _baseURL, ...rest } = options
  return rest
}

const configureAIGateway = (options: AIGatewayOptions) => {
  const route = aiGatewayRoute.with({
    ...aiGatewayDefaults(options),
    endpoint: { baseURL: aiGatewayBaseURL(options) },
    auth: aiGatewayAuth(options),
  })
  return {
    id: aiGatewayID,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure: configureAIGateway,
  }
}

const configureWorkersAI = (options: WorkersAIOptions) => {
  const route = workersAIRoute.with({
    ...workersAIDefaults(options),
    endpoint: { baseURL: workersAIBaseURL(options) },
    auth: workersAIAuth(options),
  })
  return {
    id: workersAIID,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure: configureWorkersAI,
  }
}

export const CloudflareAIGateway = {
  id: aiGatewayID,
  configure: configureAIGateway,
}

export const CloudflareWorkersAI = {
  id: workersAIID,
  configure: configureWorkersAI,
}

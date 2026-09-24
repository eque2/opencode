import os from "os"
import { InstallationVersion } from "../../installation/version"
import { Config, Effect, Option, Predicate, Redacted, Schema } from "effect"
import { define } from "../internal"
import { readEnvSnapshot } from "./env-snapshot"

export const CloudflareAIGatewayPlugin = define({
  id: "cloudflare-ai-gateway",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "ai-gateway-provider") return
        if (evt.options.baseURL) return

        const env = yield* readEnvSnapshot(GatewayEnv)
        const config = gatewayConfig(evt.options, env)
        if (Option.isNone(config)) return
        const { accountId, gatewayId, apiKey } = config.value
        const metadata = gatewayMetadata(evt.options)
        const { createAiGateway } = yield* Effect.promise(() => import("ai-gateway-provider")).pipe(Effect.orDie)
        const { createUnified } = yield* Effect.promise(() => import("ai-gateway-provider/providers/unified")).pipe(
          Effect.orDie,
        )
        const gateway = createAiGateway({
          accountId,
          gateway: gatewayId,
          apiKey,
          options: gatewayOptions(evt.options, metadata),
        } as any)
        evt.sdk = {
          languageModel(modelID: string) {
            // Workers AI is the only first-party provider whose upstream is Cloudflare itself, so it is
            // the only one that should receive the Cloudflare token as its upstream Authorization header.
            // The Unified API addresses Workers AI both with the explicit "workers-ai/" prefix and as
            // bare "@cf/..." ids. Third-party providers must not receive the token; they rely on the
            // gateway's stored/BYOK keys instead.
            const isWorkersAi = modelID.startsWith("workers-ai/") || modelID.startsWith("@cf/")
            const unified = createUnified(isWorkersAi ? { apiKey } : {})
            return gateway(unified(modelID))
          },
        }
      }),
    )
  }),
})

type GatewayConfig = {
  accountId: string
  gatewayId: string
  apiKey: string
}

const GatewayEnv = Config.all({
  accountId: Config.option(Config.String("CLOUDFLARE_ACCOUNT_ID")),
  gatewayId: Config.option(Config.String("CLOUDFLARE_GATEWAY_ID")),
  apiToken: Config.option(Config.Redacted("CLOUDFLARE_API_TOKEN")),
  aigToken: Config.option(Config.Redacted("CF_AIG_TOKEN")),
})

type GatewayEnv = Config.Success<typeof GatewayEnv>

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function gatewayConfig(options: Record<string, unknown>, env: GatewayEnv): Option.Option<GatewayConfig> {
  const accountId = env.accountId.pipe(Option.orElse(() => stringOption(options, "accountId")))
  // Credential projection copies key metadata into options. The prompt stores the
  // gateway as gatewayId, while older config examples may use gateway.
  const gatewayId = env.gatewayId.pipe(
    Option.orElse(() => stringOption(options, "gatewayId")),
    Option.orElse(() => stringOption(options, "gateway")),
  )
  const apiKey = env.apiToken.pipe(
    Option.orElse(() => env.aigToken),
    Option.map(Redacted.value),
    Option.orElse(() => stringOption(options, "apiKey")),
  )
  // An empty value still wins over the next source, then counts as missing.
  return Option.all({ accountId, gatewayId, apiKey }).pipe(
    Option.filter((config) => config.accountId !== "" && config.gatewayId !== "" && config.apiKey !== ""),
  )
}

function gatewayMetadata(options: Record<string, unknown>) {
  // Preserve the legacy cf-aig-metadata header escape hatch for gateway logging
  // metadata, but prefer the typed metadata option when present.
  if (options.metadata !== undefined) return options.metadata
  return Option.getOrUndefined(headerMetadata(options.headers))
}

function headerMetadata(headers: unknown): Option.Option<unknown> {
  if (!Predicate.hasProperty(headers, "cf-aig-metadata")) return Option.none()
  const raw = headers["cf-aig-metadata"]
  return raw ? decodeJson(raw) : Option.none()
}

function gatewayOptions(options: Record<string, unknown>, metadata: unknown) {
  return {
    metadata,
    cacheTtl: options.cacheTtl,
    cacheKey: options.cacheKey,
    skipCache: options.skipCache,
    collectLog: options.collectLog,
    headers: {
      "User-Agent": `opencode/${InstallationVersion} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
    },
  }
}

function stringOption(options: Record<string, unknown>, key: string): Option.Option<string> {
  return Option.liftPredicate(options[key], Predicate.isString)
}

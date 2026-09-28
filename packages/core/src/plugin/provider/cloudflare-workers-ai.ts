import os from "os"
import type { OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible"
import { InstallationVersion } from "../../installation/version"
import { Config, Effect, Option, Predicate, Redacted } from "effect"
import { define } from "../internal"
import { readEnvSnapshot } from "./env-snapshot"
import { ProviderV2 } from "../../provider"

const providerID = ProviderV2.ID.make("cloudflare-workers-ai")

const WorkersEnv = Config.all({
  accountId: Config.option(Config.String("CLOUDFLARE_ACCOUNT_ID")),
  apiKey: Config.option(Config.Redacted("CLOUDFLARE_API_KEY")),
})

type WorkersEnv = Config.Success<typeof WorkersEnv>

export const CloudflareWorkersAIPlugin = define({
  id: "cloudflare-workers-ai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        const item = evt.provider.get(providerID)
        if (!item) return
        const env = yield* readEnvSnapshot(WorkersEnv)
        evt.provider.update(item.provider.id, (provider) => {
          if (provider.api.type !== "aisdk") return
          if (provider.api.url) return
          const accountId = resolveAccountId(provider.request.body, env)
          if (Option.isSome(accountId)) provider.api.url = workersEndpoint(accountId.value)
        })
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID) return
        if (evt.package !== "@ai-sdk/openai-compatible") return

        const env = yield* readEnvSnapshot(WorkersEnv)
        const accountId = resolveAccountId(evt.options, env)
        if (!hasWorkersEndpoint(evt.model.api) && Option.isNone(accountId)) return
        const baseURL = stringOption(evt.options, "baseURL").pipe(
          Option.orElse(() => Option.map(accountId, workersEndpoint)),
        )
        // The OpenAI-compatible SDK requires a baseURL; without one it has no endpoint to call.
        if (Option.isNone(baseURL)) return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible(sdkOptions(evt.options, baseURL.value, env))
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID) return
        evt.language = evt.sdk.languageModel(evt.model.api.id)
      }),
    )
  }),
})

function resolveAccountId(options: Record<string, unknown>, env: WorkersEnv): Option.Option<string> {
  return env.accountId.pipe(
    Option.orElse(() => stringOption(options, "accountId")),
    // An empty value still wins over the option, then counts as missing.
    Option.filter((id) => id !== ""),
  )
}

function workersEndpoint(accountId: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
}

// Reads only the fields that both the catalog Api and the plugin SDK's ModelApi share.
function hasWorkersEndpoint(api: { readonly type: string; readonly url?: string }) {
  return api.type === "aisdk" && Boolean(api.url)
}

function sdkOptions(options: Record<string, any>, baseURL: string, env: WorkersEnv): OpenAICompatibleProviderSettings {
  const apiKey = env.apiKey.pipe(
    Option.map(Redacted.value),
    Option.orElse(() => stringOption(options, "apiKey")),
  )
  return {
    ...options,
    baseURL: expandAccountId(baseURL, env),
    // OpenAICompatibleProviderSettings.apiKey is string | undefined.
    apiKey: Option.getOrUndefined(apiKey),
    headers: {
      "User-Agent": `opencode/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
      ...options.headers,
    },
    name: providerID,
  }
}

function expandAccountId(baseURL: string, env: WorkersEnv) {
  return baseURL.replaceAll(
    "${CLOUDFLARE_ACCOUNT_ID}",
    Option.getOrElse(env.accountId, () => "${CLOUDFLARE_ACCOUNT_ID}"),
  )
}

function stringOption(options: Record<string, unknown>, key: string): Option.Option<string> {
  return Option.liftPredicate(options[key], Predicate.isString)
}

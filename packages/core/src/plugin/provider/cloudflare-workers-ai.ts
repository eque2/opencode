import os from "os"
import { InstallationVersion } from "../../installation/version"
import { Effect, Option, Predicate } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"

const providerID = ProviderV2.ID.make("cloudflare-workers-ai")

export const CloudflareWorkersAIPlugin = define({
  id: "cloudflare-workers-ai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        const item = evt.provider.get(providerID)
        if (!item) return
        evt.provider.update(item.provider.id, (provider) => {
          if (provider.api.type !== "aisdk") return
          if (provider.api.url) return
          const accountId = resolveAccountId(provider.request.body)
          if (Option.isSome(accountId)) provider.api.url = workersEndpoint(accountId.value)
        })
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== providerID) return
        if (evt.package !== "@ai-sdk/openai-compatible") return

        const accountId = resolveAccountId(evt.options)
        if (!hasWorkersEndpoint(evt.model.api) && Option.isNone(accountId)) return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai-compatible"))
        evt.sdk = mod.createOpenAICompatible(
          sdkOptions({
            ...evt.options,
            baseURL: evt.options.baseURL ?? Option.getOrUndefined(Option.map(accountId, workersEndpoint)),
          }) as any,
        )
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

function resolveAccountId(options: Record<string, unknown>): Option.Option<string> {
  return Option.fromUndefinedOr(process.env.CLOUDFLARE_ACCOUNT_ID).pipe(
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

function sdkOptions(options: Record<string, any>) {
  return {
    ...options,
    baseURL: expandAccountId(options.baseURL),
    apiKey: process.env.CLOUDFLARE_API_KEY ?? options.apiKey,
    headers: {
      "User-Agent": `opencode/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
      ...options.headers,
    },
    name: providerID,
  }
}

function expandAccountId(baseURL: unknown) {
  if (typeof baseURL !== "string") return baseURL
  return baseURL.replaceAll("${CLOUDFLARE_ACCOUNT_ID}", process.env.CLOUDFLARE_ACCOUNT_ID ?? "${CLOUDFLARE_ACCOUNT_ID}")
}

function stringOption(options: Record<string, unknown>, key: string): Option.Option<string> {
  return Option.liftPredicate(options[key], Predicate.isString)
}

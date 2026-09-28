import type { Hooks } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Config, Effect, Option, Redacted } from "effect"
import { ModalModels } from "./models"

type ModelsHook = NonNullable<NonNullable<Hooks["provider"]>["models"]>

const ProxyToken = Config.option(Config.Redacted("MODAL_PROXY_TOKEN"))

const models = Effect.fn("ModalPlugin.models")(function* (
  provider: Parameters<ModelsHook>[0],
  ctx: Parameters<ModelsHook>[1],
) {
  const apiKey =
    ctx.auth?.type === "api" ? Option.some(ctx.auth.key) : Option.map(yield* readEnvSnapshot(ProxyToken), Redacted.value)
  const baseURL = Option.fromNullishOr(Object.values(provider.models)[0]?.api.url)
  if (Option.isNone(apiKey) || !apiKey.value || Option.isNone(baseURL) || !baseURL.value) return {}

  // A failed discovery hides the Modal models instead of failing the provider.
  return yield* ModalModels.get(baseURL.value, apiKey.value, provider.models).pipe(
    Effect.orElseSucceed((): Record<string, Model> => ({})),
  )
})

// The plugin SDK Hooks contract is Promise-based, so each hook runs its Effect at this boundary.
export function ModalPlugin(): Promise<Hooks> {
  const hooks: Hooks = {
    provider: {
      id: "modal",
      models: (provider, ctx) => Effect.runPromise(models(provider, ctx)),
    },
  }
  return Effect.runPromise(Effect.succeed(hooks))
}

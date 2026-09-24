import { Config, Effect, Schema } from "effect"
import { define } from "../internal"
import { readEnvSnapshot } from "./env-snapshot"
import { ProviderV2 } from "../../provider"

// An empty or unset variable reads as "", which the hooks treat as not configured.
const AzureResourceName = Config.String("AZURE_RESOURCE_NAME").pipe(Config.withDefault(""))
const CognitiveServicesResourceName = Config.String("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME").pipe(
  Config.withDefault(""),
)

export class ResourceNameMissingError extends Schema.TaggedError<ResourceNameMissingError>()(
  "AzurePlugin.ResourceNameMissingError",
  { message: Schema.String },
) {}

// Plugin hooks cannot fail, so the missing endpoint is a defect; AISDK.language wraps it in AISDK.InitError.
function requireEndpoint(evt: {
  readonly model: { readonly providerID: string; readonly api: { readonly type: string; readonly url?: string } }
  readonly options: Record<string, any>
}) {
  if (evt.model.providerID !== ProviderV2.ID.azure) return Effect.void
  if (evt.options.resourceName || evt.options.baseURL) return Effect.void
  if (evt.model.api.type === "aisdk" && evt.model.api.url) return Effect.void
  return Effect.die(
    new ResourceNameMissingError({
      message: "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
    }),
  )
}

function selectLanguage(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

export const AzurePlugin = define({
  id: "azure",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        const envResourceName = yield* readEnvSnapshot(AzureResourceName)
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/azure") continue
          const configured = item.provider.request.body.resourceName
          const resourceName = typeof configured === "string" && configured.trim() !== "" ? configured : envResourceName
          if (!resourceName) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.body.resourceName = resourceName
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/azure") return
        yield* requireEndpoint(evt)
        const mod = yield* Effect.promise(() => import("@ai-sdk/azure"))
        evt.sdk = mod.createAzure(evt.options)
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.azure) return
        evt.language = selectLanguage(evt.sdk, evt.model.api.id, Boolean(evt.options.useCompletionUrls))
      }),
    )
  }),
})

export const AzureCognitiveServicesPlugin = define({
  id: "azure-cognitive-services",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        const resourceName = yield* readEnvSnapshot(CognitiveServicesResourceName)
        if (!resourceName) return
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (!item.provider.id.includes("azure-cognitive-services")) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.body.baseURL = `https://${resourceName}.cognitiveservices.azure.com/openai`
          })
        }
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("azure-cognitive-services")) return
        evt.language = selectLanguage(evt.sdk, evt.model.api.id, Boolean(evt.options.useCompletionUrls))
      }),
    )
  }),
})

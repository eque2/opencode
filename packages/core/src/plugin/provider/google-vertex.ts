import { Config, Effect, Option } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"
import { readEnvSnapshot } from "./env-snapshot"

// Google SDKs and ADC examples commonly use these broader Google Cloud project aliases.
const cloudProjectEnv = Config.String("GOOGLE_CLOUD_PROJECT").pipe(
  Config.orElse(() => Config.String("GCP_PROJECT")),
  Config.orElse(() => Config.String("GCLOUD_PROJECT")),
)

// models.dev advertises GOOGLE_VERTEX_PROJECT for Vertex; the Google Cloud aliases follow it.
const vertexProjectEnv = Config.option(
  Config.String("GOOGLE_VERTEX_PROJECT").pipe(Config.orElse(() => cloudProjectEnv)),
)

const vertexLocationEnv = Config.String("GOOGLE_VERTEX_LOCATION").pipe(
  Config.orElse(() => Config.String("GOOGLE_CLOUD_LOCATION")),
  Config.orElse(() => Config.String("VERTEX_LOCATION")),
  Config.withDefault("us-central1"),
)

const anthropicProjectEnv = Config.option(cloudProjectEnv)

const anthropicLocationEnv = Config.String("GOOGLE_CLOUD_LOCATION").pipe(
  Config.orElse(() => Config.String("VERTEX_LOCATION")),
  Config.withDefault("global"),
)

const resolveProject = Effect.fnUntraced(function* (options: Record<string, any>) {
  return options.project ?? Option.getOrUndefined(yield* readEnvSnapshot(vertexProjectEnv))
})

const resolveLocation = Effect.fnUntraced(function* (options: Record<string, any>) {
  return options.location ?? (yield* readEnvSnapshot(vertexLocationEnv))
})

function vertexEndpoint(location: string) {
  if (location === "global") return "aiplatform.googleapis.com"
  return `${location}-aiplatform.googleapis.com`
}

function replaceVertexVars(value: string, project: string | undefined, location: string) {
  // Vertex OpenAI-compatible endpoints are stored as templates in the catalog;
  // expand them after provider config/env project and location have been resolved.
  return value
    .replaceAll("${GOOGLE_VERTEX_PROJECT}", project ?? "${GOOGLE_VERTEX_PROJECT}")
    .replaceAll("${GOOGLE_VERTEX_LOCATION}", location)
    .replaceAll("${GOOGLE_VERTEX_ENDPOINT}", vertexEndpoint(location))
}

function authFetch(fetchWithRuntimeOptions?: unknown) {
  // Native Vertex SDKs handle ADC internally. OpenAI-compatible Vertex endpoints
  // do not, so inject a Google access token into their fetch path.
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { GoogleAuth } = await import("google-auth-library")
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${token.token}`)
    return typeof fetchWithRuntimeOptions === "function"
      ? fetchWithRuntimeOptions(input, { ...init, headers })
      : fetch(input, { ...init, headers })
  }
}

export const GoogleVertexPlugin = define({
  id: "google-vertex",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (
            item.provider.api.package !== "@ai-sdk/google-vertex" &&
            !(
              item.provider.id === ProviderV2.ID.googleVertex &&
              item.provider.api.package.includes("@ai-sdk/openai-compatible")
            )
          )
            continue
          const project = yield* resolveProject(item.provider.request.body)
          const location = String(yield* resolveLocation(item.provider.request.body))
          evt.provider.update(item.provider.id, (provider) => {
            if (project) provider.request.body.project = project
            provider.request.body.location = location
            if (provider.api.type === "aisdk" && provider.api.url) {
              provider.api.url = replaceVertexVars(provider.api.url, project, location)
            }
            if (provider.api.type === "aisdk" && provider.api.package.includes("@ai-sdk/openai-compatible")) {
              provider.request.body.fetch = authFetch(provider.request.body.fetch)
            }
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID === ProviderV2.ID.googleVertex && evt.package.includes("@ai-sdk/openai-compatible")) {
          evt.options.fetch = authFetch(evt.options.fetch)
          return
        }
        if (evt.package !== "@ai-sdk/google-vertex") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/google-vertex"))
        const project = yield* resolveProject(evt.options)
        const location = yield* resolveLocation(evt.options)
        const options = { ...evt.options }
        delete options.fetch
        evt.sdk = mod.createVertex({
          ...options,
          project,
          location,
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.googleVertex) return
        evt.language = evt.sdk.languageModel(String(evt.model.api.id).trim())
      }),
    )
  }),
})

export const GoogleVertexAnthropicPlugin = define({
  id: "google-vertex-anthropic",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/google-vertex/anthropic") continue
          const project =
            item.provider.request.body.project ?? Option.getOrUndefined(yield* readEnvSnapshot(anthropicProjectEnv))
          const location = item.provider.request.body.location ?? (yield* readEnvSnapshot(anthropicLocationEnv))
          evt.provider.update(item.provider.id, (provider) => {
            if (project) provider.request.body.project = project
            provider.request.body.location = location
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/google-vertex/anthropic") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/google-vertex/anthropic"))
        const project =
          typeof evt.options.project === "string"
            ? evt.options.project
            : Option.getOrUndefined(yield* readEnvSnapshot(anthropicProjectEnv))
        const location =
          typeof evt.options.location === "string" ? evt.options.location : yield* readEnvSnapshot(anthropicLocationEnv)
        evt.sdk = mod.createVertexAnthropic({
          ...evt.options,
          project,
          location,
          // Continental multi-regions (eu, us) require Regional Endpoint Platform
          // domains; the default {region}-aiplatform.googleapis.com does not resolve.
          ...((location === "eu" || location === "us") && project && !evt.options.baseURL
            ? {
                baseURL: `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`,
              }
            : {}),
        })
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("google-vertex-anthropic")) return
        evt.language = evt.sdk.languageModel(String(evt.model.api.id).trim())
      }),
    )
  }),
})

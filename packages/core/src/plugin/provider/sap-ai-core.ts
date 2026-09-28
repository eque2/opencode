import { Config, Effect, Option, Predicate, Redacted, Schema, String as Str } from "effect"
import { pathToFileURL } from "url"
import { define } from "../internal"
import { Npm } from "../../npm"
import { ProviderV2 } from "../../provider"
import { readEnvSnapshot } from "./env-snapshot"

const serviceKeyEnv = Config.option(Config.Redacted("AICORE_SERVICE_KEY"))
const deploymentIdEnv = Config.option(Config.String("AICORE_DEPLOYMENT_ID"))
const resourceGroupEnv = Config.option(Config.String("AICORE_RESOURCE_GROUP"))

class SapAICoreProviderError extends Schema.TaggedError<SapAICoreProviderError>()("SapAICore.ProviderError", {
  message: Schema.String,
}) {}

// Import the provider package and return its first create* export, the SDK factory.
const loadFactory = Effect.fnUntraced(function* (npm: Npm.Interface, pkg: string) {
  const installedPath = pkg.startsWith("file://") ? pkg : (yield* npm.add(pkg).pipe(Effect.orDie)).entrypoint
  if (!installedPath) return yield* new SapAICoreProviderError({ message: `Package ${pkg} has no import entrypoint` })
  const url = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
  // A module namespace is an object of named exports.
  const mod: { readonly [name: string]: unknown } = yield* Effect.promise(() => import(url))
  const factory = Option.fromNullishOr(Object.keys(mod).find((name) => name.startsWith("create"))).pipe(
    Option.map((name) => mod[name]),
    Option.filter(Predicate.isFunction),
  )
  if (Option.isNone(factory)) {
    return yield* new SapAICoreProviderError({ message: `Package ${pkg} has no provider factory export` })
  }
  return factory.value
})

export const SapAICorePlugin = define({
  id: "sap-ai-core",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("sap-ai-core")) return
        const envKey = Option.map(yield* readEnvSnapshot(serviceKeyEnv), Redacted.value)
        const optionKey =
          typeof evt.options.serviceKey === "string" ? Option.some(evt.options.serviceKey) : Option.none()
        // The env key wins even when empty; an empty key means no service key.
        const serviceKey = envKey.pipe(
          Option.orElse(() => optionKey),
          Option.filter(Str.isNonEmpty),
        )
        if (Option.isNone(envKey) && Option.isSome(serviceKey)) {
          // eslint-disable-next-line effect/no-process-env-use-config -- (a) env write, not a read: the SAP AI SDK reads AICORE_SERVICE_KEY only from process.env, and Effect Config cannot write env
          process.env.AICORE_SERVICE_KEY = serviceKey.value
        }

        const factory = yield* loadFactory(npm, evt.package).pipe(Effect.orDie)
        evt.sdk = factory(
          Option.isSome(serviceKey)
            ? {
                deploymentId: Option.getOrUndefined(yield* readEnvSnapshot(deploymentIdEnv)),
                resourceGroup: Option.getOrUndefined(yield* readEnvSnapshot(resourceGroupEnv)),
              }
            : {},
        )
      }),
    )
    yield* ctx.aisdk.language(
      Effect.fn(function* (evt) {
        if (evt.model.providerID !== ProviderV2.ID.make("sap-ai-core")) return
        evt.language = evt.sdk(evt.model.api.id)
      }),
    )
  }),
})

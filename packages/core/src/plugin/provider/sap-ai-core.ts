import { Config, Effect, Option, Redacted, String as Str } from "effect"
import { pathToFileURL } from "url"
import { define } from "../internal"
import { Npm } from "../../npm"
import { ProviderV2 } from "../../provider"
import { readEnvSnapshot } from "./env-snapshot"

const serviceKeyEnv = Config.option(Config.Redacted("AICORE_SERVICE_KEY"))
const deploymentIdEnv = Config.option(Config.String("AICORE_DEPLOYMENT_ID"))
const resourceGroupEnv = Config.option(Config.String("AICORE_RESOURCE_GROUP"))

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
          // eslint-disable-next-line effect/no-process-env-use-config -- the SAP AI SDK reads AICORE_SERVICE_KEY only from process.env, and Effect Config cannot write env.
          process.env.AICORE_SERVICE_KEY = serviceKey.value
        }

        const installedPath = evt.package.startsWith("file://")
          ? evt.package
          : (yield* npm.add(evt.package).pipe(Effect.orDie)).entrypoint
        if (!installedPath) throw new Error(`Package ${evt.package} has no import entrypoint`)

        const mod = yield* Effect.promise(async () => {
          return (await import(
            installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
          )) as Record<string, (options: any) => any>
        }).pipe(Effect.orDie)
        const match = Object.keys(mod).find((name) => name.startsWith("create"))
        if (!match) throw new Error(`Package ${evt.package} has no provider factory export`)

        evt.sdk = mod[match](
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

import { Effect, Schema } from "effect"
import { pathToFileURL } from "url"
import { define } from "../internal"
import { Npm } from "../../npm"

export class DynamicProviderError extends Schema.TaggedError<DynamicProviderError>()("DynamicProvider.Error", {
  message: Schema.String,
}) {}

export const DynamicProviderPlugin = define({
  id: "dynamic-provider",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    const createSDK = Effect.fn("DynamicProvider.createSDK")(function* (pkg: string, options: Record<string, any>) {
      const installedPath = pkg.startsWith("file://") ? pkg : (yield* npm.add(pkg).pipe(Effect.orDie)).entrypoint
      if (!installedPath) return yield* new DynamicProviderError({ message: `Package ${pkg} has no import entrypoint` })

      const mod = yield* Effect.promise(async () => {
        return (await import(
          installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
        )) as Record<string, (options: any) => any>
      }).pipe(Effect.orDie)
      const match = Object.keys(mod).find((name) => name.startsWith("create"))
      if (!match) return yield* new DynamicProviderError({ message: `Package ${pkg} has no provider factory export` })

      return mod[match](options)
    })
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.sdk) return
        // Plugin hooks cannot fail, so a load error is a defect; AISDK.language wraps it in AISDK.InitError.
        evt.sdk = yield* createSDK(evt.package, evt.options).pipe(Effect.orDie)
      }),
    )
  }),
})

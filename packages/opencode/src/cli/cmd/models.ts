import { EOL } from "os"
import { Effect, Schema } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@opencode-ai/core/provider"

// The verbose model metadata, as JSON.stringify(model, null, 2) wrote it.
const encodeModel = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderV2.ID, verbose?: boolean) =>
      Effect.forEach(
        Object.entries(providers[providerID].models).sort(([a], [b]) => a.localeCompare(b)),
        ([modelID, model]) =>
          Effect.gen(function* () {
            process.stdout.write(`${providerID}/${modelID}`)
            process.stdout.write(EOL)
            if (!verbose) return
            process.stdout.write(yield* encodeModel(model).pipe(Effect.orDie))
            process.stdout.write(EOL)
          }),
        { discard: true },
      )

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      return yield* print(providerID, args.verbose)
    }

    const ids = Object.keys(providers).sort((a, b) => {
      const aIsOpencode = a.startsWith("opencode")
      const bIsOpencode = b.startsWith("opencode")
      if (aIsOpencode && !bIsOpencode) return -1
      if (!aIsOpencode && bIsOpencode) return 1
      return a.localeCompare(b)
    })

    return yield* Effect.forEach(ids, (providerID) => print(ProviderV2.ID.make(providerID), args.verbose), {
      discard: true,
    })
  }),
})

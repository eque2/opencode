import { EOL } from "os"
import { Effect, Schema } from "effect"
import { effectCmd } from "../../effect-cmd"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const ConfigCommand = effectCmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.config")(function* () {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    process.stdout.write((yield* encodeJson(config).pipe(Effect.orDie)) + EOL)
  }),
})

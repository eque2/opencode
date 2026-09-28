import { EOL } from "os"
import { Effect, Schema } from "effect"
import { effectCmd } from "../../effect-cmd"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const ScrapCommand = effectCmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) => yargs,
  // Lists projects from global storage; no project InstanceContext is needed.
  instance: false,
  handler: Effect.fn("Cli.debug.scrap")(function* () {
    const { Project } = yield* Effect.promise(() => import("@/project/project"))
    const project = yield* Project.Service
    const list = yield* project.list()
    process.stdout.write((yield* encodeJson(list).pipe(Effect.orDie)) + EOL)
  }),
})

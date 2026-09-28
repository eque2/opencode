import { EOL } from "os"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export class ListError extends Schema.TaggedError<ListError>()("CliDebugAgents.ListError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// The command prints the SDK response as it arrived, so the JSON has no fixed shape here.
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export default Runtime.handler(
  Commands.commands.debug.commands.agents,
  Effect.fn("cli.debug.agents")(function* () {
    const daemon = yield* Daemon.Service
    const client = yield* daemon.client()
    const response = yield* Effect.promise(() => client.v2.agent.list({ location: { directory: process.cwd() } }))
    const body = yield* Effect.fromOption(
      Option.fromNullishOr(response.data),
      () => new ListError({ message: "Failed to list agents", cause: response.error }),
    )
    const text = yield* encodeJson(body.data.toSorted((a, b) => a.id.localeCompare(b.id)))
    process.stdout.write(text + EOL)
  }),
)

import type { Plugin } from "@opencode-ai/plugin"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { randomInt } from "node:crypto"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"

const DEV_DATA_FILE = "/tmp/opencode-workspace-dev-data.json"
const DEV_DATA_TEMP_FILE = `${DEV_DATA_FILE}.tmp`

class DebugWorkspaceError extends Schema.TaggedError<DebugWorkspaceError>()("DebugWorkspaceError", {
  message: Schema.String,
}) {}

// script/run-workspace-server reads this file; undefined env values are dropped
// from the JSON, as before.
const DevData = Schema.Struct({
  port: Schema.Number,
  id: WorkspaceV2.ID,
  env: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
}).annotate({ identifier: "DebugWorkspaceDevData" })
const encodeDevData = Schema.encodeSync(Schema.fromJsonString(DevData, { space: 2 }))

const DebugLayer = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)

const waitForHealth = Effect.fn("DebugWorkspace.waitForHealth")(function* (port: number) {
  const url = `http://127.0.0.1:${port}/global/health`
  const http = yield* HttpClient.HttpClient

  yield* http.get(url).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.void
        : Effect.fail(new DebugWorkspaceError({ message: `Debug server health check returned ${response.status}` })),
    ),
    Effect.retry(Schedule.spaced("250 millis")),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(new DebugWorkspaceError({ message: `Timed out waiting for debug server health check at ${url}` })),
    }),
  )
})

let PORT: number | undefined

const writeDebugData = Effect.fn("DebugWorkspace.writeDebugData")(function* (
  port: number,
  id: WorkspaceV2.ID,
  env: Record<string, string | undefined>,
) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(DEV_DATA_TEMP_FILE, encodeDevData({ port, id, env }))
  yield* fs.rename(DEV_DATA_TEMP_FILE, DEV_DATA_FILE)
})

// The plugin SDK types every hook as a Promise, so each hook runs its Effect here.
export const DebugWorkspacePlugin: Plugin = ({ experimental_workspace }) => {
  experimental_workspace.register("debug", {
    name: "Debug",
    description: "Create a debugging server",
    configure(config) {
      return config
    },
    create(config, env) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const port = randomInt(5000, 9001)
          PORT = port

          // The plugin SDK hands the workspace ID over as a plain string.
          const id = yield* Schema.decodeUnknownEffect(WorkspaceV2.ID)(config.id)
          yield* writeDebugData(port, id, env)

          yield* waitForHealth(port)
        }).pipe(Effect.provide(DebugLayer)),
      )
    },
    remove(_config) {
      return Effect.runPromise(Effect.void)
    },
    target(_config) {
      return {
        type: "remote",
        url: `http://localhost:${PORT!}/`,
      }
    },
  })

  return Effect.runPromise(Effect.succeed({}))
}

export default DebugWorkspacePlugin

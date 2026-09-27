import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { Database } from "@opencode-ai/core/database/database"
import { Effect, HashSet, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Fence from "@/server/shared/fence"

const ignoredMethods = HashSet.fromIterable<string>(["GET", "HEAD", "OPTIONS"])

// The fence header carries the changed aggregate sequence numbers as a JSON object.
const encodeFence = Schema.encodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)))

export const fenceLayer = HttpRouter.middleware<{ requires: Database.Service; handles: unknown }>()(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const workspaceID = yield* FlagConfig.OPENCODE_WORKSPACE_ID.pipe(Effect.orDie)
        if (Option.isNone(workspaceID) || HashSet.has(ignoredMethods, request.method)) return yield* effect

        const previous = yield* Fence.load(db)
        const response = yield* effect
        const current = Fence.diff(previous, yield* Fence.load(db))
        if (Object.keys(current).length === 0) return response

        return HttpServerResponse.setHeader(response, Fence.HEADER, yield* encodeFence(current).pipe(Effect.orDie))
      })
  }),
).layer

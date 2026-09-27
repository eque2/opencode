import { Schema } from "effect"
import { ServerEvent } from "@opencode-ai/schema/server-event"
import { EventV2 } from "@opencode-ai/core/event"

export const Event = ServerEvent

export const InstanceDisposed = Schema.Struct({
  id: EventV2.ID,
  type: Schema.Literal("server.instance.disposed"),
  properties: Schema.Struct({ directory: Schema.String }),
}).annotate({ identifier: "Event.server.instance.disposed" })

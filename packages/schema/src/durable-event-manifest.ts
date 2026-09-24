export * as DurableEventManifest from "./durable-event-manifest"

import { Result } from "effect"
import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"

// A duplicate definition is a defect in this module, so it fails module load.
export const SessionDurable = {
  definitions: Result.getOrThrow(Event.durable(SessionEvent.DurableDefinitions)),
  schema: SessionEvent.Durable,
} as const

export const Durable = Result.getOrThrow(
  Event.durable([
    ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
    ...SessionEvent.DurableDefinitions,
  ]),
)

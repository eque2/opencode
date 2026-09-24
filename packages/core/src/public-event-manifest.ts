export * as PublicEventManifest from "./public-event-manifest"

import { Result } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { EventManifest } from "@opencode-ai/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Result.getOrThrow(Event.latest(Definitions))

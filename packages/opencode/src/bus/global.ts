import { Identifier } from "@/id/id"
import { Effect, MutableRef, Option, PubSub, Stream } from "effect"
import type { Scope } from "effect"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

// The bus is process-wide. PubSub has no synchronous constructor, so the first
// subscriber creates it. A publish before any subscriber exists has no receiver,
// which keeps the delivery of the earlier EventEmitter bus.
const current = MutableRef.make(Option.none<PubSub.PubSub<GlobalEvent>>())

const pubsub = PubSub.unbounded<GlobalEvent>().pipe(
  // Two fibers can race to create the bus; the first one stored wins.
  Effect.map((created) =>
    Option.getOrElse(MutableRef.get(current), () => {
      MutableRef.set(current, Option.some(created))
      return created
    }),
  ),
)

// Each payload gets an event ID, taken from its sync event when one is present.
const stamp = (event: GlobalEvent) => {
  if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
    event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
  }
  return event
}

/** Publishes an event to every current subscriber. */
export const publish = (event: GlobalEvent) =>
  Effect.suspend(() => {
    const stamped = stamp(event)
    return Option.match(MutableRef.get(current), {
      onNone: () => Effect.void,
      onSome: (bus) => PubSub.publish(bus, stamped).pipe(Effect.asVoid),
    })
  })

/** Publishes an event from synchronous code. The unbounded bus always accepts it. */
export const publishUnsafe = (event: GlobalEvent) => {
  const stamped = stamp(event)
  Option.map(MutableRef.get(current), (bus) => PubSub.publishUnsafe(bus, stamped))
}

/** Subscribes for the lifetime of the scope. Events published after the subscription are delivered. */
export const subscribe: Effect.Effect<PubSub.Subscription<GlobalEvent>, never, Scope.Scope> = pubsub.pipe(
  Effect.flatMap(PubSub.subscribe),
)

/** Streams the events published after the stream starts. */
export const stream: Stream.Stream<GlobalEvent> = Stream.unwrap(Effect.map(pubsub, Stream.fromPubSub))

export * as GlobalBus from "./global"

// The one bridge from the taskView actor to Solid (spine AD-16): `fromActor` follows the actor's snapshots and sets one
// signal. It decides nothing; the designs read view state through it and through pure selectors over its snapshot.
import { Effect, Fiber, Stream } from "effect"
import { createSignal, onCleanup, type Accessor, type Signal } from "solid-js"

interface Followed<S> {
  readonly getSnapshot: Effect.Effect<S>
  readonly changes: Stream.Stream<S, unknown>
}

/** The actor's snapshot as a Solid accessor, for as long as the calling owner lives. */
export function fromActor<S>(actor: Followed<S>): Accessor<S> {
  return follow(actor, createSignal(Effect.runSync(actor.getSnapshot)))
}

// Sets the signal from each new snapshot until the calling owner ends.
const follow = <S>(actor: Followed<S>, [snapshot, setSnapshot]: Signal<S>): Accessor<S> => {
  const fiber = Effect.runFork(
    Stream.runForEach(actor.changes, (next) => Effect.sync(() => setSnapshot(() => next))).pipe(Effect.ignore),
  )
  onCleanup(() => Effect.runFork(Fiber.interrupt(fiber)))
  return snapshot
}

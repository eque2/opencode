import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Effect, PubSub } from "effect"
import { TestFailure } from "../fixture/test-failure"

// Subscribes when the effect starts. Fork it with startImmediately before the action that publishes.
export function waitGlobalBusEvent(input: {
  timeout?: number
  message?: string
  predicate: (event: GlobalEvent) => boolean
}) {
  const next = (subscription: PubSub.Subscription<GlobalEvent>): Effect.Effect<GlobalEvent, TestFailure> =>
    PubSub.take(subscription).pipe(
      Effect.flatMap((event) =>
        Effect.try({
          try: () => input.predicate(event),
          catch: (error) => new TestFailure({ message: `global bus predicate failed: ${String(error)}` }),
        }).pipe(Effect.flatMap((matched) => (matched ? Effect.succeed(event) : next(subscription)))),
      ),
    )

  return Effect.scoped(GlobalBus.subscribe.pipe(Effect.flatMap(next))).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout ?? 10_000,
      orElse: () =>
        Effect.fail(new TestFailure({ message: input.message ?? "timed out waiting for global bus event" })),
    }),
  )
}

// Takes events from the subscription until one matches the predicate.
export const takeGlobalBusEvent = (
  subscription: PubSub.Subscription<GlobalEvent>,
  predicate: (event: GlobalEvent) => boolean,
): Effect.Effect<GlobalEvent> =>
  PubSub.take(subscription).pipe(
    Effect.flatMap((event) => (predicate(event) ? Effect.succeed(event) : takeGlobalBusEvent(subscription, predicate))),
  )

// Subscribes for the lifetime of the scope. The returned effect gives every event published since the
// subscription, in publish order. A publish reaches the subscription synchronously, so no fiber must run first.
export const collectGlobalBusEvents = Effect.gen(function* () {
  const subscription = yield* GlobalBus.subscribe
  const seen: GlobalEvent[] = []
  return PubSub.takeUpTo(subscription, Number.POSITIVE_INFINITY).pipe(
    Effect.map((next) => {
      seen.push(...next)
      return seen
    }),
  )
})

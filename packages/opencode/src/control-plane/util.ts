import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Effect, PubSub, Schema } from "effect"

export class WaitEventAbortedError extends Schema.TaggedError<WaitEventAbortedError>()("WaitEventAbortedError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class WaitEventTimeoutError extends Schema.TaggedError<WaitEventTimeoutError>()("WaitEventTimeoutError", {
  message: Schema.String,
  timeout: Schema.Number,
}) {}

export class WaitEventPredicateError extends Schema.TaggedError<WaitEventPredicateError>()("WaitEventPredicateError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type WaitEventError = WaitEventAbortedError | WaitEventTimeoutError | WaitEventPredicateError

// The abort reason is caller data of any shape, so it is kept as the cause.
const aborted = (signal: AbortSignal | undefined) =>
  new WaitEventAbortedError({
    message: signal?.reason instanceof Error ? signal.reason.message : "Request aborted",
    cause: signal?.reason,
  })

export function waitEvent(input: {
  timeout: number
  signal?: AbortSignal
  fn: (event: GlobalEvent) => boolean
}): Effect.Effect<void, WaitEventError> {
  if (input.signal?.aborted) return Effect.fail(aborted(input.signal))

  return Effect.scoped(
    Effect.gen(function* () {
      // Subscribe before the first take, so no event published after this point is lost.
      const subscription = yield* GlobalBus.subscribe
      const matched = PubSub.take(subscription).pipe(
        Effect.flatMap((event) =>
          Effect.try({
            try: () => input.fn(event),
            catch: (cause) => new WaitEventPredicateError({ message: "Global event predicate failed", cause }),
          }),
        ),
        Effect.repeat({ until: (done) => done }),
        Effect.asVoid,
      )
      const signal = input.signal
      return yield* signal ? Effect.raceFirst(matched, abortion(signal)) : matched
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(
          new WaitEventTimeoutError({ message: "Timed out waiting for global event", timeout: input.timeout }),
        ),
    }),
  )
}

// Fails with the abort reason when the caller aborts the wait.
const abortion = (signal: AbortSignal) =>
  Effect.callback<never, WaitEventAbortedError>((resume) => {
    const abort = () => resume(Effect.fail(aborted(signal)))
    // The signal can abort between the eager check and the start of this fiber.
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })

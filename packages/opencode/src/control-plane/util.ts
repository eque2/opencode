import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Effect, Result, Schema } from "effect"

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

  return Effect.callback<void, WaitEventAbortedError | WaitEventPredicateError>((resume) => {
    const abort = () => {
      cleanup()
      resume(Effect.fail(aborted(input.signal)))
    }

    const handler = (event: GlobalEvent) => {
      const matched = Result.try({
        try: () => input.fn(event),
        catch: (cause) => new WaitEventPredicateError({ message: "Global event predicate failed", cause }),
      })
      if (Result.isSuccess(matched) && !matched.success) return
      cleanup()
      resume(Result.isSuccess(matched) ? Effect.void : Effect.fail(matched.failure))
    }

    const cleanup = () => {
      GlobalBus.off("event", handler)
      input.signal?.removeEventListener("abort", abort)
    }

    GlobalBus.on("event", handler)
    input.signal?.addEventListener("abort", abort, { once: true })
    return Effect.sync(cleanup)
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(
          new WaitEventTimeoutError({ message: "Timed out waiting for global event", timeout: input.timeout }),
        ),
    }),
  )
}

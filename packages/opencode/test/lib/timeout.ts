import { Duration, Effect, Schema } from "effect"

/** A test step did not settle in time. The message is the step label. */
export class TestTimeoutError extends Schema.TaggedError<TestTimeoutError>()("TestTimeoutError", {
  message: Schema.String,
}) {}

/**
 * Settles as `promise` does, or rejects with a TestTimeoutError after `ms` milliseconds.
 * A rejection of `promise` passes through unchanged.
 */
export function withTimeout<A>(promise: Promise<A>, ms: number, label?: string) {
  return Effect.runPromise(
    Effect.promise(() => promise).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(ms),
        orElse: () => Effect.fail(new TestTimeoutError({ message: label ?? `Operation timed out after ${ms}ms` })),
      }),
    ),
  )
}

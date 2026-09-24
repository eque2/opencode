import { Duration, Effect, Schedule, Schema } from "effect"

export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  // oxlint-disable-next-line no-base-to-string -- error is unknown, intentional coercion for message matching
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => message.includes(m))
}

class RetryAttemptError extends Schema.TaggedError<RetryAttemptError>()("Retry.AttemptError", {
  cause: Schema.Defect(),
}) {}

export function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delay = 500, factor = 2, maxDelay = 10000, retryIf = isTransientError } = options

  return Effect.runPromise(
    Effect.tryPromise({ try: () => fn(), catch: (cause) => new RetryAttemptError({ cause }) }).pipe(
      Effect.retry({
        // Wait delay * factor^n before retry n, capped at maxDelay.
        schedule: Schedule.min([
          Schedule.exponential(Duration.millis(delay), factor),
          Schedule.spaced(Duration.millis(maxDelay)),
        ]),
        times: attempts - 1,
        while: (error) => retryIf(error.cause),
      }),
      // Callers see the value fn rejected with, as before, so it leaves as the defect runPromise rejects with.
      Effect.catchTag("Retry.AttemptError", (error) => Effect.die(error.cause)),
    ),
  )
}

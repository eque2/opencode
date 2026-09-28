import * as Data from "effect/Data"

/**
 * Raised by a query builder method when its input cannot form a valid query.
 *
 * Drizzle builder methods (`values`, `select`, `set`, `onConflictDoUpdate`, joins,
 * `prepare`) return the next builder synchronously, so this error is thrown at build
 * time with the same message upstream Drizzle uses.
 */
export class EffectDrizzleBuilderError extends Data.TaggedError("EffectDrizzleBuilderError")<{
  readonly message: string
}> {}

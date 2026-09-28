import { Data } from "effect"

/**
 * Raised when a context hook runs outside the provider that supplies its value.
 *
 * Solid context hooks return their value synchronously, so they throw this error
 * instead of returning an Effect. The `message` text is the text that callers see.
 */
export class MissingProviderError extends Data.TaggedError("MissingProviderError")<{
  readonly message: string
}> {}

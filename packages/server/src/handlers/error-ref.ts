import { Effect, Random } from "effect"

/**
 * Draws the short reference that links an UnknownError response to its server log entry.
 *
 * The reference is "err_" followed by eight lowercase hex digits, drawn from the Random service.
 */
export const errorRef = Random.nextIntBetween(0, 0xffffffff).pipe(
  Effect.map((value) => `err_${value.toString(16).padStart(8, "0")}`),
)

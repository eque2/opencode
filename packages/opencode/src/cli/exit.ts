import { Effect } from "effect"
import { Datadog } from "@opencode-ai/core/observability/datadog"

/**
 * Exits the process after the Datadog sinks send their buffered records. `process.exit()` skips the runtime
 * finalizers, so a direct exit would drop the last batch. The void annotation keeps the thunk from reading as a
 * Promise-returning one.
 */
export const exitProcess = (code?: number) =>
  Datadog.flushAll.pipe(Effect.andThen(Effect.sync((): void => process.exit(code))))

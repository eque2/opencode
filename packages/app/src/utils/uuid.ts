import { Random, Result } from "effect"

// uuid() is a sync API that callers use with or without a fiber, so the fallback reads the default Random service
// directly instead of yielding it.
const random = Random.Random.defaultValue()

const fallback = () => random.nextDoubleUnsafe().toString(16).slice(2)

export function uuid() {
  const c = globalThis.crypto
  if (!c || typeof c.randomUUID !== "function") return fallback()
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) return fallback()
  // randomUUID can still throw (a DOMException) in some runtimes, and then the fallback runs.
  return Result.getOrElse(
    Result.try(() => c.randomUUID()),
    fallback,
  )
}

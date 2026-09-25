import { Random } from "effect"

// uuid() is a sync API that runs outside any fiber, so the fallback reads the default Random service directly.
const random = Random.Random.defaultValue()

const fallback = () => random.nextDoubleUnsafe().toString(16).slice(2)

export function uuid() {
  const c = globalThis.crypto
  if (!c || typeof c.randomUUID !== "function") return fallback()
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext) return fallback()
  try {
    return c.randomUUID()
  } catch {
    return fallback()
  }
}

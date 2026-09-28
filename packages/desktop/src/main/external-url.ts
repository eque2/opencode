import { fileURLToPath } from "node:url"
import { Result } from "effect"

export function resolveExternalURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href
  return undefined
}

export function resolveLocalFilePath(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== "file:" || url.hostname) return undefined
  // fileURLToPath throws for a file URL that the platform cannot map to a path.
  return Result.getOrUndefined(Result.try(() => fileURLToPath(url)))
}

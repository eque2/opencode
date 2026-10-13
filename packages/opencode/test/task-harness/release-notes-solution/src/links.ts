import { escapeMarkdown } from "./render"

export type LinkConfig = { issueUrl: string; keyPattern: RegExp }

/** The agreed issue-key pattern (RN-A2), used when the config gives no `keyPattern`. */
export const DEFAULT_KEY_PATTERN = "^[A-Z][A-Z0-9]+-\\d+$"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compile(pattern: string): RegExp | { error: string } {
  try {
    // Anchored and without the `g` flag, so `test` gives the same answer for the same key every time.
    return new RegExp(`^(?:${pattern})$`)
  } catch (cause) {
    return {
      error: `keyPattern is not a valid regular expression: ${cause instanceof Error ? cause.message : pattern}`,
    }
  }
}

export function parseLinkConfig(text: string): LinkConfig | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: "the config is not valid JSON" }
  }
  if (!isRecord(value)) return { error: "the config must be a JSON object" }

  const issueUrl = value["issueUrl"]
  if (typeof issueUrl !== "string") return { error: "issueUrl must be a string" }
  if (!issueUrl.includes("{key}")) return { error: "issueUrl must contain {key}" }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(issueUrl)?.[1]?.toLowerCase()
  if (scheme !== "http" && scheme !== "https") return { error: "issueUrl must start with http:// or https://" }

  // JSON has no `undefined`, so `undefined` here means the key is missing; `null` is present and not a string.
  const pattern = value["keyPattern"] === undefined ? DEFAULT_KEY_PATTERN : value["keyPattern"]
  if (typeof pattern !== "string") return { error: "keyPattern must be a string" }
  const keyPattern = compile(pattern)
  if (!(keyPattern instanceof RegExp)) return keyPattern
  return { issueUrl, keyPattern }
}

/** The key as the renderer shows plain text. */
export function plainLinkify(key: string): string {
  return escapeMarkdown(key)
}

function encodeKey(key: string): string {
  return encodeURIComponent(key).replace(/\(/g, "%28").replace(/\)/g, "%29")
}

export function makeLinkify(config: LinkConfig): (key: string) => string {
  return (key) => {
    if (!config.keyPattern.test(key)) return plainLinkify(key)
    const text = escapeMarkdown(key).replace(/[()]/g, "\\$&")
    const url = config.issueUrl.split("{key}").join(encodeKey(key))
    return `[${text}](${url})`
  }
}

import { Option, Predicate } from "effect"
import { isRecord } from "./record"

type ConfigIssue = { message: string; path: string[] }

export function cliErrorMessage(input: unknown): string | undefined {
  if (input instanceof Error && isRecord(input.cause) && "body" in input.cause) {
    const formatted = cliErrorMessage(input.cause.body)
    if (formatted) return formatted
  }

  if (tagged(input, "CliError")) {
    if (typeof input.exitCode === "number") process.exitCode = input.exitCode
    return text(input, "message")
  }
  if (tagged(input, "AccountServiceError") || tagged(input, "AccountTransportError")) {
    return text(input, "message")
  }

  const model = configData(input, "ProviderModelNotFoundError")
  if (model) {
    const suggestions = Array.isArray(model.suggestions)
      ? model.suggestions.filter((item): item is string => typeof item === "string")
      : []
    return [
      `Model not found: ${shown(field(model, "providerID"))}/${shown(field(model, "modelID"))}`,
      ...(suggestions.length ? ["Did you mean: " + suggestions.join(", ")] : []),
      "Try: `opencode models` to list available models",
      "Or check your config (opencode.json) provider/model names",
    ].join("\n")
  }

  const provider = configData(input, "ProviderInitError")
  if (provider)
    return `Failed to initialize provider "${shown(field(provider, "providerID"))}". Check credentials and configuration.`

  const json = configData(input, "ConfigJsonError")
  if (json) {
    return `Config file at ${shown(field(json, "path"))} is not valid JSON(C)` + suffix(": ", field(json, "message"))
  }

  const directory = configData(input, "ConfigDirectoryTypoError")
  if (directory) {
    return `Directory "${shown(field(directory, "dir"))}" in ${shown(field(directory, "path"))} is not valid. Rename the directory to "${shown(field(directory, "suggestion"))}" or remove it. This is a common typo.`
  }

  const frontmatter = configData(input, "ConfigFrontmatterError")
  if (frontmatter) return text(frontmatter, "message")

  const remoteAuth = configData(input, "ConfigRemoteAuthError")
  if (remoteAuth) {
    const url = nonEmpty(field(remoteAuth, "url"))
    return [
      `Failed to load remote config${suffix(" from ", field(remoteAuth, "remote"))}: the server returned a login page instead of JSON.`,
      "Authentication is missing or has expired (the endpoint is likely behind an SSO or identity-aware proxy).",
      ...Option.match(url, {
        onNone: () => [],
        onSome: (value) => [`Run \`opencode auth login ${value}\` to re-authenticate.`],
      }),
    ].join("\n")
  }

  const invalid = configData(input, "ConfigInvalidError")
  if (invalid) {
    const path = nonEmpty(field(invalid, "path")).pipe(Option.filter((value) => value !== "config"))
    const issues = Array.isArray(invalid.issues)
      ? invalid.issues.filter((issue): issue is ConfigIssue => {
          return (
            isRecord(issue) &&
            typeof issue.message === "string" &&
            Array.isArray(issue.path) &&
            issue.path.every((item) => typeof item === "string")
          )
        })
      : []
    return [
      `Configuration is invalid${suffix(" at ", path)}` + suffix(": ", field(invalid, "message")),
      ...issues.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")),
    ].join("\n")
  }

  if (tagged(input, "UICancelledError") || named(input, "UICancelledError")) return ""
  if (isRecord(input) && named(input, "MCPFailed")) {
    const name = Option.liftPredicate(input.data, isRecord).pipe(Option.flatMap((data) => field(data, "name")))
    return `MCP server "${shown(name)}" failed. Note, opencode does not support MCP authentication yet.`
  }
  return undefined
}

function tagged(input: unknown, tag: string): input is Record<string, unknown> {
  return isRecord(input) && input._tag === tag
}

function named(input: unknown, name: string) {
  return isRecord(input) && (input.name === name || input._tag === name)
}

function configData(input: unknown, tag: string) {
  if (!isRecord(input)) return undefined
  if (input.name === tag && isRecord(input.data)) return input.data
  if (input._tag === tag) return input
  return undefined
}

function field(input: Record<string, unknown>, key: string): Option.Option<string> {
  return Option.liftPredicate(input[key], Predicate.isString)
}

/** The string field, or "" when it is absent. */
function text(input: Record<string, unknown>, key: string) {
  return Option.getOrElse(field(input, key), () => "")
}

/** The value, or the text "undefined" that the message templates printed for an absent field. */
function shown(value: Option.Option<string>) {
  return Option.getOrElse(value, () => "undefined")
}

/** The value when it is present and not empty. */
function nonEmpty(value: Option.Option<string>) {
  return Option.filter(value, (text) => text.length > 0)
}

/** The prefix and value when the value is present and not empty, or "". */
function suffix(prefix: string, value: Option.Option<string>) {
  return Option.match(nonEmpty(value), { onNone: () => "", onSome: (text) => prefix + text })
}

export function errorFormat(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  if (typeof error === "object" && error !== null) {
    try {
      const json = JSON.stringify(error, null, 2)
      // Plain objects whose own properties are all non-enumerable (or empty)
      // serialize to "{}", which prints as a useless bare `{}` on stderr.
      // Fall back to a custom toString first, then to ctor name + own prop names.
      if (json === "{}") {
        const str = String(error)
        if (str && str !== "[object Object]") return str
        const ctor = error.constructor?.name
        const prefix = ctor && ctor !== "Object" ? ctor : "Error"
        const names = Object.getOwnPropertyNames(error)
        return names.length === 0 ? `${prefix} (no message)` : `${prefix} { ${names.join(", ")} }`
      }
      return json
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(error)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message) return error.message
    if (error.name) return error.name
  }

  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message
  }

  if (isRecord(error) && isRecord(error.data) && typeof error.data.message === "string" && error.data.message) {
    return error.data.message
  }

  const text = String(error)
  if (text && text !== "[object Object]") return text

  const formatted = errorFormat(error)
  if (formatted) return formatted
  return "unknown error"
}

export function errorData(error: unknown) {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: errorMessage(error),
      stack: error.stack,
      ...(error.cause === undefined ? {} : { cause: errorFormat(error.cause) }),
      formatted: errorFormat(error),
    }
  }

  if (!isRecord(error)) {
    return {
      type: typeof error,
      message: errorMessage(error),
      formatted: errorFormat(error),
    }
  }

  const data = Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>((acc, key) => {
    const value = error[key]
    if (value === undefined) return acc
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      acc[key] = value
      return acc
    }
    // oxlint-disable-next-line no-base-to-string -- intentional coercion of arbitrary error properties
    acc[key] = value instanceof Error ? value.message : String(value)
    return acc
  }, {})

  if (typeof data.message !== "string") data.message = errorMessage(error)
  if (typeof data.type !== "string") data.type = error.constructor?.name
  data.formatted = errorFormat(error)
  return data
}

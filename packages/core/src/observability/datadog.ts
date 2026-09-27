import { Config, Duration, Effect, Formatter, Logger, LogLevel, Option, Redacted, Schedule } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import os from "os"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

// Every switch is an Effect Config, so any ConfigProvider (env, JSON file, test override) can supply it.
export const config = Config.all({
  apiKey: Config.option(Config.Redacted("DD_API_KEY")),
  enabled: Config.Boolean("OPENCODE_DATADOG_LOGS").pipe(Config.withDefault(true)),
  site: Config.String("DD_SITE").pipe(Config.withDefault("datadoghq.com")),
  url: Config.option(Config.String("OPENCODE_DATADOG_LOGS_URL")),
  service: Config.String("DD_SERVICE").pipe(Config.withDefault("opencode")),
  env: Config.String("DD_ENV").pipe(Config.withDefault(InstallationChannel)),
  version: Config.String("DD_VERSION").pipe(Config.withDefault(InstallationVersion)),
  tags: Config.String("DD_TAGS").pipe(Config.withDefault("")),
  hostname: Config.String("DD_HOSTNAME").pipe(Config.withDefault(os.hostname())),
  level: Config.LogLevel("OPENCODE_DATADOG_LOG_LEVEL").pipe(Config.withDefault<LogLevel.LogLevel>("Info")),
  categories: Config.String("OPENCODE_DATADOG_CATEGORIES").pipe(Config.withDefault("*")),
  content: Config.Literals(["omit", "hash", "full"], "OPENCODE_DATADOG_CONTENT").pipe(Config.withDefault("omit")),
  flushInterval: Config.Duration("OPENCODE_DATADOG_FLUSH_INTERVAL").pipe(Config.withDefault(Duration.seconds(5))),
})

export type Settings = Config.Success<typeof config>

type Entry = Record<string, unknown>

// Secrets are always redacted. Content keys follow the `content` switch because prompts and file bodies may hold personal data.
const SECRET = /api[-_]?key|authorization|password|secret|token|cookie|credential/i
const CONTENT = new Set([
  "prompt",
  "system",
  "messages",
  "content",
  "text",
  "input",
  "output",
  "args",
  "arguments",
  "result",
  "diff",
  "command",
])

// Datadog intake limits: 1000 entries and 5 MB per request.
const MAX_ENTRIES = 1000
const MAX_BYTES = 4_500_000

/** Resolves the settings, or undefined when the sink must not run. */
export const settings = Effect.gen(function* () {
  const value = yield* config
  return value.enabled && Option.isSome(value.apiKey) ? value : undefined
}).pipe(
  // A bad value must not stop startup; the sink stays off instead.
  Effect.orElseSucceed(() => undefined),
)

export function logger(settings: Settings) {
  const url = Option.getOrElse(settings.url, () => `https://http-intake.logs.${settings.site}/api/v2/logs`)
  const apiKey = Option.match(settings.apiKey, { onNone: () => "", onSome: Redacted.value })
  const include = categoryFilter(settings.categories)
  const format = Logger.make((options) =>
    LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.level) ? entry(options, settings, include) : undefined,
  )
  return Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const send = (batch: Array<Entry>) =>
      http
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("DD-API-KEY", apiKey),
            HttpClientRequest.bodyText(JSON.stringify(batch), "application/json"),
          ),
        )
        .pipe(
          Effect.retry({ times: 3, schedule: Schedule.exponential("500 millis") }),
          // ponytail: drops the batch after retries; add a disk spool when log loss is unacceptable.
          Effect.ignore,
          // The export request must not create spans or logs, or the sink feeds itself.
          Effect.withTracerEnabled(false),
        )
    return yield* Logger.batched(format, {
      window: settings.flushInterval,
      flush: (items) => Effect.forEach(chunks(items.filter((item) => item !== undefined)), send, { discard: true }),
    })
  })
}

/** Maps one Effect log record to a Datadog log entry, or undefined when its category is filtered out. */
export function entry(
  options: Logger.Options<unknown>,
  settings: Settings,
  include = categoryFilter(settings.categories),
) {
  const structured = Logger.formatStructured.log(options)
  const category = String(structured.annotations.category ?? "general")
  if (!include(category)) return undefined
  const messages = Array.isArray(options.message) ? options.message : [options.message]
  const attributes = Object.assign({}, ...messages.filter(plain), structured.annotations)
  const span = options.fiber.cache.span
  return {
    ...Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, redact(value, settings.content, key)]),
    ),
    message:
      messages
        .filter((value) => !plain(value))
        .map(text)
        .join(" ") || category,
    status: structured.level.toLowerCase(),
    date: structured.timestamp,
    service: settings.service,
    hostname: settings.hostname,
    ddsource: "opencode",
    ddtags: [`env:${settings.env}`, `version:${settings.version}`, settings.tags].filter(Boolean).join(","),
    category,
    run: runID,
    spans: structured.spans,
    ...(structured.cause === undefined ? {} : { error: { stack: structured.cause } }),
    ...(span?._tag === "Span"
      ? {
          trace_id: span.traceId,
          span_id: span.spanId,
          // Datadog correlates OpenTelemetry IDs through the decimal form of their low 64 bits.
          dd: { trace_id: decimal(span.traceId), span_id: decimal(span.spanId) },
        }
      : {}),
  } satisfies Entry
}

/** Parses "llm,tool.-tool.read" style lists: prefixes to include, "-" prefixes to exclude, "*" for all. */
export function categoryFilter(value: string) {
  const rules = value
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean)
  const exclude = rules.filter((rule) => rule.startsWith("-")).map((rule) => rule.slice(1))
  const include = rules.filter((rule) => !rule.startsWith("-"))
  const matches = (category: string, prefix: string) =>
    prefix === "*" || category === prefix || category.startsWith(`${prefix}.`)
  return (category: string) =>
    !exclude.some((prefix) => matches(category, prefix)) && include.some((prefix) => matches(category, prefix))
}

function redact(input: unknown, content: Settings["content"], key = ""): unknown {
  if (key && SECRET.test(key)) return "[REDACTED]"
  if (key && CONTENT.has(key) && content !== "full") return content === "omit" ? omitted(input) : hash(input)
  if (Array.isArray(input)) return input.map((value) => redact(value, content))
  if (!plain(input)) return input
  return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, redact(value, content, name)]))
}

function omitted(input: unknown) {
  return `[OMITTED ${text(input).length} chars]`
}

function hash(input: unknown) {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text(input)).digest("hex").slice(0, 16)}`
}

function chunks(items: Array<Entry>) {
  return items
    .reduce<Array<{ items: Array<Entry>; bytes: number }>>((result, item) => {
      const bytes = JSON.stringify(item).length
      const last = result.at(-1)
      if (last && last.items.length < MAX_ENTRIES && last.bytes + bytes < MAX_BYTES) {
        last.items.push(item)
        last.bytes += bytes
        return result
      }
      return [...result, { items: [item], bytes }]
    }, [])
    .map((chunk) => chunk.items)
}

function decimal(hex: string) {
  return BigInt(`0x${hex.slice(-16)}`).toString()
}

function text(input: unknown) {
  return typeof input === "string" ? input : Formatter.format(input)
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

export * as Datadog from "./datadog"

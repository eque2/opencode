import {
  Array as Arr,
  Clock,
  Config,
  DateTime,
  Duration,
  Effect,
  Formatter,
  HashSet,
  Logger,
  LogLevel,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import os from "os"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

// User answers and terminal sessions never leave the machine unless the env var re-includes them.
const DEFAULT_CATEGORIES = "*,-question,-pty"

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
  categories: Config.String("OPENCODE_DATADOG_CATEGORIES").pipe(Config.withDefault(DEFAULT_CATEGORIES)),
  content: Config.Literals(["omit", "hash", "full"], "OPENCODE_DATADOG_CONTENT").pipe(Config.withDefault("omit")),
  flushInterval: Config.Duration("OPENCODE_DATADOG_FLUSH_INTERVAL").pipe(Config.withDefault(Duration.seconds(5))),
})

export type Settings = Config.Success<typeof config>

type Entry = Record<string, unknown>

// Secrets are always redacted. Content keys follow the `content` switch because prompts and file bodies may hold personal data.
// A key is a secret when its lowercase form without `-` and `_` ends with one of these, so `inputTokens` is not.
const SECRET_KEYS = ["apikey", "authorization", "password", "secret", "token", "cookie", "credential"]
// Secret shapes inside any string. The left boundary keeps words such as `task-…` and `risk-…` intact.
const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(bearer\s+)[\w.~+/=-]+/gi, "$1[REDACTED]"],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g, "[REDACTED]"],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]+/g, "[REDACTED]"],
  // Query parameters such as `?key=`, `&exaApiKey=` and `&access_token=`.
  [/([?&][^=&#\s]*(?:key|token)=)[^&#\s]*/gi, "$1[REDACTED]"],
  [/((?<![A-Za-z0-9_])(?:api_key|access_token)=)[^&#\s]*/gi, "$1[REDACTED]"],
]
const CONTENT = HashSet.make(
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
  "answers",
  "cmd",
)

// Datadog intake limits: 1000 entries and 5 MB uncompressed per request, 1 MB per entry.
const MAX_ENTRIES = 1000
const MAX_BYTES = 4_500_000
const MAX_ENTRY_BYTES = 1_000_000
const TRUNCATED = "[TRUNCATED]"

const RETRIES = 3
const BACKOFF = Duration.millis(500)
const MAX_RETRY_AFTER = 30_000

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Resolves the settings, or none when the sink must not run. */
export const settings = Effect.gen(function* () {
  const value = yield* config
  return value.enabled && Option.isSome(value.apiKey) ? Option.some(value) : Option.none<Settings>()
}).pipe(
  // A bad value must not stop startup; the sink stays off instead.
  Effect.orElseSucceed(() => Option.none<Settings>()),
)

export function logger(settings: Settings) {
  const url = Option.getOrElse(settings.url, () => `https://http-intake.logs.${settings.site}/api/v2/logs`)
  const apiKey = Option.match(settings.apiKey, { onNone: () => "", onSome: Redacted.value })
  const include = categoryFilter(settings.categories)
  const format = Logger.make((options) =>
    LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.level)
      ? entry(options, settings, include)
      : Option.none(),
  )
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const post = (body: Uint8Array) =>
      http
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("DD-API-KEY", apiKey),
            HttpClientRequest.setHeader("Content-Encoding", "gzip"),
            HttpClientRequest.bodyUint8Array(body, "application/json"),
          ),
        )
        .pipe(
          Effect.map((response) => ({
            verdict: verdict(response.status),
            retryAfter: Option.fromNullishOr(response.headers["retry-after"]),
          })),
          // A transport error is retried like a 5xx.
          Effect.orElseSucceed(() => ({ verdict: "retry" as const, retryAfter: Option.none<string>() })),
        )
    // Each wait, from Retry-After or the backoff, uses one of the retries.
    const deliver = (body: Uint8Array, attempt = 0): Effect.Effect<"sent" | "dropped" | "failed"> =>
      Effect.flatMap(post(body), (result) => {
        if (result.verdict !== "retry") return Effect.succeed(result.verdict)
        if (attempt >= RETRIES) return Effect.succeed("failed" as const)
        return retryDelay(result.retryAfter).pipe(
          Effect.map(Option.getOrElse(() => Duration.times(BACKOFF, 2 ** attempt))),
          Effect.flatMap(Effect.sleep),
          Effect.andThen(Effect.suspend(() => deliver(body, attempt + 1))),
        )
      })
    const send = (batch: Array<Entry>) =>
      deliver(Bun.gzipSync(encodeJson(batch))).pipe(
        // ponytail: drops the batch after retries; add a disk spool when log loss is unacceptable.
        Effect.asVoid,
        // The export request must not create spans or logs, or the sink feeds itself.
        Effect.withTracerEnabled(false),
      )
    return yield* Logger.batched(format, {
      window: settings.flushInterval,
      flush: (items) => Effect.forEach(chunks(Arr.getSomes(items)), send, { discard: true }),
    })
  })
}

/** Maps one Effect log record to a Datadog log entry, or none when its category is filtered out. */
export function entry(
  options: Logger.Options<unknown>,
  settings: Settings,
  include = categoryFilter(settings.categories),
) {
  const structured = Logger.formatStructured.log(options)
  const category = Option.fromNullishOr(structured.annotations.category).pipe(
    Option.map(text),
    Option.getOrElse(() => "general"),
  )
  if (!include(category)) return Option.none<Entry>()
  const messages = Array.isArray(options.message) ? options.message : [options.message]
  const attributes = Object.assign({}, ...messages.filter(plain), structured.annotations)
  const span = options.fiber.cache.span
  return Option.some<Entry>({
    ...Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, redact(value, settings.content, key)]),
    ),
    message: scrub(
      messages
        .filter((value) => !plain(value))
        .map(text)
        .join(" ") || category,
    ),
    status: structured.level.toLowerCase(),
    date: structured.timestamp,
    service: settings.service,
    hostname: settings.hostname,
    ddsource: "opencode",
    ddtags: [`env:${settings.env}`, `version:${settings.version}`, settings.tags].filter(Boolean).join(","),
    category,
    run: runID,
    spans: structured.spans,
    ...(structured.cause === undefined ? {} : { error: { stack: redact(structured.cause, settings.content) } }),
    ...(span?._tag === "Span"
      ? {
          trace_id: span.traceId,
          span_id: span.spanId,
          // Datadog correlates OpenTelemetry IDs through the decimal form of their low 64 bits.
          dd: { trace_id: decimal(span.traceId), span_id: decimal(span.spanId) },
        }
      : {}),
  })
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
  if (key && secretKey(key)) return "[REDACTED]"
  if (key && HashSet.has(CONTENT, key) && content !== "full") return content === "omit" ? omitted(input) : hash(input)
  if (typeof input === "string") return scrub(input)
  if (Array.isArray(input)) return input.map((value) => redact(value, content))
  if (input instanceof Date) return input.toISOString()
  // Provider errors carry the request body in enumerable fields, so an error keeps only its name and message.
  if (input instanceof Error) return { name: input.name, message: redact(input.message, content) }
  if (!Predicate.isObject(input)) return input
  return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, redact(value, content, name)]))
}

/** What an intake status means. `failed` stops the sink: 401 and 403 mean a bad key, and retrying cannot fix it. */
function verdict(status: number) {
  if (status >= 200 && status < 300) return "sent"
  if (status === 401 || status === 403) return "failed"
  if (status === 408 || status === 429 || status >= 500) return "retry"
  return "dropped"
}

/** The Retry-After wait in seconds or as an HTTP-date, capped at 30 seconds. Any other value falls back to the backoff. */
function retryDelay(header: Option.Option<string>) {
  return Effect.map(Clock.currentTimeMillis, (now) =>
    header.pipe(
      Option.flatMap((value) =>
        /^\d+$/.test(value)
          ? Option.some(Number(value) * 1000)
          : /[a-z]/i.test(value)
            ? Option.map(DateTime.make(value), (date) => DateTime.toEpochMillis(date) - now)
            : Option.none(),
      ),
      Option.filter((wait) => wait >= 0),
      Option.map((wait) => Duration.millis(Math.min(wait, MAX_RETRY_AFTER))),
    ),
  )
}

function secretKey(key: string) {
  const name = key.toLowerCase().replaceAll(/[-_]/g, "")
  return SECRET_KEYS.some((secret) => name.endsWith(secret))
}

function scrub(value: string) {
  return SECRET_SHAPES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value)
}

function omitted(input: unknown) {
  return `[OMITTED ${text(input).length} chars]`
}

function hash(input: unknown) {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text(input)).digest("hex").slice(0, 16)}`
}

function chunks(items: Array<Entry>) {
  return items
    .map(fit)
    .reduce<Array<{ items: Array<Entry>; bytes: number }>>((result, { item, bytes }) => {
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

/** Measures an entry in UTF-8 bytes, and cuts its message when the entry is above the 1 MB entry limit. */
function fit(item: Entry) {
  const bytes = Buffer.byteLength(encodeJson(item))
  if (bytes <= MAX_ENTRY_BYTES || typeof item.message !== "string") return { item, bytes }
  const message = Buffer.from(item.message)
  // ponytail: the JSON escaping of the kept text is not counted, so a message full of quotes can stay slightly above the limit.
  const keep = Math.max(0, message.length - (bytes - MAX_ENTRY_BYTES) - Buffer.byteLength(TRUNCATED))
  // A cut inside a multi-byte character decodes to U+FFFD, so drop it.
  const cut = { ...item, message: message.subarray(0, keep).toString().replace(/�$/, "") + TRUNCATED }
  return { item: cut, bytes: Buffer.byteLength(encodeJson(cut)) }
}

function decimal(hex: string) {
  return BigInt(`0x${hex.slice(-16)}`).toString()
}

function text(input: unknown) {
  return typeof input === "string" ? input : Formatter.format(input)
}

function plain(input: unknown): input is Record<string, unknown> {
  if (!Predicate.isObject(input)) return false
  const prototype: unknown = Object.getPrototypeOf(input)
  return prototype === Object.prototype || Predicate.isNull(prototype)
}

export * as Datadog from "./datadog"

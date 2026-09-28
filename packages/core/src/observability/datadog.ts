import {
  Clock,
  Config,
  Context,
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
const GUARDED = ["question", "pty"]
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

/** A runtime scope override. A field that is not set keeps the value of the enclosing scope or the settings. */
export interface Policy {
  readonly content?: Settings["content"]
  readonly categories?: string
}

/** The policy of the current fiber tree. The sink reads it from the logging fiber for each record. */
export const LogPolicy = Context.Reference<Policy>("@opencode/Datadog/LogPolicy", { defaultValue: () => ({}) })

/**
 * Runs `self` with `patch` merged into the current policy, field by field; the inner value wins. A policy may
 * widen `content` up to `full`. Secrets stay redacted, and `question` and `pty` stay excluded unless the
 * OPENCODE_DATADOG_CATEGORIES env var re-includes them.
 */
export const withPolicy =
  (patch: Policy) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const current = yield* LogPolicy
      return yield* self.pipe(Effect.provideService(LogPolicy, { ...current, ...defined(patch) }))
    })

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
const COOLDOWN = Duration.seconds(60)
const MAX_BUFFER = 10_000
const FINAL_TIMEOUT = Duration.seconds(5)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Resolves the settings, or none when the sink must not run. */
export const settings = Effect.gen(function* () {
  const value = yield* config
  return value.enabled && Option.isSome(value.apiKey) ? Option.some(value) : Option.none<Settings>()
}).pipe(
  // A bad value must not stop startup; the sink stays off instead.
  Effect.orElseSucceed(() => Option.none<Settings>()),
)

export interface LoggerOptions {
  /** How long the sink stays off after a batch exhausts its retries. */
  readonly cooldown?: Duration.Input
}

export function logger(settings: Settings, options: LoggerOptions = {}) {
  const cooldown = Duration.fromInputUnsafe(options.cooldown ?? COOLDOWN)
  const url = Option.getOrElse(settings.url, () => `https://http-intake.logs.${settings.site}/api/v2/logs`)
  const apiKey = Option.match(settings.apiKey, { onNone: () => "", onSome: Redacted.value })
  const include = categoryFilter(settings.categories)
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
        // The export request must not create spans or logs, or the sink feeds itself.
        Effect.withTracerEnabled(false),
      )

    let buffer: Array<Entry> = []
    // The other loggers of the fiber that logged last. The breaker record goes to them, never to this sink.
    let others: ReadonlySet<Logger.Logger<unknown, unknown>> = yield* Logger.CurrentLoggers
    let openUntil = 0
    const isOpen = Effect.map(Clock.currentTimeMillis, (now) => now < openUntil)

    // Like OtlpExporter, the sink turns itself off for the cooldown instead of retrying every flush.
    const trip = Effect.gen(function* () {
      openUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(cooldown)
      yield* Effect.logWarning(`Datadog sink disabled for ${Duration.toSeconds(cooldown)} seconds`).pipe(
        Effect.provide(Logger.layer(Array.from(others).filter((logger) => logger !== sink))),
      )
    })

    // Takes the buffer and hands each chunk to `each`. An open breaker drops the records, including the chunks
    // after the one that tripped it.
    const drain = (each: (chunk: Array<Entry>) => Effect.Effect<void>) =>
      Effect.suspend(() => {
        const batch = buffer
        buffer = []
        return Effect.forEach(
          chunks(batch),
          (chunk) => Effect.flatMap(isOpen, (open) => (open ? Effect.void : each(chunk))),
          { discard: true },
        )
      })

    // ponytail: drops the batch after retries; add a disk spool when log loss is unacceptable.
    const flush = drain((chunk) => Effect.flatMap(send(chunk), (result) => (result === "failed" ? trip : Effect.void)))

    // Shutdown must not hang the CLI, so the final flush makes one attempt per chunk and never waits for Retry-After.
    const final = drain((chunk) =>
      post(Bun.gzipSync(encodeJson(chunk))).pipe(Effect.asVoid, Effect.withTracerEnabled(false)),
    ).pipe(Effect.timeoutOption(FINAL_TIMEOUT), Effect.asVoid)

    const sink = Logger.make((options) => {
      if (!LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.level)) return
      others = options.fiber.getRef(Logger.CurrentLoggers)
      Option.map(entry(options, settings, include), (item) => {
        buffer.push(item)
        // The oldest records go first when the intake cannot keep up.
        if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
      })
    })

    // Added before the loop starts, so the loop is interrupted first and the final flush runs last.
    yield* Effect.addFinalizer(() => final)
    // The loop keeps the Clock of this fiber, so a test provides TestClock before the logger builds.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(settings.flushInterval), flush)))
    return sink
  })
}

/** Maps one Effect log record to a Datadog log entry, or none when its category is filtered out. */
export function entry(
  options: Logger.Options<unknown>,
  settings: Settings,
  include = categoryFilter(settings.categories),
) {
  const policy = options.fiber.getRef(LogPolicy)
  const content = policy.content ?? settings.content
  const structured = Logger.formatStructured.log(options)
  const category = Option.fromNullishOr(structured.annotations.category).pipe(
    Option.map(text),
    Option.getOrElse(() => "general"),
  )
  // ponytail: parses the policy list for each record; cache it by string if policies become common.
  const allowed =
    policy.categories === undefined
      ? include(category)
      : categoryFilter(policy.categories)(category) && (!guarded(category) || include(category))
  if (!allowed) return Option.none<Entry>()
  const messages = Array.isArray(options.message) ? options.message : [options.message]
  const attributes = Object.assign({}, ...messages.filter(plain), structured.annotations)
  const span = options.fiber.cache.span
  return Option.some<Entry>({
    ...Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, redact(value, content, key)]),
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
    ...(structured.cause === undefined ? {} : { error: { stack: redact(structured.cause, content) } }),
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
function verdict(status: number): "sent" | "dropped" | "failed" | "retry" {
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

/** Categories that a file or a policy cannot re-include. */
function guarded(category: string) {
  return GUARDED.some((prefix) => category === prefix || category.startsWith(`${prefix}.`))
}

function defined(patch: Policy): Policy {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
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

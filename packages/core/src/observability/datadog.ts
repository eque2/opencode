import {
  Array as Arr,
  Cause,
  Clock,
  Config,
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Formatter,
  HashSet,
  Logger,
  LogLevel,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import os from "os"
import path from "path"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { domain } from "./category"
import { runID } from "./shared"

// User answers and terminal sessions never leave the machine unless the env var re-includes them.
const GUARDED = ["question", "pty"]
// Per-chunk protocol spans and per-token bus deltas are noise; the env var can re-include them.
const DEFAULT_CATEGORIES = "*,-question,-pty,-llm.chunk,-bus.delta"

// Layer 2 reads these global config files, in this order.
const CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"]
const API_KEYS = ["apiKey", "api_key", "DD_API_KEY"]
const SITES = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ddog-gov.com",
]
// The boolean file keys. A file may only turn one off.
const TOGGLES: Readonly<Record<string, string>> = {
  enabled: "OPENCODE_DATADOG_LOGS",
  spans: "OPENCODE_DATADOG_SPANS",
  events: "OPENCODE_DATADOG_EVENTS",
}
// The file keys that narrow, and the env var that each one sets. The toggles are handled apart.
const FILE_KEYS: Readonly<Record<string, string>> = {
  service: "DD_SERVICE",
  env: "DD_ENV",
  version: "DD_VERSION",
  tags: "DD_TAGS",
  hostname: "DD_HOSTNAME",
  level: "OPENCODE_DATADOG_LOG_LEVEL",
  categories: "OPENCODE_DATADOG_CATEGORIES",
  content: "OPENCODE_DATADOG_CONTENT",
  flushInterval: "OPENCODE_DATADOG_FLUSH_INTERVAL",
  site: "DD_SITE",
}
const decodeDuration = Schema.decodeUnknownOption(Schema.DurationFromString)
// Bun.JSONC accepts comments and trailing commas, and throws on a malformed file. The jsonc-parser package is not
// used here, because its UMD entry breaks a Node bundle of any module that reaches this sink.
const parseJsonc = Option.liftThrowable((text: string): unknown => Bun.JSONC.parse(text))

// Levels are case-insensitive, for example `DEBUG`, `debug` or `Debug`.
const LEVEL_NAMES = LogLevel.values.flatMap((level) => [level, level.toLowerCase(), level.toUpperCase()])

// Every switch is an Effect Config, so any ConfigProvider (env, JSON file, test override) can supply it.
export const config = Config.all({
  apiKey: Config.option(Config.Redacted("DD_API_KEY")),
  enabled: Config.Boolean("OPENCODE_DATADOG_LOGS").pipe(Config.withDefault(true)),
  // One record per ended span, from the span bridge.
  spans: Config.Boolean("OPENCODE_DATADOG_SPANS").pipe(Config.withDefault(true)),
  // One record per bus event, with its type and IDs but not its data.
  events: Config.Boolean("OPENCODE_DATADOG_EVENTS").pipe(Config.withDefault(true)),
  site: Config.String("DD_SITE").pipe(Config.withDefault("datadoghq.com")),
  url: Config.option(Config.String("OPENCODE_DATADOG_LOGS_URL")),
  service: Config.String("DD_SERVICE").pipe(Config.withDefault("opencode")),
  env: Config.String("DD_ENV").pipe(Config.withDefault(InstallationChannel)),
  version: Config.String("DD_VERSION").pipe(Config.withDefault(InstallationVersion)),
  tags: Config.String("DD_TAGS").pipe(Config.withDefault("")),
  hostname: Config.String("DD_HOSTNAME").pipe(Config.withDefault(os.hostname())),
  level: Config.Literals(LEVEL_NAMES, "OPENCODE_DATADOG_LOG_LEVEL").pipe(
    Config.map((name) => levelOf(name).pipe(Option.getOrElse((): LogLevel.LogLevel => "Info"))),
    Config.withDefault<LogLevel.LogLevel>("Info"),
  ),
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
  // A bad value must not stop startup; the sink stays off instead, and says why.
  Effect.catch((error) =>
    Effect.logWarning(`Datadog sink disabled by a bad setting: ${error.message}`).pipe(
      Effect.as(Option.none<Settings>()),
    ),
  ),
)

export interface ProviderOptions {
  /** The process env. It overrides every file value, and an empty value counts as unset. */
  readonly env: typeof process.env
  /** The global config dir. Project config files have no effect, because the sink is built once per process. */
  readonly configDir: string
}

/**
 * The ConfigProvider for `settings`: the env, then the `observability.datadog` object of the global config files,
 * then the code defaults. A file may only narrow what the process sends, and it never supplies the API key. Every
 * ignored file value logs one warning that names the file.
 */
export const provider = (options: ProviderOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const files = yield* Effect.forEach(CONFIG_FILES, (name) => {
      const file = path.join(options.configDir, name)
      return Effect.map(Effect.option(fs.readFileString(file)), (text) => ({ file, text }))
    })
    // An empty file counts as no file.
    const parsed = files.flatMap(({ file, text }) =>
      Option.isSome(text) && text.value.trim() ? [fileSettings(file, text.value)] : [],
    )
    yield* Effect.forEach(
      parsed.flatMap((result) => result.warnings),
      (message) => Effect.logWarning(message),
      { discard: true },
    )
    // Files merge key by key, and the later file wins.
    const fromFiles: Record<string, string> = Object.assign({}, ...parsed.map((result) => result.values))
    const fromEnv = Object.entries(options.env).filter((entry): entry is [string, string] => Boolean(entry[1]))
    return ConfigProvider.fromEnv({ env: { ...fromFiles, ...Object.fromEntries(fromEnv) } })
  }).pipe(Effect.provide(NodeFileSystem.layer))

/** Maps one file's `observability.datadog` object to env var values that narrow, and the warnings for the rest. */
function fileSettings(file: string, text: string) {
  const ignored = (reason: string) => ({ values: {}, warnings: [`Datadog settings in ${file} ignored: ${reason}`] })
  const parsed = parseJsonc(text)
  if (Option.isNone(parsed)) return ignored("the file is not valid JSONC")
  const input = parsed.value
  if (!Predicate.isObject(input) || !("observability" in input)) return { values: {}, warnings: [] }
  const observability = input.observability
  if (!plain(observability)) return ignored('"observability" is not an object')
  if (!("datadog" in observability)) return { values: {}, warnings: [] }
  const datadog = observability.datadog
  if (!plain(datadog)) return ignored('"observability.datadog" is not an object')
  const results = Object.entries(datadog).map(([key, value]) => [key, fileValue(key, value)] as const)
  return {
    values: Object.fromEntries(
      results.flatMap(([, result]) => (typeof result === "string" ? [] : Option.toArray(result))),
    ),
    // The API key names share one warning, which never quotes the value.
    warnings: Arr.dedupe(
      results.flatMap(([key, result]) =>
        typeof result !== "string"
          ? []
          : [`Datadog ${API_KEYS.includes(key) ? "API key" : `setting "${key}"`} in ${file} ignored: ${result}`],
      ),
    ),
  }
}

/** The env var and value for one file key, none for a value with no effect, or the reason the value is ignored. */
function fileValue(key: string, value: unknown): Option.Option<readonly [string, string]> | string {
  const set = (name: string, text: string) => Option.some([name, text] as const)
  if (API_KEYS.includes(key)) return "the API key is read only from the DD_API_KEY env var"
  if (key === "url") return "the intake URL is set only by the OPENCODE_DATADOG_LOGS_URL env var"
  const toggle = TOGGLES[key]
  if (toggle !== undefined) {
    if (value === false) return set(toggle, "false")
    return value === true ? Option.none() : "expected a boolean"
  }
  const name = FILE_KEYS[key]
  if (name === undefined) return "unknown key"
  if (typeof value !== "string") return "expected a string"
  if (key === "level")
    return Option.match(levelOf(value), { onNone: () => "unknown log level", onSome: (level) => set(name, level) })
  if (key === "content")
    return value === "omit" || value === "hash" ? set(name, value) : 'a file allows only "omit" or "hash"'
  if (key === "site") return SITES.includes(value) ? set(name, value) : "unknown Datadog site"
  if (key === "flushInterval")
    return Option.isSome(decodeDuration(value)) ? set(name, value) : 'expected a duration such as "10 seconds"'
  if (key === "categories") {
    const rules = value
      .split(",")
      .map((rule) => rule.trim())
      .filter(Boolean)
    if (rules.some((rule) => !rule.startsWith("-") && guarded(rule)))
      return "a file cannot re-include the question or pty categories"
    // A file cannot remove the default exclusions, so a wildcard keeps them.
    const include = categoryFilter(rules.join(","))
    const kept = GUARDED.filter((prefix) => include(prefix)).map((prefix) => `-${prefix}`)
    return set(name, [...rules, ...kept].join(","))
  }
  return set(name, value)
}

function levelOf(name: string) {
  return Option.fromNullishOr(LogLevel.values.find((level) => level.toLowerCase() === name.toLowerCase()))
}

export interface LoggerOptions {
  /** How long the sink stays off after a batch exhausts its retries. */
  readonly cooldown?: Duration.Input
}

// The final flush of every sink that is still open.
let live: ReadonlyArray<Effect.Effect<void>> = []
// Every open sink, for the records that go to Datadog only.
let sinks: ReadonlyArray<{ readonly settings: Settings; readonly logger: Logger.Logger<unknown, void> }> = []

/**
 * Sends one record to every open sink and to no other logger. The span bridge and the bus tap use it, so the file
 * log does not grow with a record for each span and event. `kind` names the switch that gates the record.
 */
export function emit(
  fiber: Fiber.Fiber<unknown, unknown>,
  kind: "spans" | "events",
  logLevel: LogLevel.LogLevel,
  message: ReadonlyArray<unknown>,
) {
  if (sinks.length === 0) return
  const date = new Date()
  for (const sink of sinks) {
    if (sink.settings[kind]) sink.logger.log({ fiber, date, logLevel, message, cause: Cause.empty })
  }
}

/** True when an open sink takes records of this kind, so a caller can skip building one. */
export const accepts = (kind: "spans" | "events") => sinks.some((sink) => sink.settings[kind])

/**
 * Sends the buffered records of every open sink, each within 5 seconds, and leaves the sinks running. Call it
 * before `process.exit()`, which skips the scope finalizers and would drop the last batch.
 */
export const flushAll = Effect.suspend(() =>
  Effect.forEach(live, (final) => final, { concurrency: "unbounded", discard: true }),
)

export function logger(settings: Settings, options: LoggerOptions = {}) {
  const cooldown = Duration.fromInputUnsafe(options.cooldown ?? COOLDOWN)
  const url = Option.getOrElse(settings.url, () => `https://http-intake.logs.${settings.site}/api/v2/logs`)
  const apiKey = Option.match(settings.apiKey, { onNone: () => "", onSome: Redacted.value })
  const include = categoryFilter(settings.categories)
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const run = yield* runID
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

    // ponytail: no disk spool. The ceiling: an outage loses the batch after its retries, every record while the
    // breaker is open, and all but the newest 10,000 buffered entries; the file log keeps the local copy. The
    // upgrade path, when log loss becomes unacceptable: a bounded spool in Global.Path.log with retention rules and
    // a data-loss-prevention review, because it writes redacted records to disk a second time.
    const flush = drain((chunk) => Effect.flatMap(send(chunk), (result) => (result === "failed" ? trip : Effect.void)))

    // Shutdown must not hang the CLI, so the final flush makes one attempt per chunk and never waits for Retry-After.
    const final = drain((chunk) =>
      post(Bun.gzipSync(encodeJson(chunk))).pipe(Effect.asVoid, Effect.withTracerEnabled(false)),
    ).pipe(Effect.timeoutOption(FINAL_TIMEOUT), Effect.asVoid)

    const sink = Logger.make((options) => {
      if (!LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.level)) return
      others = options.fiber.getRef(Logger.CurrentLoggers)
      Option.map(entry(options, settings, run, include), (item) => {
        buffer.push(item)
        // The oldest records go first when the intake cannot keep up.
        if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
      })
    })

    // Added before the loop starts, so the loop is interrupted first and the final flush runs last.
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.sync(() => {
          live = live.filter((each) => each !== final)
          sinks = sinks.filter((each) => each.logger !== sink)
        }),
        final,
      ),
    )
    live = [...live, final]
    sinks = [...sinks, { settings, logger: sink }]
    // The loop keeps the Clock of this fiber, so a test provides TestClock before the logger builds.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(settings.flushInterval), flush)))
    return sink
  })
}

/** Maps one Effect log record to a Datadog log entry, or none when its category is filtered out. */
export function entry(
  options: Logger.Options<unknown>,
  settings: Settings,
  run: string,
  include = categoryFilter(settings.categories),
) {
  const policy = options.fiber.getRef(LogPolicy)
  const content = policy.content ?? settings.content
  const structured = Logger.formatStructured.log(options)
  const messages = Array.isArray(options.message) ? options.message : [options.message]
  const span = options.fiber.cache.span
  // An emitted record names its category in its fields. Any other record takes the annotation, then the category
  // of the enclosing span, so an existing log inside `MCP.create` is `mcp`, not `general`.
  const category = Option.fromNullishOr(
    messages.filter(plain).find((value) => typeof value.category === "string")?.category ??
      structured.annotations.category,
  ).pipe(
    Option.map(text),
    Option.getOrElse(() => (span?._tag === "Span" ? domain(span.name) : "general")),
  )
  // ponytail: parses the policy list for each record; cache it by string if policies become common.
  const allowed =
    policy.categories === undefined
      ? include(category)
      : categoryFilter(policy.categories)(category) && (!guarded(category) || include(category))
  if (!allowed) return Option.none<Entry>()
  const attributes = Object.assign({}, ...messages.filter(plain), structured.annotations)
  return Option.some<Entry>({
    ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, redact(value, content, key)])),
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
    run,
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

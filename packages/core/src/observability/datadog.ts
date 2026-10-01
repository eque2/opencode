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
  MutableHashSet,
  MutableList,
  MutableRef,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
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
// used here, because its UMD entry breaks a Node bundle of any module that reaches this sink. Under Node, which has
// no Bun global, plain JSON still parses, and the warning names the runtime instead of blaming the file.
const jsonc = typeof Bun !== "undefined"
const parseJsonc = Option.liftThrowable((text: string): unknown => (jsonc ? Bun.JSONC.parse(text) : JSON.parse(text)))

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
    Effect.updateService(self, LogPolicy, (current) => ({ ...current, ...defined(patch) }))

type Entry = Record<string, unknown>

// Secrets are always redacted. Content keys follow the `content` switch because prompts and file bodies may hold personal data.
// A key is a secret when its lowercase form without `-` and `_` ends with one of these, so `inputTokens` is not.
const SECRET_KEYS = ["apikey", "authorization", "password", "secret", "token", "cookie", "credential"]
// Secret shapes inside any string. The left boundary keeps words such as `task-…` and `risk-…` intact.
const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(bearer\s+)[\w.~+/=-]+/gi, "$1[REDACTED]"],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  // The same formats as packages/http-recorder/src/redaction.ts.
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/g, "[REDACTED]"],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]"],
  [/(?<![A-Za-z0-9])(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]+/g, "[REDACTED]"],
  // Query parameters such as `?key=`, `&exaApiKey=` and `&access_token=`.
  [/([?&][^=&#\s]{0,64}(?:key|token)=)[^&#\s]*/gi, "$1[REDACTED]"],
  [/((?<![A-Za-z0-9_])(?:api_key|access_token)=)[^&#\s]*/gi, "$1[REDACTED]"],
  // URL userinfo such as `https://user:token@host`, which a git or npm plugin spec can carry.
  // The prefix runs are bounded: an unbounded run backtracks at every start position, so a long base64 value took
  // quadratic time, and the logger runs synchronously.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
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
const MAX_DEPTH = 20

const RETRIES = 3
const BACKOFF = Duration.millis(500)
const MAX_RETRY_AFTER = 30_000
const COOLDOWN = Duration.seconds(60)
const MAX_BUFFER = 10_000
const FINAL_TIMEOUT = Duration.seconds(5)
// An intake that accepts a request and never answers would stall the flush loop, so each request is bounded.
const REQUEST_TIMEOUT = Duration.seconds(10)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Resolves the settings, or none when the sink must not run. */
export const settings = Effect.gen(function* () {
  const value = yield* config
  return value.enabled && Option.isSome(value.apiKey) ? Option.some(value) : Option.none<Settings>()
}).pipe(
  // A bad value must not stop startup; the sink stays off instead, and says why. Only a config error does this, so
  // any other failure stays visible in the type.
  Effect.catchTag("ConfigError", (error) =>
    Effect.logWarning("Datadog sink disabled by a bad setting", { reason: error.message }).pipe(
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
export const provider = Effect.fn("Datadog.provider")(function* (options: ProviderOptions) {
  const fs = yield* FileSystem.FileSystem
  const files = yield* Effect.forEach(CONFIG_FILES, (name) => {
    const file = path.join(options.configDir, name)
    return fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
      // Any other read error, such as permission denied, is named; the file then counts as absent.
      Effect.catch((error) =>
        Effect.logWarning("Datadog settings file unreadable", { file, reason: error.message }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
      Effect.map((text) => ({ file, text })),
    )
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
}, Effect.provide(NodeFileSystem.layer))

/** Maps one file's `observability.datadog` object to env var values that narrow, and the warnings for the rest. */
function fileSettings(file: string, text: string) {
  const ignored = (reason: string) => ({ values: {}, warnings: [`Datadog settings in ${file} ignored: ${reason}`] })
  const parsed = parseJsonc(text)
  if (Option.isNone(parsed))
    return ignored(
      jsonc ? "the file is not valid JSONC" : "the file is not plain JSON, and this runtime cannot parse JSONC",
    )
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

/** Why a delivery ended: the intake status, or the transport error message. */
type Detail = { readonly status: number } | { readonly error: string }

interface OpenSink {
  readonly settings: Settings
  readonly logger: Logger.Logger<unknown, void>
  /** The final flush. */
  readonly final: Effect.Effect<void>
}

// Every open sink. This registry is process-global on purpose: the tracer ends spans synchronously, and code run by
// `Effect.runPromise` at a Promise edge has none of the layer's services, so neither can reach a service or a
// Reference. Each logger build adds its own entry and its finalizer removes only that entry, by identity, so builds
// never overwrite each other.
const open = MutableHashSet.empty<OpenSink>()

/**
 * Sends one record to every open sink and to no other logger. The span bridge and the bus tap use it, so the file
 * log does not grow with a record for each span and event. `kind` names the switch that gates the record; a
 * `records` record has no switch. It needs no loggers in the fiber, so code run by `Effect.runPromise` can use it.
 */
export function emit(
  fiber: Fiber.Fiber<unknown, unknown>,
  kind: "spans" | "events" | "records",
  logLevel: LogLevel.LogLevel,
  message: ReadonlyArray<unknown>,
) {
  if (MutableHashSet.size(open) === 0) return
  // `emit` runs outside any Effect, so it reads the wall clock directly.
  const date = DateTime.toDateUtc(DateTime.nowUnsafe())
  for (const sink of open) {
    if (kind === "records" || sink.settings[kind])
      sink.logger.log({ fiber, date, logLevel, message, cause: Cause.empty })
  }
}

/** True when an open sink takes records of this kind, so a caller can skip building one. */
export const accepts = (kind: "spans" | "events") => Arr.some(Arr.fromIterable(open), (sink) => sink.settings[kind])

/**
 * Sends the buffered records of every open sink, each within 5 seconds, and leaves the sinks running. Call it
 * before `process.exit()`, which skips the scope finalizers and would drop the last batch.
 */
export const flushAll = Effect.suspend(() =>
  // Unbounded on purpose: each final flush has its own 5-second timeout, so running them together keeps the exit
  // wait at 5 seconds. The set holds one sink per observability layer build, which is one in the CLI.
  Effect.forEach(Arr.fromIterable(open), (sink) => sink.final, { concurrency: "unbounded", discard: true }),
)

export const logger = Effect.fn("Datadog.logger")(function* (settings: Settings, options: LoggerOptions = {}) {
  const cooldown = Duration.fromInputUnsafe(options.cooldown ?? COOLDOWN)
  const url = Option.getOrElse(settings.url, () => `https://http-intake.logs.${settings.site}/api/v2/logs`)
  const apiKey = Option.match(settings.apiKey, { onNone: () => "", onSome: Redacted.value })
  const include = categoryFilter(settings.categories)
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
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.map((response) => ({
          verdict: verdict(response.status),
          retryAfter: Option.fromNullishOr(response.headers["retry-after"]),
          detail: { status: response.status } as Detail,
        })),
        // A transport error or a timeout is retried like a 5xx. Its message, never the request, goes to the breaker warning.
        Effect.catch((error) =>
          Effect.succeed({
            verdict: "retry" as const,
            retryAfter: Option.none<string>(),
            detail: { error: error.message } as Detail,
          }),
        ),
      )
  // Each wait, from Retry-After or the backoff, uses one of the retries.
  const deliver = (
    body: Uint8Array,
    attempt = 0,
  ): Effect.Effect<{ verdict: "sent" | "dropped" | "failed"; detail: Detail }> =>
    Effect.flatMap(post(body), (result) => {
      if (result.verdict !== "retry") return Effect.succeed({ verdict: result.verdict, detail: result.detail })
      if (attempt >= RETRIES) return Effect.succeed({ verdict: "failed" as const, detail: result.detail })
      return retryDelay(result.retryAfter).pipe(
        Effect.map(Option.getOrElse(() => Duration.times(BACKOFF, 2 ** attempt))),
        Effect.flatMap(Effect.sleep),
        Effect.andThen(Effect.suspend(() => deliver(body, attempt + 1))),
      )
    })
  const send = (batch: Array<Entry>) =>
    deliver(gzipSync(encodeJson(batch))).pipe(
      // The export request must not create spans or logs, or the sink feeds itself.
      Effect.withTracerEnabled(false),
    )

  // `Logger.make` callbacks are synchronous, so the sink state lives in mutable cells, not Refs. Every read-and-write
  // below is one synchronous step, so no fiber can interleave inside it.
  const buffer = MutableList.make<Fitted>()
  // The other loggers of the fiber that logged last. The breaker record goes to them, never to this sink.
  const others = MutableRef.make<ReadonlySet<Logger.Logger<unknown, unknown>>>(yield* Logger.CurrentLoggers)
  const openUntil = MutableRef.make(0)
  const isOpen = Effect.map(Clock.currentTimeMillis, (now) => now < MutableRef.get(openUntil))

  // A sink warning goes to the other loggers only, so the sink does not feed itself.
  const warn = (message: string, fields: object) =>
    Effect.logWarning(message, fields).pipe(
      Effect.provide(Logger.layer(Array.from(MutableRef.get(others)).filter((logger) => logger !== sink))),
    )

  // Like OtlpExporter, the sink turns itself off for the cooldown instead of retrying every flush.
  const trip = Effect.fnUntraced(function* (detail: Detail) {
    MutableRef.set(openUntil, (yield* Clock.currentTimeMillis) + Duration.toMillis(cooldown))
    yield* warn("Datadog sink disabled for the cooldown", { cooldownSeconds: Duration.toSeconds(cooldown), ...detail })
  })

  // Takes the buffer and hands each chunk to `each`. An open breaker drops the records, including the chunks
  // after the one that tripped it. An interruption puts the unfinished records back at the front, so the final
  // flush that runs after the loop is interrupted still sends them. A chunk that was delivered just before the
  // interruption can be sent twice; that beats losing it.
  const drain = (each: (chunk: Array<Entry>) => Effect.Effect<void>) =>
    Effect.suspend(() => {
      const batch = MutableList.takeAll(buffer)
      // The records not yet handled. Each finished chunk takes its records off the front, so this loop must stay
      // sequential: `chunks` keeps the batch order, and concurrency would take the wrong records.
      const pending = MutableList.make<Fitted>()
      MutableList.appendAll(pending, batch)
      return Effect.forEach(
        chunks(batch),
        (chunk) =>
          Effect.flatMap(isOpen, (tripped) => (tripped ? Effect.void : each(chunk))).pipe(
            Effect.andThen(Effect.sync(() => MutableList.takeNVoid(pending, chunk.length))),
          ),
        { discard: true },
      ).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            MutableList.prependAll(buffer, MutableList.takeAll(pending))
            while (buffer.length > MAX_BUFFER) MutableList.take(buffer)
          }),
        ),
      )
    })

  // ponytail: no disk spool. The ceiling: an outage loses the batch after its retries, every record while the
  // breaker is open, and all but the newest 10,000 buffered entries; the file log keeps the local copy. The
  // upgrade path, when log loss becomes unacceptable: a bounded spool in Global.Path.log with retention rules and
  // a data-loss-prevention review, because it writes redacted records to disk a second time.
  const flush = drain((chunk) =>
    Effect.flatMap(send(chunk), (result) =>
      result.verdict === "failed"
        ? trip(result.detail)
        : result.verdict === "dropped"
          ? warn("Datadog intake rejected a batch", result.detail)
          : Effect.void,
    ),
  )

  // Shutdown must not hang the CLI, so the final flush makes one attempt per chunk and never waits for Retry-After.
  const final = drain((chunk) =>
    post(gzipSync(encodeJson(chunk))).pipe(Effect.asVoid, Effect.withTracerEnabled(false)),
  ).pipe(Effect.timeoutOption(FINAL_TIMEOUT), Effect.asVoid)

  const sink = Logger.make((options) => {
    if (!LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.level)) return
    MutableRef.set(others, options.fiber.getRef(Logger.CurrentLoggers))
    // Measured once here. A record that cannot be encoded as JSON is dropped, so the flush loop never meets one.
    const fitted = Option.flatMap(entry(options, settings, run, include), fitSafe)
    if (Option.isNone(fitted)) return
    MutableList.append(buffer, fitted.value)
    // The oldest records go first when the intake cannot keep up.
    if (buffer.length > MAX_BUFFER) MutableList.take(buffer)
  })

  const registered: OpenSink = { settings, logger: sink, final }
  // Added before the loop starts, so the loop is interrupted first and the final flush runs last.
  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      Effect.sync(() => MutableHashSet.remove(open, registered)),
      final,
    ),
  )
  MutableHashSet.add(open, registered)
  // The loop keeps the Clock of this fiber, so a test provides TestClock before the logger builds.
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(settings.flushInterval), flush)))
  return sink
})

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

function redact(input: unknown, content: Settings["content"], key = "", depth = 0): unknown {
  if (key && secretKey(key)) return "[REDACTED]"
  if (key && HashSet.has(CONTENT, key) && content !== "full") return content === "omit" ? omitted(input) : hash(input)
  if (typeof input === "string") return scrub(input)
  // JSON cannot hold a bigint.
  if (typeof input === "bigint") return input.toString()
  // A cyclic value would recurse without end, so the walk stops at a fixed depth.
  if (depth >= MAX_DEPTH) return "[DEPTH]"
  if (Array.isArray(input)) return input.map((value) => redact(value, content, "", depth + 1))
  if (input instanceof Date) return input.toISOString()
  // Provider errors carry the request body in enumerable fields, so an error keeps only its name, tag and message.
  // The message follows the content switch, because LLMError and JsonError messages embed response bodies and
  // whole config files.
  if (input instanceof Error)
    return {
      name: input.name,
      ...(Predicate.hasProperty(input, "_tag") ? { tag: String(input._tag) } : {}),
      message:
        content === "full" ? scrub(input.message) : content === "omit" ? omitted(input.message) : hash(input.message),
    }
  if (!Predicate.isObject(input)) return input
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [name, redact(value, content, name, depth + 1)]),
  )
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
  return `sha256:${createHash("sha256").update(text(input)).digest("hex").slice(0, 16)}`
}

function chunks(items: Array<Fitted>) {
  return items
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

/** Measures an entry in UTF-8 bytes. Above the 1 MB limit it cuts the message, then drops the attributes. */
function fit(item: Entry) {
  const bytes = Buffer.byteLength(encodeJson(item))
  if (bytes <= MAX_ENTRY_BYTES) return { item, bytes }
  const cut = cutMessage(item, bytes)
  if (cut.bytes <= MAX_ENTRY_BYTES) return cut
  // A large attribute (a full prompt under content "full", for example) keeps the entry above the limit, so the
  // entry keeps only the short fields that `entry` always sets, with its whole message, and says the rest was cut.
  const bare: Entry = {
    ...Object.fromEntries(BARE_FIELDS.filter((key) => key in item).map((key) => [key, item[key]])),
    truncated: true,
  }
  return cutMessage(bare, Buffer.byteLength(encodeJson(bare)))
}

/** Cuts the message by the bytes that the entry is above the limit. */
function cutMessage(item: Entry, bytes: number) {
  if (bytes <= MAX_ENTRY_BYTES || typeof item.message !== "string") return { item, bytes }
  const message = Buffer.from(item.message)
  // ponytail: the JSON escaping of the kept text is not counted, so a message full of quotes can stay slightly above the limit.
  const keep = Math.max(0, message.length - (bytes - MAX_ENTRY_BYTES) - Buffer.byteLength(TRUNCATED))
  // A cut inside a multi-byte character decodes to U+FFFD, so drop it.
  const cut: Entry = { ...item, message: message.subarray(0, keep).toString().replace(/�$/, "") + TRUNCATED }
  return { item: cut, bytes: Buffer.byteLength(encodeJson(cut)) }
}

// The short fields that stay when the attributes of an entry are too large to send.
const BARE_FIELDS = [
  "message",
  "status",
  "date",
  "service",
  "hostname",
  "ddsource",
  "ddtags",
  "category",
  "run",
  "trace_id",
  "span_id",
  "dd",
]

type Fitted = ReturnType<typeof fit>

// `fit` encodes the entry, which throws for a value that JSON cannot hold.
const fitSafe = Option.liftThrowable(fit)

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

import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Logger, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Datadog } from "../../src/observability/datadog"

const settings = (env: Record<string, string>) =>
  Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))), Effect.runPromise)

test("stays off without an API key or when disabled", async () => {
  expect(Option.isNone(await settings({}))).toBe(true)
  expect(Option.isNone(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS: "false" }))).toBe(true)
  expect(Option.isNone(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOG_LEVEL: "Loud" }))).toBe(true)
})

test("category filter honours prefixes and exclusions", () => {
  const include = Datadog.categoryFilter("llm,tool,-tool.read")
  expect(["llm.request", "tool.call", "tool"].every(include)).toBe(true)
  expect(["tool.read", "tool.read.result", "llmx", "session.idle"].some(include)).toBe(false)
})

test("ships filtered, redacted, trace-correlated batches to the intake", async () => {
  const requests: Array<{ key: string | null; body: Array<Record<string, any>> }> = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        key: request.headers.get("DD-API-KEY"),
        body: JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await request.arrayBuffer()))),
      })
      return new Response(null, { status: 202 })
    },
  })
  const config = Option.getOrThrow(
    await settings({
      DD_API_KEY: "test-key",
      DD_ENV: "test",
      DD_VERSION: "1.2.3",
      DD_TAGS: "team:platform",
      OPENCODE_DATADOG_LOGS_URL: server.url.href,
      OPENCODE_DATADOG_CATEGORIES: "llm,-llm.stream",
      OPENCODE_DATADOG_CONTENT: "hash",
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour",
    }),
  )

  await Effect.gen(function* () {
    const logger = yield* Datadog.logger(config)
    const log = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(Logger.layer([logger])))
    yield* log(
      Effect.logInfo("llm request", {
        model: "claude",
        prompt: "my secret plan",
        headers: { authorization: "Bearer x" },
      }).pipe(Effect.annotateLogs({ category: "llm.request", sessionID: "ses_1" }), Effect.withSpan("llm")),
    )
    yield* log(
      Effect.logError("stream error", {
        error: Object.assign(new Error("Bearer abc.def failed"), { requestBodyValues: "my secret plan" }),
      }).pipe(Effect.annotateLogs({ category: "llm.error" })),
    )
    yield* log(Effect.logInfo("chunk").pipe(Effect.annotateLogs({ category: "llm.stream" })))
    yield* log(Effect.logDebug("below level").pipe(Effect.annotateLogs({ category: "llm.request" })))
    yield* log(Effect.logWarning("other").pipe(Effect.annotateLogs({ category: "tool.call" })))
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)

  expect(requests).toHaveLength(1)
  expect(requests[0].key).toBe("test-key")
  const [entry, failure] = requests[0].body
  expect(requests[0].body).toHaveLength(2)
  expect(failure.error).toEqual({ name: "Error", message: "Bearer [REDACTED] failed" })
  expect(entry).toMatchObject({
    message: "llm request",
    status: "info",
    service: "opencode",
    ddsource: "opencode",
    category: "llm.request",
    sessionID: "ses_1",
    model: "claude",
    headers: { authorization: "[REDACTED]" },
  })
  expect(entry.ddtags).toBe("env:test,version:1.2.3,team:platform")
  expect(entry.run).toMatch(/^[0-9a-f]{8}$/)
  expect(entry.prompt).toMatch(/^sha256:[0-9a-f]{16}$/)
  expect(JSON.stringify(requests[0].body)).not.toContain("my secret plan")
  expect(entry.dd.trace_id).toBe(BigInt(`0x${entry.trace_id.slice(-16)}`).toString())
})

test("flushAll sends the buffer of an open sink before process.exit would drop it", async () => {
  const bodies: Array<Array<Record<string, any>>> = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(await request.arrayBuffer()))))
      return new Response(null, { status: 202 })
    },
  })
  const config = Option.getOrThrow(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: server.url.href,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour",
    }),
  )
  await Effect.gen(function* () {
    const logger = yield* Datadog.logger(config)
    yield* Effect.logInfo("before exit").pipe(Effect.provide(Logger.layer([logger])))
    yield* Datadog.flushAll
    expect(bodies.map((body) => body.map((entry) => entry.message))).toEqual([["before exit"]])
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)
  // The scope close finds an empty buffer and sends nothing more.
  expect(bodies).toHaveLength(1)
})

import { expect, test } from "bun:test"
import { ConfigProvider, Effect, Exit, Logger, Option, Tracer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ID, type Payload } from "@opencode-ai/schema/event"
import { domain, spanCategory } from "../../src/observability/category"
import { Datadog } from "../../src/observability/datadog"
import { Telemetry } from "../../src/observability/telemetry"

const settings = (env: Record<string, string>) =>
  Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))), Effect.runPromise)

test("span names map to the catalogue taxonomy", () => {
  expect(
    ["MCP.create", "SessionHttpApi.prompt", "AnthropicMessages.fromRequest", "ShellTool.execute"].map(spanCategory),
  ).toEqual([
    "mcp.MCP.create",
    "http.SessionHttpApi.prompt",
    "llm.AnthropicMessages.fromRequest",
    "tool.ShellTool.execute",
  ])
  expect(spanCategory("AnthropicMessages.onContentBlockDelta")).toBe("llm.chunk")
  expect(spanCategory("OpenAIChat.lowerMessage")).toBe("llm.chunk")
  expect(["Question.ask", "Pty.create", "CodexAuth.refresh", "Mystery.op"].map(domain)).toEqual([
    "question",
    "pty",
    "auth",
    "mystery",
  ])
})

test("spans and bus events reach the Datadog sink only, without event content", async () => {
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
  const other: Array<unknown> = []
  const file = Logger.make((options) => other.push(options.message))

  await Effect.gen(function* () {
    const logger = yield* Datadog.logger(config)
    const tracer = Telemetry.bridge(yield* Effect.tracer)
    yield* Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("MCP.create", { attributes: { server: "docs" } }))
      yield* Effect.fail("boom").pipe(Effect.withSpan("LLM.stream"), Effect.ignore)
      yield* Effect.void.pipe(Effect.withSpan("AnthropicMessages.onContentBlockDelta"))
      yield* Effect.logInfo("inside").pipe(Effect.withSpan("MCP.tools"))
      yield* Telemetry.event({
        id: ID.make("evt_1"),
        type: "session.next.step.ended",
        data: {
          sessionID: "ses_1",
          status: { type: "retry" },
          text: "my secret plan",
          tokens: { input: 3, output: 4, cache: { read: 1 } },
        },
      } satisfies Payload)
      yield* Telemetry.event({
        id: ID.make("evt_2"),
        type: "session.next.text.delta",
        data: { delta: "x" },
      } satisfies Payload)
    }).pipe(Effect.withTracer(tracer), Effect.provide(Logger.layer([logger, file])))
    yield* Datadog.flushAll
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)

  const entries = bodies.flat()
  const by = (category: string) => entries.find((entry) => entry.category === category)
  expect(by("mcp.MCP.create")).toMatchObject({ message: "MCP.create", status: "info", outcome: "ok", server: "docs" })
  expect(by("mcp.MCP.create")?.durationMs).toBeGreaterThanOrEqual(0)
  expect(by("llm.LLM.stream")).toMatchObject({ status: "warn", outcome: "failed" })
  // An existing log takes the category of its enclosing span.
  expect(entries.find((entry) => entry.message === "inside")?.category).toBe("mcp")
  expect(by("bus.session.next.step.ended")).toMatchObject({
    eventID: "evt_1",
    sessionID: "ses_1",
    eventStatus: "retry",
    status: "info",
    "tokens.input": 3,
    "tokens.output": 4,
    "tokens.cache.read": 1,
  })
  expect(JSON.stringify(entries)).not.toContain("my secret plan")
  // Per-chunk spans and deltas are off by default.
  expect(entries.some((entry) => entry.category === "llm.chunk" || entry.category.startsWith("bus.delta"))).toBe(false)
  // The other loggers see only the ordinary log, not the span and event records.
  expect(other).toEqual([["inside"]])
})

test("the span bridge never mutates the inner span, and a span ended outside a fiber records nothing", async () => {
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
  const created: Array<Tracer.Span> = []
  const ended: Array<string> = []

  const outside = await Effect.gen(function* () {
    const logger = yield* Datadog.logger(config)
    const base = yield* Effect.tracer
    const inner: Tracer.Tracer = {
      context: base.context,
      span(options) {
        const span = base.span(options)
        const end = span.end.bind(span)
        created.push(span)
        // Records each inner end, so the test sees that the bridge still calls it.
        return new Proxy(span, {
          get: (target, key) =>
            key === "end"
              ? (...args: Parameters<Tracer.Span["end"]>) => {
                  ended.push(target.name)
                  end(...args)
                }
              : Reflect.get(target, key, target),
        })
      },
    }
    const tracer = Telemetry.bridge(inner)
    yield* Effect.void.pipe(
      Effect.withSpan("MCP.create"),
      Effect.withTracer(tracer),
      Effect.provide(Logger.layer([logger])),
    )
    // Created through the bridge but ended after the program, outside any fiber.
    const detached = yield* Effect.makeSpan("MCP.detached").pipe(Effect.withTracer(tracer))
    yield* Datadog.flushAll
    return detached
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)

  // Outside any fiber: the inner end runs, nothing throws, and no record is sent.
  outside.end(1n, Exit.void)

  expect(created.every((span) => !Object.hasOwn(span, "end"))).toBe(true)
  expect(ended).toEqual(["MCP.create", "MCP.detached"])
  const messages = bodies.flat().map((entry) => entry.message)
  expect(messages).toContain("MCP.create")
  expect(messages).not.toContain("MCP.detached")
})

test("closing one sink leaves the other sinks open", async () => {
  const config = Option.getOrThrow(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour" }))
  await Effect.gen(function* () {
    yield* Datadog.logger(config)
    yield* Effect.scoped(Datadog.logger(config))
    expect(Datadog.accepts("spans")).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)
  expect(Datadog.accepts("spans")).toBe(false)
})

test("the span and event switches turn the records off", async () => {
  const config = Option.getOrThrow(
    await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_SPANS: "false", OPENCODE_DATADOG_EVENTS: "false" }),
  )
  expect([config.spans, config.events]).toEqual([false, false])
  await Effect.gen(function* () {
    yield* Datadog.logger(config)
    expect([Datadog.accepts("spans"), Datadog.accepts("events")]).toEqual([false, false])
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)
})

test("a fetch wrapper records method, host, status and duration but not the path", async () => {
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
    yield* Datadog.logger(config)
    // A Promise edge runs the wrapper with a fresh runtime, as the AI SDK fetch does.
    yield* Effect.promise(() =>
      Effect.runPromise(
        Effect.succeed(new Response(null, { status: 429 })).pipe(
          Telemetry.request("llm.request", "https://api.example.com/v1/chat?key=secret", { method: "POST" }),
        ),
      ),
    )
    yield* Datadog.flushAll
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)
  const entry = bodies.flat().find((item) => item.category === "llm.request")
  expect(entry).toMatchObject({
    method: "POST",
    host: "api.example.com",
    httpStatus: 429,
    status: "warn",
    outcome: "ok",
  })
  expect(entry?.durationMs).toBeGreaterThanOrEqual(0)
  expect(JSON.stringify(bodies)).not.toContain("secret")
})

import { Cause, Effect, Exit, Fiber, LogLevel, Predicate, Tracer } from "effect"
import { HttpServerRequest, type HttpMiddleware } from "effect/unstable/http"
import type { Payload } from "@opencode-ai/schema/event"
import { eventCategory, spanCategory } from "./category"
import { Datadog } from "./datadog"

/**
 * Wraps a tracer so every ended span also sends one record to the Datadog sinks: the span name, duration, outcome
 * and attributes. Spans otherwise reach only an OTLP collector, so this is how the ~850 `Effect.fn` sites reach
 * Datadog. The record goes to no other logger, so the file log does not grow.
 */
export function bridge(inner: Tracer.Tracer): Tracer.Tracer {
  return {
    context: inner.context,
    span(options) {
      const span = inner.span(options)
      const end: Tracer.Span["end"] = (endTime, exit) => {
        span.end(endTime, exit)
        recordSpan(span, endTime, exit)
      }
      // A delegating view, so the inner tracer's span is never mutated and may be frozen. Every other member reads
      // from the inner span with the inner span as `this`, so its own getters and methods behave unchanged.
      return new Proxy(span, {
        get: (target, key) => (key === "end" ? end : Reflect.get(target, key, target)),
      })
    },
  }
}

function recordSpan(span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
  const fiber = Fiber.getCurrent()
  if (fiber === undefined || !Datadog.accepts("spans")) return
  const failed = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
  const outcome = Exit.isSuccess(exit) ? "ok" : failed ? "failed" : "interrupted"
  Datadog.emit(fiber, "spans", failed ? "Warn" : "Info", [
    span.name,
    {
      ...Object.fromEntries(span.attributes),
      category: spanCategory(span.name),
      span: span.name,
      outcome,
      durationMs: Number(endTime - span.status.startTime) / 1e6,
      ...(failed ? { error: Cause.squash(exit.cause) } : {}),
    },
  ])
}

// Short scalar fields that describe an event without its content. Any key that ends in `ID` is kept too.
const EVENT_FIELDS = [
  "tokens",
  "tool",
  "agent",
  "status",
  "reason",
  "finish",
  "mode",
  "server",
  "permission",
  "name",
  "cost",
]

/**
 * Sends one record for a bus event to the Datadog sinks: its type, ID, durable position and the identifier fields
 * of its data. The rest of the data stays out, because it can hold prompts, answers and file content.
 */
export const event = (payload: Payload) =>
  Effect.withFiber((fiber) => {
    if (!Datadog.accepts("events")) return Effect.void
    Datadog.emit(fiber, "events", "Info", [
      payload.type,
      {
        ...fields(payload.data),
        category: eventCategory(payload.type),
        eventType: payload.type,
        eventID: payload.id,
        ...(payload.durable ? { aggregateID: payload.durable.aggregateID, seq: payload.durable.seq } : {}),
      },
    ])
    return Effect.void
  })

// The sink writes its own `status` (the log level) and `message`, so these event keys are renamed.
const RENAMED: Readonly<Record<string, string>> = { status: "eventStatus", name: "eventName" }

function fields(data: unknown): Record<string, unknown> {
  if (!Predicate.isObject(data)) return {}
  return Object.fromEntries(
    Object.entries(data).flatMap(([name, value]): Array<[string, unknown]> => {
      const key = RENAMED[name] ?? name
      if (!(name.endsWith("ID") || EVENT_FIELDS.includes(name))) return []
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [[key, value]]
      // Token counts are numbers only, so a step record carries its usage. The keys are flattened to
      // `tokens.input` and so on, because the sink treats a bare `input` or `output` key as content.
      if (name === "tokens" && Predicate.isObject(value)) return numbers(value, key)
      // A status such as `{ type: "retry", attempt: 2 }` keeps its type.
      if (Predicate.isObject(value) && "type" in value && typeof value.type === "string") return [[key, value.type]]
      return []
    }),
  )
}

function numbers(input: object, prefix: string): Array<[string, unknown]> {
  return Object.entries(input).flatMap(([key, value]): Array<[string, unknown]> => {
    if (typeof value === "number") return [[`${prefix}.${key}`, value]]
    return Predicate.isObject(value) ? numbers(value, `${prefix}.${key}`) : []
  })
}

/**
 * Sends one Datadog record from any fiber, including one started by `Effect.runPromise` at a Promise edge, which
 * has none of the application loggers.
 */
export const record = (level: LogLevel.LogLevel, message: string, fields: Record<string, unknown>) =>
  Effect.withFiber((fiber) => {
    Datadog.emit(fiber, "records", level, [message, fields])
    return Effect.void
  })

/**
 * Records one HTTP request made through a fetch wrapper: method, host, status, duration and outcome. The URL path,
 * headers and body stay out, because they can carry keys and prompts.
 */
export const request =
  (category: string, input: unknown, init: { readonly method?: string } | undefined) =>
  <E, R>(self: Effect.Effect<Response, E, R>) =>
    Effect.suspend(() => {
      const started = Date.now()
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const url = input instanceof Request ? input.url : String(input)
      return self.pipe(
        Effect.onExit((exit) =>
          record(Exit.isSuccess(exit) && exit.value.status < 400 ? "Info" : "Warn", "HTTP request", {
            category,
            method,
            host: URL.parse(url)?.host ?? "unknown",
            durationMs: Date.now() - started,
            ...(Exit.isSuccess(exit)
              ? { httpStatus: exit.value.status, outcome: "ok" }
              : {
                  outcome: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed",
                  error: Cause.squash(exit.cause),
                }),
          }),
        ),
      )
    })

/**
 * An HTTP server middleware that records every request: method, path, status, duration and outcome
 * (`http.request`). The query string stays out, because a PTY ticket and a URL credential travel there. The
 * router's own logger stays off, because it would write the full URL to every log.
 */
export const accessLog: HttpMiddleware.HttpMiddleware = (app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const started = Date.now()
    const fields = { category: "http.request", method: request.method, path: request.url.split("?")[0] }
    return yield* app.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? record(exit.value.status >= 400 ? "Warn" : "Info", "HTTP request", {
              ...fields,
              httpStatus: exit.value.status,
              durationMs: Date.now() - started,
              outcome: "ok",
            })
          : record("Warn", "HTTP request", {
              ...fields,
              durationMs: Date.now() - started,
              outcome: Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed",
              error: Cause.squash(exit.cause),
            }),
      ),
    )
  })

export * as Telemetry from "./telemetry"

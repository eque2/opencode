import { Cause, Effect, Exit, Fiber, Predicate, Tracer } from "effect"
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
      const end = span.end.bind(span)
      span.end = (endTime, exit) => {
        end(endTime, exit)
        record(span, endTime, exit)
      }
      return span
    },
  }
}

function record(span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
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

function fields(data: unknown): Record<string, unknown> {
  if (!Predicate.isObject(data)) return {}
  return Object.fromEntries(
    Object.entries(data).flatMap(([key, value]): Array<[string, unknown]> => {
      if (!(key.endsWith("ID") || EVENT_FIELDS.includes(key))) return []
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [[key, value]]
      // Token counts are numbers only, so a step record carries its usage. The keys are flattened to
      // `tokens.input` and so on, because the sink treats a bare `input` or `output` key as content.
      if (key === "tokens" && Predicate.isObject(value)) return numbers(value, key)
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

export * as Telemetry from "./telemetry"

import { Effect, Layer, Option } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

const headers = Option.fromUndefinedOr(Flag.OTEL_EXPORTER_OTLP_HEADERS).pipe(
  Option.filter((value) => value.length > 0),
  Option.map((value) =>
    value.split(",").reduce(
      (acc, entry) => {
        const [key, ...value] = entry.split("=")
        acc[key] = value.join("=")
        return acc
      },
      {} as Record<string, string>,
    ),
  ),
)

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers() {
  if (!endpoint) return []
  return [
    OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource: resource(), headers: Option.getOrUndefined(headers) }),
  ]
}

const tracing = Effect.gen(function* () {
  if (!endpoint) return Layer.empty
  const NodeSdk = yield* Effect.promise(() => import("@effect/opentelemetry/NodeSdk"))
  const OTLP = yield* Effect.promise(() => import("@opentelemetry/exporter-trace-otlp-http"))
  const SdkBase = yield* Effect.promise(() => import("@opentelemetry/sdk-trace-base"))
  const { AsyncLocalStorageContextManager } = yield* Effect.promise(() => import("@opentelemetry/context-async-hooks"))
  const { context } = yield* Effect.promise(() => import("@opentelemetry/api"))

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
        headers: Option.getOrUndefined(headers),
      }),
    ),
  }))
})

/** observability.ts awaits this through Effect.promise, so it keeps its Promise-returning signature. */
export function tracingLayer() {
  return Effect.runPromise(tracing)
}

export * as Otlp from "./otlp"

import { Config, ConfigProvider, Effect, Layer, Option } from "effect"
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

// decodeURIComponent throws a URIError for a malformed escape.
const decodeComponent = Option.liftThrowable(decodeURIComponent)

/** Parses `key=value` pairs. One entry without a key or with a malformed escape drops every attribute. */
function parseResourceAttributes(value: string): Record<string, string> {
  return Option.all(
    value.split(",").map((entry): Option.Option<readonly [string, string]> => {
      const index = entry.indexOf("=")
      if (index < 1) return Option.none()
      return Option.all([decodeComponent(entry.slice(0, index)), decodeComponent(entry.slice(index + 1))])
    }),
  ).pipe(
    Option.map((entries) => Object.fromEntries(entries)),
    Option.getOrElse(() => ({})),
  )
}

const ResourceAttributes = Config.String("OTEL_RESOURCE_ATTRIBUTES").pipe(
  Config.withDefault(""),
  Config.map(parseResourceAttributes),
)

export interface Resource {
  readonly serviceName: string
  readonly serviceVersion: string
  readonly attributes: Record<string, string>
}

/** The OTEL resource. The ambient ConfigProvider copies process.env once, so each run reads a fresh env provider. */
export const resource: Effect.Effect<Resource> = Effect.suspend(() =>
  ResourceAttributes.parse(ConfigProvider.fromEnv()),
).pipe(
  Effect.orDie,
  Effect.map((attributes) => ({
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...attributes,
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.OPENCODE_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  })),
)

export function loggers() {
  if (!endpoint) return []
  return [
    Effect.flatMap(resource, (resource) =>
      OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource, headers: Option.getOrUndefined(headers) }),
    ),
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

  return NodeSdk.layer(
    Effect.map(resource, (resource) => ({
      resource,
      spanProcessor: new SdkBase.BatchSpanProcessor(
        new OTLP.OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          headers: Option.getOrUndefined(headers),
        }),
      ),
    })),
  )
})

/** observability.ts awaits this through Effect.promise, so it keeps its Promise-returning signature. */
export function tracingLayer() {
  return Effect.runPromise(tracing)
}

export * as Otlp from "./otlp"

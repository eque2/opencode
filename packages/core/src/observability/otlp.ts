import { Config, ConfigProvider, Effect, Layer, Option } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { FlagConfig } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

function parseHeaders(value: string): Record<string, string> {
  return value.split(",").reduce(
    (acc, entry) => {
      const [key, ...value] = entry.split("=")
      acc[key] = value.join("=")
      return acc
    },
    {} as Record<string, string>,
  )
}

interface Exporter {
  readonly endpoint: string
  readonly headers: Record<string, string> | undefined
}

/**
 * The OTLP endpoint and headers, or none when no endpoint is set. An empty variable counts as not set.
 * Both variables are optional, so a ConfigError is a defect.
 */
const exporter: Effect.Effect<Option.Option<Exporter>> = Effect.gen(function* () {
  const endpoint = yield* FlagConfig.OTEL_EXPORTER_OTLP_ENDPOINT
  const headers = (yield* FlagConfig.OTEL_EXPORTER_OTLP_HEADERS).pipe(
    Option.filter((value) => value.length > 0),
    Option.map(parseHeaders),
  )
  return Option.map(endpoint, (endpoint) => ({ endpoint, headers: Option.getOrUndefined(headers) }))
}).pipe(Effect.orDie)

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
export const resource: Effect.Effect<Resource> = Effect.all([
  Effect.suspend(() => ResourceAttributes.parse(ConfigProvider.fromEnv())).pipe(Effect.orDie),
  FlagConfig.OPENCODE_CLIENT.pipe(Effect.orDie),
  runID,
]).pipe(
  Effect.map(([attributes, client, id]) => ({
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...attributes,
      "deployment.environment.name": InstallationChannel,
      "opencode.client": client,
      "opencode.run": id,
      "service.instance.id": id,
    },
  })),
)

/** The OTLP logger when an endpoint is set, else no logger. */
export const loggers = Effect.map(exporter, (settings) =>
  Option.match(settings, {
    onNone: () => [],
    onSome: ({ endpoint, headers }) => [
      Effect.flatMap(resource, (resource) => OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource, headers })),
    ],
  }),
)

/** The OTLP tracing layer when an endpoint is set, else an empty layer. */
export const tracing = Effect.gen(function* () {
  const settings = yield* exporter
  if (Option.isNone(settings)) return Layer.empty
  const { endpoint, headers } = settings.value
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
          headers,
        }),
      ),
    })),
  )
})

export * as Otlp from "./otlp"

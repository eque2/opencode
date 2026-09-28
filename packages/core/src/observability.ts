export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Effect, Layer, Logger, LogLevel, Option, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpExporter, OtlpSerialization } from "effect/unstable/observability"
import { Datadog } from "./observability/datadog"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    // OPENCODE_LOG_LEVEL sets the file, stderr and OTLP level. Datadog has its own level.
    const level = yield* Logging.minimumLogLevel
    const otlpLoggers = (yield* Otlp.loggers).map((make) => Effect.map(make, (logger) => Logging.atLevel(logger, level)))
    const datadog = yield* Datadog.settings
    const loggers = [
      ...Logging.loggers(level),
      ...otlpLoggers,
      ...Option.toArray(Option.map(datadog, (settings) => Datadog.logger(settings))),
    ]
    const logs = Logger.layer(loggers, { mergeWithExisting: false }).pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.orDie,
      Layer.merge(Layer.succeed(References.MinimumLogLevel, minimumLevel(level, datadog))),
    )
    return Layer.merge(logs, yield* Otlp.tracing)
  }),
)

/**
 * The global minimum: the lowest level that an active sink needs, so no sink loses records. With Datadog off, or
 * with a Datadog level at or above the file level (`None` included), it is the file level.
 */
export function minimumLevel(file: LogLevel.LogLevel, datadog: Option.Option<Datadog.Settings>) {
  return Option.match(datadog, {
    onNone: () => file,
    onSome: (settings) => (LogLevel.isLessThan(settings.level, file) ? settings.level : file),
  })
}

export const node = LayerNode.make({ name: "observability", layer, deps: [] })

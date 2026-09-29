export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Config, ConfigProvider, Effect, Layer, Logger, LogLevel, Option, References, Tracer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpExporter, OtlpSerialization } from "effect/unstable/observability"
import { Global } from "./global"
import { Datadog } from "./observability/datadog"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"
import { Telemetry } from "./observability/telemetry"

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    // OPENCODE_LOG_LEVEL sets the file, stderr and OTLP level. Datadog has its own level.
    const level = yield* Logging.minimumLogLevel
    const otlpLoggers = (yield* Otlp.loggers).map((make) =>
      Effect.map(make, (logger) => Logging.atLevel(logger, level)),
    )
    const datadog = yield* datadogSettings
    const loggers = [
      ...Logging.loggers(level),
      ...otlpLoggers,
      ...Option.toArray(Option.map(datadog.settings, (settings) => Datadog.logger(settings))),
    ]
    const logs = Logger.layer(loggers, { mergeWithExisting: false }).pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.orDie,
      Layer.merge(Layer.succeed(References.MinimumLogLevel, minimumLevel(level, datadog.settings))),
    )
    // The Datadog settings warnings wait until the loggers are installed, so they never reach the default console logger.
    const replay = Layer.effectDiscard(
      Effect.forEach(datadog.warnings, (message) => Effect.logWarning(...message), { discard: true }),
    ).pipe(Layer.provide(logs))
    const tracing = yield* Otlp.tracing
    // The span bridge wraps whichever tracer is active, OTLP or the default, so spans reach Datadog without OTLP.
    const bridge = Option.exists(datadog.settings, (settings) => settings.spans)
      ? Layer.unwrap(
          Effect.map(Effect.tracer, (tracer) => Layer.succeed(Tracer.Tracer, Telemetry.bridge(tracer))),
        ).pipe(Layer.provide(tracing))
      : tracing
    return Layer.mergeAll(logs, replay, bridge)
  }),
)

// The CLI and tests set OPENCODE_CONFIG_DIR after startup, so read it from a fresh env provider, as Global does.
const configDir = Config.option(Config.String("OPENCODE_CONFIG_DIR"))

/** The Datadog settings from the live process env and the global config files, and the warnings they logged. */
const datadogSettings = Effect.gen(function* () {
  const dir = yield* configDir.parse(ConfigProvider.fromEnv()).pipe(Effect.orDie)
  let warnings: ReadonlyArray<ReadonlyArray<unknown>> = []
  const hold = Logger.make((options) => {
    warnings = [...warnings, Array.isArray(options.message) ? options.message : [options.message]]
  })
  const settings = yield* Datadog.provider({
    env: process.env,
    configDir: Option.getOrElse(dir, () => Global.Path.config),
  }).pipe(
    Effect.flatMap((provider) => Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider)))),
    Effect.provide(Logger.layer([hold])),
  )
  return { settings, warnings }
})

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

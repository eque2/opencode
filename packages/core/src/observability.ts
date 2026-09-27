export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpExporter, OtlpSerialization } from "effect/unstable/observability"
import { Datadog } from "./observability/datadog"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const datadog = yield* Datadog.settings
    const loggers = [...Logging.loggers(), ...Otlp.loggers(), ...(datadog ? [Datadog.logger(datadog)] : [])]
    const logs = Logger.layer(loggers, { mergeWithExisting: false }).pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(OtlpExporter.layerFlusher),
      Layer.orDie,
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    return Layer.merge(logs, yield* Effect.promise(Otlp.tracingLayer))
  }),
)

export const node = LayerNode.make({ name: "observability", layer, deps: [] })

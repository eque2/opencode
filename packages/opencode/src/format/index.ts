import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Array as Arr, Effect, Layer, Context, MutableHashMap, Option, Schema } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { mergeDeep } from "remeda"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { errorMessage } from "@/util/error"
import * as Formatter from "./formatter"

export const Status = Schema.Struct({
  name: Schema.String,
  extensions: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
}).annotate({ identifier: "FormatterStatus" })
export type Status = Schema.Schema.Type<typeof Status>

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly file: (filepath: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Format") {}

export const use = serviceUse(Service)

// Every value export of ./formatter is a built-in Info, so config entries look them up by export name.
const builtIns: Partial<Record<string, Formatter.Info>> = Formatter

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const appProcess = yield* AppProcess.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make(
      Effect.fn("Format.state")(function* (ctx) {
        // Only an available formatter is cached; an unavailable one is checked again on the next call.
        const commands = MutableHashMap.empty<string, string[]>()
        const formatters: Record<string, Formatter.Info> = {}

        const getCommand = Effect.fnUntraced(function* (item: Formatter.Info) {
          const cached = MutableHashMap.get(commands, item.name)
          if (Option.isSome(cached)) return cached
          const cmd = yield* item.enabled({ ...ctx, experimentalOxfmt: flags.experimentalOxfmt })
          if (Option.isSome(cmd)) MutableHashMap.set(commands, item.name, cmd.value)
          return cmd
        })

        const isEnabled = (item: Formatter.Info) => getCommand(item).pipe(Effect.map(Option.isSome))

        const getFormatter = Effect.fnUntraced(function* (ext: string) {
          const matching = Object.values(formatters).filter((item) => item.extensions.includes(ext))
          const checks = yield* Effect.forEach(
            matching,
            (item) => getCommand(item).pipe(Effect.map(Option.map((cmd) => ({ item, cmd })))),
            { concurrency: "unbounded" },
          )
          return Arr.getSomes(checks)
        })

        function formatFile(filepath: string) {
          return Effect.gen(function* () {
            yield* Effect.logInfo("formatting", { file: filepath })
            const formatters = yield* getFormatter(path.extname(filepath))

            if (!formatters.length) return false

            for (const { item, cmd } of formatters) {
              yield* Effect.logInfo("running", { command: cmd })
              const replaced = cmd.map((x) => x.replace("$FILE", filepath))
              const dir = yield* InstanceState.directory
              yield* appProcess
                .run(
                  ChildProcess.make(replaced[0], replaced.slice(1), {
                    cwd: dir,
                    env: item.environment,
                    extendEnv: true,
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore",
                  }),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    result.exitCode === 0
                      ? Effect.void
                      : Effect.logError("failed", {
                          command: cmd,
                          ...item.environment,
                        }),
                  ),
                  Effect.catch((error) =>
                    Effect.logError("failed to format file", {
                      error: "spawn failed",
                      command: cmd,
                      ...item.environment,
                      file: filepath,
                      cause: errorMessage(error.cause ?? error),
                    }),
                  ),
                )
            }

            return true
          })
        }

        const cfg = yield* config.get()

        if (!cfg.formatter) {
          yield* Effect.logInfo("all formatters are disabled")
          yield* Effect.logInfo("init")
          return {
            formatters,
            isEnabled,
            formatFile,
          }
        }

        for (const item of Object.values(Formatter)) {
          formatters[item.name] = item
        }

        if (cfg.formatter !== true) {
          for (const [name, item] of Object.entries(cfg.formatter)) {
            const builtIn = builtIns[name]

            // Ruff and uv are both the same formatter, so disabling either should disable both.
            if (["ruff", "uv"].includes(name) && (cfg.formatter.ruff?.disabled || cfg.formatter.uv?.disabled)) {
              // TODO combine formatters so shared backends like Ruff/uv don't need linked disable handling here.
              delete formatters.ruff
              delete formatters.uv
              continue
            }
            if (item.disabled) {
              delete formatters[name]
              continue
            }
            const info = mergeDeep(builtIn ?? { extensions: [] }, item)

            formatters[name] = {
              ...info,
              name,
              extensions: info.extensions ?? [],
              enabled:
                builtIn && !info.command ? builtIn.enabled : () => Effect.succeed(Option.fromNullishOr(info.command)),
            }
          }
        }

        yield* Effect.logInfo("init")

        return {
          formatters,
          isEnabled,
          formatFile,
        }
      }),
    )

    const init = Effect.fn("Format.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("Format.status")(function* () {
      const { formatters, isEnabled } = yield* InstanceState.get(state)
      return yield* Effect.forEach(Object.values(formatters), (formatter) =>
        isEnabled(formatter).pipe(
          Effect.map(
            (enabled): Status => ({
              name: formatter.name,
              extensions: formatter.extensions,
              enabled,
            }),
          ),
        ),
      )
    })

    const file = Effect.fn("Format.file")(function* (filepath: string) {
      const { formatFile } = yield* InstanceState.get(state)
      return yield* formatFile(filepath)
    })

    return Service.of({ init, status, file })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, AppProcess.node, RuntimeFlags.node],
})

export * as Format from "."

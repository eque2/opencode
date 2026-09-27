// Boot-time resolution for direct interactive mode.
//
// These functions run concurrently at startup to gather everything the runtime
// needs before the first frame: TUI keymap config, diff display style,
// model variant list with context limits, and session history for the prompt
// history ring. All are async because they read config or hit the SDK, but
// none block each other.
import { Context, Duration, Effect, Layer, Option } from "effect"
import { resolve } from "@opencode-ai/tui/config"
import { TuiConfig } from "@/config/tui"
import { makeRuntime } from "@/effect/run-service"
import { resolveSession, sessionHistory } from "./session.shared"
import type { RunDiffStyle, RunInput, RunPrompt, RunProvider, RunTuiConfig } from "./types"
import { pickVariant } from "./variant.shared"

export type ModelInfo = {
  providers: RunProvider[]
  variants: string[]
  limits: Record<string, number>
}

export type SessionInfo = {
  first: boolean
  history: RunPrompt[]
  variant?: string
}

type Config = Awaited<ReturnType<typeof TuiConfig.get>>
type BootService = {
  readonly resolveModelInfo: (
    sdk: RunInput["sdk"],
    directory: string,
    model: RunInput["model"],
  ) => Effect.Effect<ModelInfo>
  readonly resolveSessionInfo: (
    sdk: RunInput["sdk"],
    sessionID: string,
    model: RunInput["model"],
  ) => Effect.Effect<SessionInfo>
  readonly resolveRunTuiConfig: () => Effect.Effect<RunTuiConfig>
  readonly resolveDiffStyle: () => Effect.Effect<RunDiffStyle>
}

class Service extends Context.Service<Service, BootService>()("@opencode/RunBoot") {}

function emptyModelInfo(): ModelInfo {
  return {
    providers: [],
    variants: [],
    limits: {},
  }
}

function emptySessionInfo(): SessionInfo {
  return {
    first: true,
    history: [],
  }
}

function defaultRunTuiConfig(): RunTuiConfig {
  return {
    ...resolve({}, { terminalSuspend: process.platform !== "win32" }),
    diff_style: "auto",
  }
}

function runTuiConfig(config: Option.Option<Config>): RunTuiConfig {
  return Option.match(config, {
    onNone: defaultRunTuiConfig,
    onSome: (value) => ({
      keybinds: value.keybinds,
      leader_timeout: value.leader_timeout,
      diff_style: value.diff_style ?? "auto",
    }),
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Concurrent callers share one in-flight read. The zero TTL makes the next
    // call after it settles read the config again.
    const config = yield* Effect.cachedWithTTL(
      Effect.tryPromise(() => TuiConfig.get()).pipe(Effect.option),
      Duration.zero,
    )

    const resolveModelInfo = Effect.fn("RunBoot.resolveModelInfo")(function* (
      sdk: RunInput["sdk"],
      directory: string,
      model: RunInput["model"],
    ) {
      const connected = yield* Effect.tryPromise(() => sdk.config.providers({ directory })).pipe(
        Effect.map((item) => Option.fromNullishOr(item.data?.providers)),
        Effect.orElseSucceed(() => Option.none()),
      )
      const providers: RunProvider[] = Option.isSome(connected)
        ? connected.value
        : yield* Effect.tryPromise(() => sdk.provider.list()).pipe(
            Effect.map((item) => item.data?.all ?? []),
            Effect.orElseSucceed(() => []),
          )
      const limits = Object.fromEntries(
        providers.flatMap((provider) =>
          Object.entries(provider.models ?? {}).flatMap(([modelID, info]) => {
            const limit = info?.limit?.context
            if (typeof limit !== "number" || limit <= 0) {
              return []
            }

            return [[`${provider.id}/${modelID}`, limit] as const]
          }),
        ),
      )

      if (!model) {
        return {
          providers,
          variants: [],
          limits,
        }
      }

      const info = providers.find((item) => item.id === model.providerID)?.models?.[model.modelID]
      return {
        providers,
        variants: Object.keys(info?.variants ?? {}),
        limits,
      }
    })

    const resolveSessionInfo = Effect.fn("RunBoot.resolveSessionInfo")(function* (
      sdk: RunInput["sdk"],
      sessionID: string,
      model: RunInput["model"],
    ) {
      const session = yield* Effect.tryPromise(() => resolveSession(sdk, sessionID)).pipe(Effect.option)
      return Option.match(session, {
        onNone: emptySessionInfo,
        onSome: (value): SessionInfo => ({
          first: value.first,
          history: sessionHistory(value),
          variant: pickVariant(model, value),
        }),
      })
    })

    const resolveRunTuiConfig = Effect.fn("RunBoot.resolveRunTuiConfig")(function* () {
      return runTuiConfig(yield* config)
    })

    const resolveDiffStyle = Effect.fn("RunBoot.resolveDiffStyle")(function* () {
      return runTuiConfig(yield* config).diff_style ?? "auto"
    })

    return Service.of({
      resolveModelInfo,
      resolveSessionInfo,
      resolveRunTuiConfig,
      resolveDiffStyle,
    })
  }),
)

const runtime = makeRuntime(Service, layer)

// Fetches available variants and context limits for every provider/model pair.
export function resolveModelInfo(
  sdk: RunInput["sdk"],
  directory: string,
  model: RunInput["model"],
): Promise<ModelInfo> {
  return runtime.runPromise((svc) =>
    svc.resolveModelInfo(sdk, directory, model).pipe(Effect.catchCause(() => Effect.succeed(emptyModelInfo()))),
  )
}

// Fetches session messages to determine if this is the first turn and build prompt history.
export function resolveSessionInfo(
  sdk: RunInput["sdk"],
  sessionID: string,
  model: RunInput["model"],
): Promise<SessionInfo> {
  return runtime.runPromise((svc) =>
    svc.resolveSessionInfo(sdk, sessionID, model).pipe(Effect.catchCause(() => Effect.succeed(emptySessionInfo()))),
  )
}

// Reads TUI config once for direct mode keymap setup and display preferences.
export function resolveRunTuiConfig(): Promise<RunTuiConfig> {
  return runtime.runPromise((svc) =>
    svc.resolveRunTuiConfig().pipe(Effect.catchCause(() => Effect.succeed(defaultRunTuiConfig()))),
  )
}

export function resolveDiffStyle(): Promise<RunDiffStyle> {
  return runtime.runPromise((svc) =>
    svc.resolveDiffStyle().pipe(Effect.catchCause(() => Effect.succeed<RunDiffStyle>("auto"))),
  )
}

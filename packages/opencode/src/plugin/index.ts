import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Telemetry } from "@opencode-ai/core/observability/telemetry"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  WorkspaceAdapter as PluginWorkspaceAdapter,
  WorkspaceInfo as PluginWorkspaceInfo,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { CodexAuthPlugin } from "./openai/codex"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { CopilotAuthPlugin } from "./github-copilot/copilot"
import { ModalPlugin } from "./modal/modal"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "opencode-gitlab-auth"
import { PoeAuthPlugin } from "opencode-poe-auth"
import { CloudflareAIGatewayAuthPlugin, CloudflareWorkersAuthPlugin } from "./cloudflare"
import { AzureAuthPlugin } from "./azure"
import { DigitalOceanAuthPlugin } from "./digitalocean"
import { XaiAuthPlugin } from "./xai"
import { CerebrasPlugin } from "./cerebras"
import { SnowflakeCortexAuthPlugin } from "./snowflake-cortex"
import { Array as Arr, Effect, Layer, Context, Option, Predicate, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { PluginExportError, parsePluginSpecifier, pluginId, pluginIdOf, v1Plugin } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter, WorkspaceInfo } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstallationChannel } from "@opencode-ai/core/installation/version"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

// Trigger callers pass a partial input, so a hook runs with an unchecked input. A method signature
// has bivariant parameters, so every trigger hook type assigns to this one without a cast.
type UncheckedTriggerHook = { run(input: unknown, output: unknown): unknown }["run"]

type PluginEvent = Parameters<NonNullable<Hooks["event"]>>[0]["event"]

// A plugin module threw, rejected, or returned an invalid value while it loaded or ran a hook.
class PluginHookError extends Schema.TaggedError<PluginHookError>()("PluginHookError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  // Callers may pass a partial input, so the input is not checked against the hook type.
  readonly trigger: <Name extends TriggerName, Output = Parameters<Required<Hooks>[Name]>[1]>(
    name: Name,
    input: unknown,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

export function experimentalWebSocketsEnabled(input: { enabled: boolean; channel?: string }) {
  return input.enabled || ["local", "dev", "beta"].includes(input.channel ?? InstallationChannel)
}

// Built-in plugins that are directly imported (not installed from npm)
function internalPlugins(flags: RuntimeFlags.Info): PluginInstance[] {
  return [
    // Temporary rollout: pre-release builds use WebSockets by default; releases require explicit opt-in.
    (input) =>
      CodexAuthPlugin(input, {
        experimentalWebSockets: experimentalWebSocketsEnabled({ enabled: flags.experimentalWebSockets }),
      }),
    CopilotAuthPlugin,
    ModalPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    AzureAuthPlugin,
    DigitalOceanAuthPlugin,
    SnowflakeCortexAuthPlugin,
    XaiAuthPlugin,
    CerebrasPlugin,
  ]
}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown): Option.Option<PluginInstance> {
  if (isServerPlugin(value)) return Option.some(value)
  if (!value || typeof value !== "object" || !("server" in value)) return Option.none()
  if (!isServerPlugin(value.server)) return Option.none()
  return Option.some(value.server)
}

// A module can export the same plugin under several names, so each export runs once.
function getLegacyPlugins(mod: Record<string, unknown>) {
  return Effect.forEach(
    Arr.dedupeWith(Object.values(mod), (left, right) => left === right),
    (entry) =>
      Option.match(getServerPlugin(entry), {
        onNone: () => Effect.fail(new PluginExportError({ message: "Plugin export is not a function" })),
        onSome: Effect.succeed,
      }),
  )
}

// Runs plugin code the way `await` did: a sync throw or a rejection is a defect that keeps the
// original error, and a plain value counts as the result.
function awaited<A>(run: () => A | PromiseLike<A>): Effect.Effect<A> {
  return Effect.suspend(() => {
    const result = run()
    return Predicate.isPromiseLike(result) ? Effect.promise(() => result) : Effect.succeed(result)
  })
}

// Plugin code is untyped at runtime: a hook can return a plain value instead of a Promise, or throw
// synchronously. Both count as the hook result, as they did with await.
function settle<A>(run: () => A | PromiseLike<A>) {
  const failed = (cause: unknown) => new PluginHookError({ message: errorMessage(cause), cause })
  return Effect.try({ try: run, catch: failed }).pipe(
    Effect.flatMap((result) =>
      Predicate.isPromiseLike(result)
        ? Effect.tryPromise({ try: () => result, catch: failed })
        : Effect.succeed(result),
    ),
  )
}

const applyPlugin = Effect.fn("Plugin.apply")(function* (
  load: PluginLoader.Loaded,
  input: PluginInput,
  add: (hooks: Hooks) => void,
) {
  const plugin = yield* Effect.fromResult(v1Plugin(load.mod, load.spec, "server", "detect"))
  if (Option.isNone(plugin)) {
    const servers = yield* getLegacyPlugins(load.mod)
    return yield* Effect.forEach(servers, (server) => settle(() => server(input, load.options)).pipe(Effect.map(add)), {
      discard: true,
    })
  }

  const server = plugin.value.server
  // v1Plugin has checked that a server-kind module exports server() as a function.
  if (!isServerPlugin(server)) {
    return yield* new PluginExportError({ message: `Plugin ${load.spec} has invalid server export` })
  }
  const id = yield* Effect.fromResult(pluginId(plugin.value.id, load.spec))
  yield* pluginIdOf(load.source, load.spec, load.target, id, Option.fromNullishOr(load.pkg))
  return yield* settle(() => server(input, load.options)).pipe(Effect.map(add))
})

// The plugin SDK adapter takes its own WorkspaceInfo, where branch and directory are required
// and the ids are plain strings. The control plane ignores the ids that configure returns.
function toPluginWorkspace(info: WorkspaceInfo): PluginWorkspaceInfo {
  // eslint-disable-next-line effect/no-null-use-option -- (a) the plugin SDK WorkspaceInfo type requires branch and directory as string | null
  return { ...info, branch: info.branch ?? null, directory: info.directory ?? null, extra: info.extra }
}

function workspaceAdapter(adapter: PluginWorkspaceAdapter): WorkspaceAdapter {
  return {
    name: adapter.name,
    description: adapter.description,
    configure: (info) =>
      Effect.runPromise(
        awaited(() => adapter.configure(toPluginWorkspace(info))).pipe(
          Effect.map((configured) => ({ ...configured, id: info.id, projectID: info.projectID })),
        ),
      ),
    create: (info, env, from) =>
      from
        ? adapter.create(toPluginWorkspace(info), env, toPluginWorkspace(from))
        : adapter.create(toPluginWorkspace(info), env),
    remove: (info) => adapter.remove(toPluginWorkspace(info)),
    target: (info) => adapter.target(toPluginWorkspace(info)),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        let hooks: Hooks[] = []
        const add = (hook: Hooks) => {
          hooks = Arr.append(hooks, hook)
        }
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: yield* ServerAuth.headers(),
          ...(serverUrl
            ? {}
            : { fetch: (request: Request) => Effect.runPromise(awaited(() => Server.Default().app.fetch(request))) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, workspaceAdapter(adapter))
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          // eslint-disable-next-line effect/no-undefined-use-option -- (a) the plugin SDK PluginInput.$ is a BunShell, and a runtime without Bun has no shell to pass
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        for (const plugin of flags.disableDefaultPlugins ? [] : internalPlugins(flags)) {
          const init = yield* Effect.tryPromise({
            try: () => plugin(input),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load internal plugin", { name: plugin.name, error })),
            Effect.option,
          )
          if (Option.isSome(init)) add(init.value)
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate, retry) {
                Effect.runFork(
                  Telemetry.record("Info", "plugin load started", {
                    category: "plugin.load",
                    spec: candidate.plan.spec,
                    retry,
                  }),
                )
              },
              missing(candidate, retry, message) {
                Effect.runFork(
                  Telemetry.record("Warn", "plugin entry missing", {
                    category: "plugin.load",
                    spec: candidate.plan.spec,
                    retry,
                    reason: message,
                  }),
                )
              },
              error(candidate, retry, stage, error) {
                const spec = candidate.plan.spec
                Effect.runFork(
                  Telemetry.record("Warn", "plugin load failed", {
                    category: "plugin.load",
                    spec,
                    stage,
                    retry,
                    error,
                  }),
                )
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* applyPlugin(load, input, add).pipe(
            Effect.tapError((error) =>
              Effect.logError("failed to load plugin", { path: load.spec, error: errorMessage(error) }),
            ),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          const configHook = hook.config
          if (!configHook) continue
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the plugin SDK Hooks.config takes the generated v1 SDK Config, which marks model modalities input and output as required where Config.Info leaves them optional
          const sdkConfig = cfg as Parameters<typeof configHook>[0]
          yield* settle(() => configHook(sdkConfig)).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error: error.message })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            // The payload is the same wire shape that the SSE event stream sends to SDK clients.
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- (a) the plugin SDK Hooks.event takes the generated SDK Event union, and EventV2 payloads carry untyped data with no runtime schema for that union
            const payload = { id: event.id, type: event.type, properties: event.data } as PluginEvent
            for (const hook of hooks) {
              // A rejected event hook must not stop the fan-out, but it is recorded.
              void Promise.resolve(hook["event"]?.({ event: payload })).catch((error: unknown) =>
                Effect.runFork(
                  Telemetry.record("Warn", "plugin event hook failed", {
                    category: "plugin.event",
                    eventType: event.type,
                    error,
                  }),
                ),
              )
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              settle(() => hook.dispose?.()).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error: error.message })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: unknown, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      for (const hook of s.hooks) {
        const fn: UncheckedTriggerHook | undefined = hook[name]
        if (!fn) continue
        // A rejected or throwing trigger hook is a defect, as it was with Effect.promise.
        yield* awaited(() => fn(input, output))
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."

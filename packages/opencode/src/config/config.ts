import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import { FlagConfig } from "@opencode-ai/core/flag/flag"
import { readEnvSnapshot } from "@opencode-ai/core/plugin/provider/env-snapshot"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Array as Arr, Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { ConfigV2Compat } from "./v2-compat"
import { Npm } from "@opencode-ai/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Arr.dedupe([...target.instructions, ...source.instructions])
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

const substituteWellKnownRemoteConfig = Effect.fnUntraced(function* (input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string")
    return Option.none<{ url: string; headers: Record<string, string> }>()

  const substitute = (text: string) =>
    ConfigVariable.substitute({
      text,
      type: "virtual",
      dir: input.dir,
      source: input.source,
      env: input.env,
    })
  const url = yield* substitute(input.value.url)
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        yield* Effect.forEach(
          Object.entries(input.value.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
          ([key, value]) => substitute(value).pipe(Effect.map((text) => [key, text] as const)),
          { concurrency: "unbounded" },
        ),
      )
    : {}

  return Option.some({ url, headers })
})

// OPENCODE_CONFIG_CONTENT is read live, as the former process.env read was: tests and hosts set it
// after start. An empty value counts as not set.
const configContent = readEnvSnapshot(FlagConfig.OPENCODE_CONFIG_CONTENT).pipe(
  Effect.map(Option.filter((text) => text !== "")),
)

// OPENCODE_CONFIG reads the ambient ConfigProvider. It is optional, so a ConfigError is a defect.
const customConfigFile = FlagConfig.OPENCODE_CONFIG.pipe(Effect.orDie)

// Config text is JSON.stringify output: compact for text handed to loadConfig, and indented by two
// spaces for files. A value that JSON cannot encode (a cycle, a bigint) is a defect, as the throw was.
const encodeJsonText = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie)
const encodeConfigFile = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(value).pipe(Effect.orDie)

// OPENCODE_PERMISSION holds permission rules as JSON text.
const decodePermissionText = Schema.decodeEffect(Schema.fromJsonString(ConfigPermissionV1.Info))

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type Patch = typeof ConfigV1.Info.Type & Pick<Info, "plugin_origins">

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  // The patch and the result use the read-only decoded payload type, so HTTP handlers can pass a
  // request payload unchanged and test doubles can echo it back.
  readonly update: (config: Patch) => Effect.Effect<void>
  readonly updateGlobal: (config: Patch) => Effect.Effect<{ info: Patch; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Patch) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Patch) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  // jsonc-parser modify() deletes a key only for the undefined value, and JSON.stringify drops it.
  // eslint-disable-next-line effect/no-undefined-use-option -- (a) external boundary: jsonc-parser modify() removes the shell key only when given the JavaScript undefined value
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    // The first global config file that exists, else opencode.jsonc.
    const globalConfigFile = Effect.fnUntraced(function* () {
      const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) =>
        path.join(Global.Path.config, file),
      )
      const found = yield* Effect.findFirst(candidates, (file) => fs.existsSafe(file))
      return Option.getOrElse(found, () => candidates[0])
    })

    const decodeConfig = Effect.fnUntraced(function* (input: unknown, source: string) {
      const result = yield* ConfigV2Compat.lower(normalizeLoadedConfig(input), source)
      yield* Effect.forEach(result.diagnostics, (diagnostic) =>
        Effect.logWarning("configuration compatibility diagnostic", {
          source,
          path: diagnostic.path,
          kind: diagnostic.kind,
          action: diagnostic.message,
        }),
      )
      return yield* ConfigParse.decodeSchema(ConfigV1.Info, result.value, source)
    })

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string>,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers)))
        .pipe(
          Effect.catch((error) =>
            Effect.die(new Error(`failed to fetch remote config from ${url}: ${error.message}`, { cause: error })),
          ),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) =>
          Effect.die(new Error(`failed to read remote config from ${url}: ${error.message}`, { cause: error })),
        ),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) =>
          Effect.die(new Error(`failed to decode remote config from ${url}: ${error.message}`, { cause: error })),
        ),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* ConfigVariable.substitute(
        "path" in options
          ? { text, type: "path", path: options.path, env }
          : { text, type: "virtual", ...options, env },
      ).pipe(Effect.provideService(FSUtil.Service, fs))
      const parsed = yield* ConfigParse.parseJsonc(expanded, source)
      const data = yield* decodeConfig(parsed, source)
      if (!("path" in options)) return data

      if (data.plugin) {
        // Normalize path-like plugin specs while we still know which config file declared them.
        // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
        data.plugin = yield* Effect.forEach(data.plugin, (plugin) =>
          ConfigPlugin.resolvePluginSpec(plugin, options.path),
        )
      }
      if (!data.$schema) {
        data.$schema = "https://opencode.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
      // A substitution failure was a defect before (a rejected Promise); keep it one.
    }, Effect.orDie)

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      const routed = [yield* customConfigFile, yield* ConfigPaths.customDirectory, yield* configContent]
      if (routed.every(Option.isNone)) {
        const file = yield* globalConfigFile()
        if (!(yield* fs.existsSafe(file))) {
          yield* fs
            .writeWithDirs(file, yield* encodeConfigFile({ $schema: "https://opencode.ai/config.json" }))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (yield* fs.existsSafe(legacy)) {
        yield* Effect.gen(function* () {
          const mod = yield* Effect.tryPromise(() => import(pathToFileURL(legacy).href, { with: { type: "toml" } }))
          const { provider, model, ...rest } = mod.default
          if (provider && model) result.model = `${provider}/${model}`
          result["$schema"] = "https://opencode.ai/config.json"
          result = mergeConfig(result, rest)
          yield* fs.writeFileString(path.join(Global.Path.config, "config.json"), yield* encodeConfigFile(result))
          yield* fs.remove(legacy)
          // The legacy migration is best effort: any failure, thrown or typed, leaves the config as loaded.
        }).pipe(Effect.ignoreCause)
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        let consoleManagedProviders: string[] = []
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, {}, ConfigV1.WellKnown, url)
            const remote = yield* substituteWellKnownRemoteConfig({
              value: wellknown.remote_config,
              dir: url,
              source: wellknownURL,
              env: authEnv,
            })
            const fetchedConfig = Option.isSome(remote)
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.value.url })
                  const data = yield* fetchRemoteJson(remote.value.url, remote.value.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.value.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              yield* encodeJsonText(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        const customConfig = yield* customConfigFile
        if (Option.isSome(customConfig)) {
          yield* merge(customConfig.value, yield* loadFile(customConfig.value, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: customConfig.value })
        }

        if (!(yield* ConfigPaths.projectConfigDisabled)) {
          for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        const customDirectory = yield* ConfigPaths.customDirectory
        if (Option.isSome(customDirectory)) {
          yield* Effect.logDebug("loading config from OPENCODE_CONFIG_DIR", { path: customDirectory.value })
        }

        let deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".opencode") || Option.contains(customDirectory, dir)) {
            for (const file of ["opencode.json", "opencode.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const dep = yield* npmSvc
            .install(dir, {
              add: [
                // A local build installs the plugin package without a version pin.
                { name: "@opencode-ai/plugin", ...(InstallationLocal ? {} : { version: InstallationVersion }) },
              ],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps = Arr.append(deps, dep)

          result.command = mergeDeep(result.command ?? {}, yield* ConfigCommand.load(dir))
          result.agent = mergeDeep(result.agent ?? {}, yield* ConfigAgent.load(dir))
          result.agent = mergeDeep(result.agent ?? {}, yield* ConfigAgent.loadMode(dir))
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* ConfigPlugin.load(dir)
          yield* mergePluginOrigins(dir, list)
        }

        const content = yield* configContent
        if (Option.isSome(content)) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(content.value, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              // Spawned shell, MCP and LSP processes copy process.env, and later {env:} templates read it.
              // eslint-disable-next-line effect/no-process-env-use-config -- (a) external boundary: child processes (shell, MCP, LSP) inherit the console token through process.env
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(yield* encodeJsonText(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              consoleManagedProviders = Arr.dedupe([...consoleManagedProviders, ...Object.keys(next.provider ?? {})])
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err.message,
              }),
            ),
          )
        }

        const managedDir = yield* ConfigManaged.managedConfigDir()
        if (yield* fs.existsSafe(managedDir)) {
          for (const file of ["opencode.json", "opencode.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* ConfigManaged.readManagedPreferences()
        if (Option.isSome(managed)) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.value.text, {
              dir: path.dirname(managed.value.source),
              source: managed.value.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        // OPENCODE_PERMISSION is optional, so a ConfigError is a defect. An empty value counts as not set.
        const permission = Option.filter(
          yield* FlagConfig.OPENCODE_PERMISSION.pipe(Effect.orDie),
          (text) => text !== "",
        )
        if (Option.isSome(permission)) {
          const parsed = yield* decodePermissionText(permission.value).pipe(
            Effect.tapError((err) => Effect.logWarning("OPENCODE_PERMISSION contains invalid JSON, skipping", { err })),
            Effect.option,
          )
          if (Option.isSome(parsed)) result.permission = mergeDeep(result.permission ?? {}, parsed.value)
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermissionV1.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          result.username = yield* Effect.try(() => os.userInfo().username || "user").pipe(
            Effect.catch((error) =>
              // UnknownError keeps the thrown value as its cause; the log shows that raw value, as before.
              Effect.logWarning("failed to read system username, using fallback", { err: error.cause }).pipe(
                Effect.as("user"),
              ),
            ),
          )
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        // Both flags default to false, so a ConfigError is a defect.
        if (yield* FlagConfig.OPENCODE_DISABLE_AUTOCOMPACT.pipe(Effect.orDie)) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (yield* FlagConfig.OPENCODE_DISABLE_PRUNE.pipe(Effect.orDie)) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders,
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
      Effect.provideService(Global.Service, global),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Patch) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      const text = yield* readConfigFile(file)
      const original = text ? yield* ConfigParse.parseJsonc(text, file) : writable(existing)
      const serialized = yield* encodeConfigFile(
        mergeDeep(isRecord(original) ? original : writable(existing), writable(config)),
      )
      yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
      // A parse failure was a defect before (a sync throw); keep it one.
    }, Effect.orDie)

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Patch) {
      const file = yield* globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = yield* ConfigParse.parseJsonc(before, file)
        const lowered = yield* ConfigV2Compat.lower(normalizeLoadedConfig(existing), file)
        yield* ConfigParse.decodeSchema(ConfigV1.Info, lowered.value, file)
        const merged = mergeDeep(isRecord(existing) ? existing : {}, patch)
        const serialized = yield* encodeConfigFile(merged)
        next = yield* decodeConfig(merged, file)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
      } else {
        const updated = patchJsonc(before, patch)
        next = yield* decodeConfig(yield* ConfigParse.parseJsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
      // A parse or validation failure was a defect before (a sync throw); keep it one.
    }, Effect.orDie)

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Global.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"

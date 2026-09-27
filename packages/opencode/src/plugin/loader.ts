import {
  checkPluginCompatibility,
  createPluginEntry,
  isDeprecatedPlugin,
  pluginSource,
  pluginTarget,
  PluginInstallError,
  PluginTargetError,
  type PluginKind,
  type PluginPackage,
  type PluginSource,
} from "./shared"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { isRecord } from "@/util/record"

export namespace PluginLoader {
  // A normalized plugin declaration derived from config before any filesystem or npm work happens.
  export type Plan = {
    spec: string
    options: ConfigPluginV1.Options | undefined
    deprecated: boolean
  }

  // A plugin that has been resolved to a concrete target and entrypoint on disk.
  export type Resolved = Plan & {
    source: PluginSource
    target: string
    entry: string
    pkg?: PluginPackage
  }

  // A plugin target we could inspect, but which does not expose the requested kind of entrypoint.
  export type Missing = Plan & {
    source: PluginSource
    target: string
    pkg?: PluginPackage
    message: string
  }

  // A resolved plugin whose module has been imported successfully.
  export type Loaded = Resolved & {
    mod: Record<string, unknown>
  }

  // The resolved target of a plugin is empty.
  export class EmptyTargetError extends Schema.TaggedError<EmptyTargetError>()("PluginLoaderEmptyTargetError", {
    message: Schema.String,
  }) {}

  // The dynamic import of a plugin entrypoint did not give a module object.
  export class EmptyModuleError extends Schema.TaggedError<EmptyModuleError>()("PluginLoaderEmptyModuleError", {
    message: Schema.String,
  }) {}

  // The dynamic import of a plugin entrypoint failed. The cause is the original import rejection.
  export class ImportError extends Schema.TaggedError<ImportError>()("PluginLoaderImportError", {
    message: Schema.String,
    cause: Schema.Defect(),
  }) {}

  type Candidate = { origin: ConfigPlugin.Origin; plan: Plan }
  type Report = {
    // Called before each attempt so callers can log initial load attempts and retries uniformly.
    start?: (candidate: Candidate, retry: boolean) => void
    // Called when the package exists but does not provide the requested entrypoint.
    missing?: (candidate: Candidate, retry: boolean, message: string, resolved: Missing) => void
    // Called for operational failures such as install, compatibility, or dynamic import errors.
    error?: (
      candidate: Candidate,
      retry: boolean,
      stage: "install" | "entry" | "compatibility" | "load",
      error: unknown,
      resolved?: Resolved,
    ) => void
  }

  type ResolveStage = "install" | "entry" | "compatibility"

  type ResolveResult =
    | { ok: true; value: Resolved }
    | { ok: false; stage: "missing"; value: Missing }
    | { ok: false; stage: ResolveStage; error: unknown }

  type LoadResult = { ok: true; value: Loaded } | { ok: false; error: unknown }

  type AttemptResult<R> = {
    value: Option.Option<R>
    retry: boolean
  }

  type Finish<R> = (load: Loaded, origin: ConfigPlugin.Origin, retry: boolean) => Promise<R | undefined>
  type MissingHandler<R> = (value: Missing, origin: ConfigPlugin.Origin, retry: boolean) => Promise<R | undefined>

  // The steps that turn a loaded or missing plugin into a caller result. None skips the plugin.
  type Steps<R> = {
    finish: (load: Loaded, origin: ConfigPlugin.Origin, retry: boolean) => Effect.Effect<Option.Option<R>>
    missing: Option.Option<
      (value: Missing, origin: ConfigPlugin.Origin, retry: boolean) => Effect.Effect<Option.Option<R>>
    >
    report: Report | undefined
  }

  const fileSystemLayer = LayerNode.compile(FSUtil.node)

  // Each Promise edge builds the filesystem layer for its own run. A module-level ManagedRuntime
  // would keep the process alive after a CLI worker finishes.
  function runPromise<A, E>(effect: Effect.Effect<A, E, FSUtil.Service>) {
    return Effect.runPromise(effect.pipe(Effect.provide(fileSystemLayer)))
  }

  // Wrapped third-party failures reach the report callbacks as the original value, as before the Effect port.
  function reported(error: unknown) {
    if (error instanceof PluginInstallError || error instanceof ImportError) return error.cause
    return error
  }

  // Only a path plugin directory without package.json or an index file can be fixed by waiting.
  function isRetryableResolveError(stage: ResolveStage, error: unknown) {
    if (stage !== "install") return false
    return error instanceof PluginTargetError
  }

  // Normalize a config item into the loader's internal representation.
  function plan(item: ConfigPluginV1.Spec): Plan {
    const spec = ConfigPlugin.pluginSpecifier(item)
    return { spec, options: ConfigPlugin.pluginOptions(item), deprecated: isDeprecatedPlugin(spec) }
  }

  function failed(stage: ResolveStage, error: unknown): ResolveResult {
    return { ok: false, stage, error: reported(error) }
  }

  // Resolve a configured plugin into a concrete entrypoint that can later be imported.
  //
  // The stages here intentionally separate install/target resolution, entrypoint detection,
  // and compatibility checks so callers can report the exact reason a plugin was skipped.
  export const resolve = Effect.fn("PluginLoader.resolve")(function* (plan: Plan, kind: PluginKind) {
    // First make sure the plugin exists locally, installing npm plugins on demand.
    const target = yield* Effect.result(pluginTarget(plan.spec))
    if (Result.isFailure(target)) return failed("install", target.failure)
    if (!target.success) {
      return failed("install", new EmptyTargetError({ message: `Plugin ${plan.spec} target is empty` }))
    }

    // Then inspect the target for the requested server/tui entrypoint.
    const base = yield* Effect.result(createPluginEntry(plan.spec, target.success, kind))
    if (Result.isFailure(base)) return failed("entry", base.failure)
    const entry = base.success
    if (Option.isNone(entry.entry)) {
      const missing: ResolveResult = {
        ok: false,
        stage: "missing",
        value: {
          ...plan,
          source: entry.source,
          target: entry.target,
          pkg: Option.getOrUndefined(entry.pkg),
          message: `Plugin ${plan.spec} does not expose a ${kind} entrypoint`,
        },
      }
      return missing
    }

    // npm plugins can declare which opencode versions they support; file plugins are treated
    // as local development code and skip this compatibility gate.
    if (entry.source === "npm") {
      const compatible = yield* Effect.result(checkPluginCompatibility(entry.target, InstallationVersion, entry.pkg))
      if (Result.isFailure(compatible)) return failed("compatibility", compatible.failure)
    }
    const resolved: ResolveResult = {
      ok: true,
      value: {
        ...plan,
        source: entry.source,
        target: entry.target,
        entry: entry.entry.value,
        pkg: Option.getOrUndefined(entry.pkg),
      },
    }
    return resolved
  })

  // Import the resolved module only after all earlier validation has succeeded.
  export const load = Effect.fn("PluginLoader.load")(function* (row: Resolved) {
    const mod = yield* Effect.result(
      Effect.tryPromise({
        try: (): Promise<unknown> => import(row.entry),
        catch: (cause) => new ImportError({ message: `Plugin ${row.spec} failed to import`, cause }),
      }),
    )
    if (Result.isFailure(mod)) {
      const failure: LoadResult = { ok: false, error: reported(mod.failure) }
      return failure
    }
    if (!isRecord(mod.success)) {
      const empty: LoadResult = {
        ok: false,
        error: new EmptyModuleError({ message: `Plugin ${row.spec} module is empty` }),
      }
      return empty
    }
    const loaded: LoadResult = { ok: true, value: { ...row, mod: mod.success } }
    return loaded
  })

  // Run one candidate through the full pipeline: resolve, optionally surface a missing entry,
  // import the module, and finally let the caller transform the loaded plugin into any result type.
  function attempt<R>(candidate: Candidate, kind: PluginKind, retry: boolean, steps: Steps<R>) {
    return Effect.gen(function* () {
      const plan = candidate.plan
      const filePlugin = pluginSource(plan.spec) === "file"
      const report = steps.report
      const skipped: AttemptResult<R> = { value: Option.none(), retry: false }

      // Deprecated plugin packages are silently ignored because they are now built in.
      if (plan.deprecated) return skipped

      yield* Effect.sync(() => report?.start?.(candidate, retry))

      const resolved = yield* resolve(plan, kind)
      if (!resolved.ok) {
        if (resolved.stage === "missing") {
          // Missing entrypoints are handled separately so callers can still inspect package metadata,
          // for example to load theme files from a tui plugin package that has no code entrypoint.
          if (Option.isSome(steps.missing)) {
            const value = yield* steps.missing.value(resolved.value, candidate.origin, retry)
            if (Option.isSome(value)) return { value, retry: false }
          }
          yield* Effect.sync(() => report?.missing?.(candidate, retry, resolved.value.message, resolved.value))
          return skipped
        }
        yield* Effect.sync(() => report?.error?.(candidate, retry, resolved.stage, resolved.error))
        const failed: AttemptResult<R> = {
          value: Option.none(),
          retry: filePlugin && isRetryableResolveError(resolved.stage, resolved.error),
        }
        return failed
      }

      const loaded = yield* load(resolved.value)
      if (!loaded.ok) {
        yield* Effect.sync(() => report?.error?.(candidate, retry, "load", loaded.error, resolved.value))
        return skipped
      }

      // The finish step adapts the successfully loaded plugin into the caller's result shape.
      const value = yield* steps.finish(loaded.value, candidate.origin, retry)
      const done: AttemptResult<R> = { value, retry: false }
      return done
    })
  }

  type Input<R> = {
    items: ConfigPlugin.Origin[]
    kind: PluginKind
    wait?: () => Promise<void>
    finish?: Finish<R>
    missing?: MissingHandler<R>
    report?: Report
  }

  // A caller callback that resolves to undefined skips the plugin. A rejection fails the whole load.
  function callback<A extends unknown[], R>(fn: (...args: A) => Promise<R | undefined>) {
    return (...args: A) => Effect.promise(() => fn(...args)).pipe(Effect.map(Option.fromUndefinedOr))
  }

  function loadAll<R>(input: Pick<Input<R>, "items" | "kind" | "wait">, steps: Steps<R>) {
    return Effect.gen(function* () {
      const candidates = input.items.map((origin) => ({ origin, plan: plan(origin.spec) }))
      const first = yield* Effect.forEach(candidates, (candidate) => attempt(candidate, input.kind, false, steps), {
        concurrency: "unbounded",
      })
      const out = yield* Option.match(Option.fromUndefinedOr(input.wait), {
        onNone: () => Effect.succeed(first),
        onSome: (wait) =>
          Effect.gen(function* () {
            // The caller prepares dependencies once, on the first retry.
            const deps = yield* Effect.cached(Effect.promise(() => wait()))
            return yield* Effect.forEach(Arr.zip(candidates, first), ([candidate, previous]) => {
              if (Option.isSome(previous.value) || !previous.retry) return Effect.succeed(previous)

              // Only pre-import file plugin setup failures are retried. Bun caches failed dynamic imports,
              // so dependency waiting cannot fix load/build/runtime/shape failures in this process.
              if (pluginSource(candidate.plan.spec) !== "file") return Effect.succeed(previous)
              return deps.pipe(Effect.andThen(attempt(candidate, input.kind, true, steps)))
            })
          }),
      })

      // Drop skipped/failed entries while preserving the successful result order.
      return Arr.getSomes(out.map((item) => item.value))
    })
  }

  // Resolve and load all configured plugins in parallel.
  //
  // If `wait` is provided, file-based plugins with retryable pre-import setup failures are retried
  // once after the caller finishes preparing dependencies. Once dynamic import runs, failures are
  // treated as permanent for this process because Bun caches failed module resolution.
  //
  // Without `finish`, a loaded plugin is returned as it is, so the result holds Loaded values.
  export function loadExternal<R>(input: Input<R> & { finish: Finish<R> }): Promise<R[]>
  export function loadExternal<R = Loaded>(input: Input<R>): Promise<Array<R | Loaded>>
  export function loadExternal<R>(input: Input<R>): Promise<Array<R | Loaded>> {
    const steps: Steps<R | Loaded> = {
      finish: input.finish ? callback(input.finish) : (loaded: Loaded) => Effect.succeed(Option.some(loaded)),
      missing: Option.fromUndefinedOr(input.missing).pipe(Option.map((handler) => callback(handler))),
      report: input.report,
    }
    return runPromise(loadAll(input, steps))
  }
}

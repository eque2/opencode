import type { ArgumentsCamelCase, Argv, CommandModule } from "yargs"
import { Effect, Option, Schema } from "effect"
import type { AppServices } from "@/effect/app-runtime"
import type { InstanceStore } from "@/project/instance-store"

/**
 * User-visible command failure. Throw via `fail("...")` from an effectCmd handler
 * to surface a printed message + non-zero exit. Recognised by the global error
 * formatter in `src/cli/error.ts` (FormatError), so the existing top-level
 * catch + cleanup in `src/index.ts` runs normally.
 */
export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number),
}) {}

export const fail = (message: string, exitCode = 1) => Effect.fail(new CliError({ message, exitCode }))

/** The parsed arguments that yargs hands a command handler, plus the optional `--` passthrough list. */
export type EffectCmdArgs<Args> = ArgumentsCamelCase<Args> & { "--"?: string[] }

interface EffectCmdOpts<Args, A> {
  command: string | readonly string[]
  aliases?: string | readonly string[]
  describe: string | false
  builder?: (yargs: Argv) => Argv<Args>
  /**
   * Whether the command needs a project InstanceContext. Defaults to true.
   *
   * `true` (default): wraps the handler in `InstanceStore.Service.provide({directory})`
   * so `InstanceRef` resolves to a loaded `InstanceContext`. Auto-disposes via
   * `Effect.ensuring(store.dispose(ctx))` on every Exit (matches the legacy
   * `bootstrap()` finally-disposal). Runs InstanceBootstrap (config + plugin
   * init + LSP/File/etc forks) eagerly.
   *
   * `false`: skip the instance entirely. Saves the InstanceBootstrap work and
   * suppresses the `server.instance.disposed` IPC event. The handler runs
   * directly under AppRuntime — it can yield any `AppServices` but must not
   * rely on `InstanceRef` (it is `Option.none()`, so an instance read is a defect).
   *
   * Function form: `(args) => boolean` decides per-invocation. Useful for
   * commands like `run --attach <url>` where one flag flips between local
   * (needs instance) and remote (doesn't).
   *
   * Use `false` for commands that don't read project state (e.g. `models`,
   * `serve`, `web`, `account`, `db`, `upgrade`).
   */
  instance?: boolean | ((args: EffectCmdArgs<Args>) => boolean)
  /** Defaults to process.cwd(). Override for commands that take a directory positional. */
  directory?: (args: EffectCmdArgs<Args>) => string
  handler: (args: EffectCmdArgs<Args>) => Effect.Effect<A, CliError, AppServices | InstanceStore.Service>
}

/**
 * Effect-native CLI command builder. Builds a yargs `CommandModule` so the handler body is
 * an `Effect` with `InstanceRef` provided and any `AppServices` yieldable.
 *
 * The handler is wrapped in `Effect.ensuring(store.dispose(ctx))` so the loaded
 * InstanceContext is disposed (runDisposers + IPC `server.instance.disposed`)
 * on every Exit — success, typed failure, defect, or interruption. Matches the
 * legacy `bootstrap()` finally-disposal semantics without per-handler boilerplate.
 *
 * Errors propagate to the existing top-level handler in `src/index.ts`; use
 * `fail("...")` for user-visible domain failures (clean exit, formatted message).
 *
 * Handlers are typically `Effect.fn("Cli.<name>")(function*(args) { ... })`,
 * which adds a named tracing span per CLI invocation. Once all commands use
 * `effectCmd`, swapping the underlying `cmd()` factory for effect/cli's
 * `Command.make(...)` won't touch any handler bodies.
 */
export const effectCmd = <Args, A>(opts: EffectCmdOpts<Args, A>): CommandModule<{}, Args> => ({
  command: opts.command,
  aliases: opts.aliases,
  describe: opts.describe,
  builder: opts.builder,
  // yargs awaits the returned Promise. This is the single Promise edge for every effectCmd handler.
  handler: (args) => Effect.runPromise(runHandler(opts, args)),
})

const runHandler = Effect.fnUntraced(function* <Args, A>(opts: EffectCmdOpts<Args, A>, args: EffectCmdArgs<Args>) {
  // Load the runtime lazily so `--help` and argument errors do not build the application layer.
  const { AppRuntime } = yield* Effect.promise(() => import("@/effect/app-runtime"))
  const useInstance = typeof opts.instance === "function" ? opts.instance(args) : opts.instance !== false
  if (!useInstance) {
    yield* Effect.promise(() => AppRuntime.runPromise(opts.handler(args)))
    return
  }
  const { InstanceStore } = yield* Effect.promise(() => import("@/project/instance-store"))
  const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
  const directory = opts.directory?.(args) ?? process.cwd()
  yield* Effect.promise(() =>
    AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store
          .load({ directory })
          .pipe(
            Effect.flatMap((ctx) =>
              opts
                .handler(args)
                .pipe(Effect.provideService(InstanceRef, Option.some(ctx)), Effect.ensuring(store.dispose(ctx))),
            ),
          ),
      ),
    ),
  )
})

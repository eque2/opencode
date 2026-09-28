import type { ChildProcess, ChildProcessWithoutNullStreams } from "child_process"
import { exec } from "node:child_process"
import launch from "cross-spawn"
import { Deferred, Effect, Option, Predicate, Schema } from "effect"

export class LaunchError extends Schema.TaggedError<LaunchError>()("LSPLaunch.LaunchError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Options {
  cwd?: string
  /** The complete child environment. The parent environment is inherited when this is absent. */
  env?: NodeJS.ProcessEnv
}

// The language server protocol runs over stdio, so each of the three streams must be piped.
const hasPipes = <P extends ChildProcess>(proc: P): proc is P & ChildProcessWithoutNullStreams =>
  Predicate.isNotNull(proc.stdin) && Predicate.isNotNull(proc.stdout) && Predicate.isNotNull(proc.stderr)

// ChildProcess reports a running process with exitCode and signalCode null.
const hasExited = (proc: ChildProcess) =>
  Option.isSome(Option.fromNullishOr(proc.exitCode)) || Option.isSome(Option.fromNullishOr(proc.signalCode))

/**
 * A language server process. `exited` resolves with the exit code; a process killed by a signal,
 * or one that could not start, resolves with 1. It never rejects, so an unobserved failure is not
 * an unhandled rejection.
 */
export type Child = ChildProcessWithoutNullStreams & { readonly exited: Promise<number> }

// Starts the process and records how it ends.
const start = (cmd: string, args: ReadonlyArray<string>, opts: Options) => {
  const proc = launch(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32",
  })
  const exit = Deferred.makeUnsafe<number>()
  proc.once("exit", (code, signal) => Deferred.doneUnsafe(exit, Effect.succeed(code ?? (signal ? 1 : 0))))
  // A spawn failure (for example ENOENT) arrives as an "error" event. The listener also keeps
  // Node from throwing it as an uncaught exception.
  proc.once("error", () => Deferred.doneUnsafe(exit, Effect.succeed(1)))
  return Object.assign(proc, { exited: Effect.runPromise(Deferred.await(exit)) })
}

/**
 * Starts a language server process with piped stdin, stdout and stderr.
 *
 * The client talks to the server through Node streams (vscode-jsonrpc), so this keeps a Node
 * ChildProcess instead of an Effect ChildProcessHandle, whose lifetime ends with its scope.
 */
export const spawn = (cmd: string, args: ReadonlyArray<string>, opts: Options = {}) =>
  Effect.try({
    try: () => start(cmd, args, opts),
    catch: (cause) => new LaunchError({ command: cmd, message: "Process could not start", cause }),
  }).pipe(
    Effect.filterOrFail(hasPipes, () => new LaunchError({ command: cmd, message: "Process output not available" })),
  )

// Runs taskkill on the whole process tree and reports whether it succeeded.
const taskkill = (pid: number) =>
  Effect.callback<boolean>((resume) => {
    exec(`taskkill /pid ${pid} /T /F`, { windowsHide: true }, (error) =>
      resume(Effect.succeed(Predicate.isNull(error))),
    )
  })

/**
 * Stops a language server process. On Windows it ends the whole process tree with taskkill and
 * falls back to a plain kill when taskkill fails.
 */
export const stop = Effect.fnUntraced(function* (proc: ChildProcess) {
  if (hasExited(proc)) return
  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return
  }
  if (yield* taskkill(proc.pid)) return
  proc.kill()
})

export * as LSPLaunch from "./launch"

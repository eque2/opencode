import type { ChildProcessWithoutNullStreams } from "child_process"
import { Effect, Predicate, Schema } from "effect"
import { Process } from "@/util/process"

type Child = Process.Child & ChildProcessWithoutNullStreams

export class LaunchError extends Schema.TaggedError<LaunchError>()("LSPLaunch.LaunchError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// The language server protocol runs over stdio, so each of the three streams must be piped.
const hasPipes = (proc: Process.Child): proc is Child =>
  Predicate.isNotNull(proc.stdin) && Predicate.isNotNull(proc.stdout) && Predicate.isNotNull(proc.stderr)

/** Starts a language server process with piped stdin, stdout and stderr. */
export const spawn = (cmd: string, args: ReadonlyArray<string>, opts?: Process.Options) =>
  Effect.try({
    try: () =>
      Process.spawn([cmd, ...args], {
        ...opts,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    catch: (cause) => new LaunchError({ command: cmd, message: "Process could not start", cause }),
  }).pipe(
    Effect.filterOrFail(hasPipes, () => new LaunchError({ command: cmd, message: "Process output not available" })),
  )

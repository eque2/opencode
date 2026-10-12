import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:os"
import { Deferred, Duration, Effect, Exit, Option, Predicate, Schema } from "effect"

// The process-group runner of the proof runner. Every command runs as the leader of its own process
// group (detached), so one signal to the group reaches every descendant. When the leader exits, and
// when the command times out, the runner signals the whole group: SIGTERM, then SIGKILL after the
// cancel deadline. It kills only the recorded group: never by name, never by pattern.
//
// This is a thin native boundary on purpose. `ChildProcessSpawner` reports the exit code on `close`,
// which waits for every holder of the stdio pipes. A grandchild that holds a pipe would then hide the
// leader's exit until the timeout, and the group kill could only start after it. Here the leader's
// `exit` ends the wait, and the group kill follows at once.

/** The output that the runner keeps from each stream: the last 4 MiB of characters. */
const outputLimit = 4 * 1024 * 1024

/** How often the runner checks whether a process of the group is left. */
const pollInterval = Duration.millis(25)

/** The exit code that the runner reports when the command timed out, as `timeout(1)` does. */
export const timedOutExitCode = 124

/** How long one command may run, and how long the group kill may wait after each signal. */
export interface Bounds {
  readonly timeout: Duration.Input
  readonly cancelDeadline: Duration.Input
}

/** The options of one command. */
export interface Options extends Bounds {
  readonly cwd: string
}

/** How one command ended. */
export interface Result {
  /** The process group id. The command ran as the group leader, so it equals the leader's pid. */
  readonly pgid: number
  /** The leader's exit code; 128 plus the signal number when a signal ended it; 124 when it timed out. */
  readonly exitCode: number
  readonly timedOut: boolean
  /** The last characters that the command wrote to stdout. */
  readonly stdout: string
  /** The last characters that the command wrote to stderr. */
  readonly stderr: string
  /** True when the runner dropped the start of stdout or stderr to keep the last 4 MiB. */
  readonly truncated: boolean
  /** True when no process of the group survived the group kill. */
  readonly groupCleared: boolean
}

/** The command could not start. */
export class SpawnError extends Schema.TaggedError<SpawnError>()("TaskProofSpawnError", {
  command: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

interface Running {
  readonly child: ChildProcess
  /** Completes with the pid when the process started, or fails when it could not start. */
  readonly started: Deferred.Deferred<number, SpawnError>
  /** Completes with the exit status when the leader exits. */
  readonly exited: Deferred.Deferred<number>
  /** Completes when the stdio pipes closed: every process that held them is gone. */
  readonly closed: Deferred.Deferred<void>
  readonly output: () => { readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
}

const exitStatus = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (Predicate.isNumber(code)) return code
  if (Predicate.isString(signal)) return 128 + (constants.signals[signal] ?? 0)
  return 1
}

const errorCode = (cause: unknown): string =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : ""

const describe = (command: string, args: ReadonlyArray<string>) => [command, ...args].join(" ")

// Starts the command as the leader of a new process group and wires every event before it can fire.
const start = (command: string, args: ReadonlyArray<string>, cwd: string): Effect.Effect<Running, SpawnError> =>
  Effect.try({
    try: (): Running => {
      const started = Deferred.makeUnsafe<number, SpawnError>()
      const exited = Deferred.makeUnsafe<number>()
      const closed = Deferred.makeUnsafe<void>()
      const child = spawn(command, [...args], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      let truncated = false
      // Keeps the last `outputLimit` characters of a stream and records when it drops the start.
      const keepTail = (text: string) => {
        if (text.length <= outputLimit) return text
        truncated = true
        return text.slice(text.length - outputLimit)
      }
      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (chunk: string) => {
        stdout = keepTail(stdout + chunk)
      })
      child.stderr?.on("data", (chunk: string) => {
        stderr = keepTail(stderr + chunk)
      })
      // A read error only ends the output. Without a listener, Node would raise it as an uncaught error.
      child.stdout?.on("error", () => {})
      child.stderr?.on("error", () => {})
      child.once("spawn", () => {
        if (Predicate.isNumber(child.pid)) Deferred.doneUnsafe(started, Exit.succeed(child.pid))
      })
      child.on("error", (cause) => {
        Deferred.doneUnsafe(
          started,
          Exit.fail(new SpawnError({ command: describe(command, args), message: cause.message, cause })),
        )
      })
      child.once("exit", (code, signal) => {
        Deferred.doneUnsafe(exited, Exit.succeed(exitStatus(code, signal)))
      })
      child.once("close", () => {
        Deferred.doneUnsafe(closed, Exit.void)
      })
      return { child, started, exited, closed, output: () => ({ stdout, stderr, truncated }) }
    },
    catch: (cause) =>
      new SpawnError({
        command: describe(command, args),
        message: Predicate.isError(cause) ? cause.message : "spawn failed",
        cause,
      }),
  })

// Sends the signal to every process of the group. False when no process of the group is left (ESRCH).
const signalGroup = (pgid: number, signal: NodeJS.Signals | 0): Effect.Effect<boolean> =>
  Effect.try({ try: () => process.kill(-pgid, signal), catch: errorCode }).pipe(
    Effect.as(true),
    Effect.catch((code) => Effect.succeed(code !== "ESRCH")),
  )

// Waits until no process of the group is left. False when one is still left after the deadline.
const awaitGroupGone = (pgid: number, deadline: Duration.Input): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    while (yield* signalGroup(pgid, 0)) yield* Effect.sleep(pollInterval)
  }).pipe(Effect.timeoutOption(deadline), Effect.map(Option.isSome))

/**
 * Kills the whole process group `pgid`: SIGTERM, then SIGKILL when a process is still left after
 * `cancelDeadline`. Succeeds with true when no process of the group is left. The harness options reuse
 * it to cancel a command. It never signals by name or by pattern, and it refuses a group id below 2,
 * because `kill(0)` and `kill(-1)` reach processes that the runner did not start.
 */
export const killGroup = Effect.fn("TaskProof.killGroup")(function* (pgid: number, cancelDeadline: Duration.Input) {
  if (!Number.isInteger(pgid) || pgid < 2) {
    return yield* Effect.die(new Error(`refused to signal the process group ${pgid}`))
  }
  if (!(yield* signalGroup(pgid, "SIGTERM"))) return true
  if (yield* awaitGroupGone(pgid, cancelDeadline)) return true
  yield* signalGroup(pgid, "SIGKILL")
  return yield* awaitGroupGone(pgid, cancelDeadline)
})

const stopReading = (running: Running) =>
  Effect.sync(() => {
    running.child.stdout?.destroy()
    running.child.stderr?.destroy()
  })

// Kills the group when the use did not finish (failure or interruption), then stops reading.
const release = (running: Running, exit: Exit.Exit<Result, SpawnError>, cancelDeadline: Duration.Input) =>
  Effect.gen(function* () {
    const pid = running.child.pid
    if (Exit.isFailure(exit) && Predicate.isNumber(pid)) yield* killGroup(pid, cancelDeadline)
    yield* stopReading(running)
  })

/**
 * Runs one command as the leader of its own process group. It waits for the leader's exit for at most
 * `timeout`, then kills the whole group (see {@link killGroup}). A timed-out command reports exit code
 * 124. When the effect is interrupted, the group is killed too.
 */
export const run = Effect.fn("TaskProof.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: Options,
) {
  return yield* Effect.acquireUseRelease(
    start(command, args, options.cwd),
    (running) =>
      Effect.gen(function* () {
        const pgid = yield* Deferred.await(running.started)
        const exit = yield* Deferred.await(running.exited).pipe(Effect.timeoutOption(options.timeout))
        const groupCleared = yield* killGroup(pgid, options.cancelDeadline)
        // The pipes close when every holder is gone. A process that left the group can hold them open.
        yield* Deferred.await(running.closed).pipe(Effect.timeoutOption(options.cancelDeadline))
        const output = running.output()
        return {
          pgid,
          exitCode: Option.getOrElse(exit, () => timedOutExitCode),
          timedOut: Option.isNone(exit),
          stdout: output.stdout,
          stderr: output.stderr,
          truncated: output.truncated,
          groupCleared,
        } satisfies Result
      }),
    (running, exit) => release(running, exit, options.cancelDeadline),
  )
})

export * as ProofProcess from "./process"

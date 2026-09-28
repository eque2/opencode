import { type ChildProcess } from "child_process"
import type { Stream } from "node:stream"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { Function, Option, Schema } from "effect"
import { errorMessage } from "./error"

export type Stdio = "inherit" | "pipe" | "ignore" | number | Stream
export type Shell = boolean | string

export interface Options {
  cwd?: string
  /** Variables to add to the parent environment. */
  env?: NodeJS.ProcessEnv
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  kill?: NodeJS.Signals | number
  timeout?: number
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Schema.TaggedError<RunFailedError>()("ProcessRunFailedError", {
  cmd: Schema.Array(Schema.String),
  code: Schema.Number,
  stdout: Schema.instanceOf(Buffer),
  stderr: Schema.instanceOf(Buffer),
  message: Schema.String,
}) {}

function runFailed(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
  const text = stderr.toString().trim()
  const summary = `Command failed with code ${code}: ${cmd.join(" ")}`
  return new RunFailedError({ cmd: [...cmd], code, stdout, stderr, message: text ? `${summary}\n${text}` : summary })
}

export class EmptyCommandError extends Schema.TaggedError<EmptyCommandError>()("ProcessEmptyCommandError", {
  message: Schema.String,
}) {}

export class OutputUnavailableError extends Schema.TaggedError<OutputUnavailableError>()(
  "ProcessOutputUnavailableError",
  { message: Schema.String },
) {}

export type Child = ChildProcess & { exited: Promise<number> }

// ChildProcess reports a running process with exitCode and signalCode null.
function hasExited(proc: ChildProcess) {
  return Option.isSome(Option.fromNullishOr(proc.exitCode)) || Option.isSome(Option.fromNullishOr(proc.signalCode))
}

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new EmptyCommandError({ message: "Command is required" })
  opts.abort?.throwIfAborted()

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  })

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (closed) return
    if (hasExited(proc)) return
    closed = true

    proc.kill(opts.kill ?? "SIGTERM")

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    timer = setTimeout(() => proc.kill("SIGKILL"), ms)
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
    }

    proc.once("exit", (code, signal) => {
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  // A spawn error also rejects `exited`; callers that never await it must not see an unhandled rejection.
  void exited.catch(Function.constVoid)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  return Object.assign(proc, { exited })
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    kill: opts.kill,
    timeout: opts.timeout,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.stdout || !proc.stderr) throw new OutputUnavailableError({ message: "Process output not available" })

  const out = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    .then(([code, stdout, stderr]) => ({
      code,
      stdout,
      stderr,
    }))
    .catch((err: unknown) => {
      if (!opts.nothrow) throw err
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(errorMessage(err)),
      }
    })
  if (out.code === 0 || opts.nothrow) return out
  throw runFailed(cmd, out.code, out.stdout, out.stderr)
}

// Duplicated in `packages/sdk/js/src/process.ts` because the SDK cannot import
// `opencode` without creating a cycle. Keep both copies in sync.
export async function stop(proc: ChildProcess) {
  if (hasExited(proc)) return

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return
  }

  const out = await run(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
    nothrow: true,
  })

  if (out.code === 0) return
  proc.kill()
}

export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
  return (await text(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
}

export * as Process from "./process"

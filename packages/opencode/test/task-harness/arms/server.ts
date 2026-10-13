// One opencode server per conformance run, as a real process: SIGKILL and restart (H8) need a process to kill.
// The server runs in its own process group with isolated XDG folders under the run folder and binds 127.0.0.1.
import path from "node:path"
import fs from "node:fs"

// The current tree's CLI entry. The baseline arm serves another tree's entry instead (see Arms.entry()).
export const currentEntry = path.resolve(import.meta.dir, "../../../src/index.ts")

export type ServerOptions = {
  // The `src/index.ts` that `bun run` serves.
  readonly entry: string
  readonly repo: string
  readonly home: string
  readonly config: Record<string, unknown>
  readonly env?: Record<string, string>
}

export type Server = {
  readonly url: string
  readonly pid: number
  readonly log: string
  readonly exited: Promise<number>
}

export function isolatedEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    // Not OPENCODE_PURE: it skips every file plugin, unlike a normal install. The isolated XDG folders already keep
    // the developer's global plugins out; every arm runs with the same environment.
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_TASK_LIMITS: "scripted",
  }
}

// The parent's environment without the retired harness selector, the forwarded live key and the test preload's
// in-memory database: a stale OPENCODE_TASK_HARNESS in the shell must not reach either arm, only L1's server gets the
// key, and the server keeps its database under the isolated XDG data folder, so a restart (H8) finds what the killed
// server stored.
function inherited() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "OPENCODE_TASK_HARNESS" && key !== "OPENCODE_DB" && !key.startsWith("TASK_HARNESS_LIVE_"),
    ),
  )
}

export async function start(opts: ServerOptions, readyMs = 60_000): Promise<Server> {
  fs.mkdirSync(opts.home, { recursive: true })
  const log = path.join(opts.home, `server-${Date.now()}.log`)
  const out = fs.openSync(log, "a")
  const proc = Bun.spawn(["bun", "run", opts.entry, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: opts.repo,
    env: {
      ...inherited(),
      ...isolatedEnv(opts.home),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config),
      ...opts.env,
    },
    stdout: "pipe",
    stderr: out,
    detached: true,
  })
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + readyMs
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)])
    if (!next || next.done) break
    text += decoder.decode(next.value)
    const m = /listening on (http:\/\/[^\s]+)/.exec(text)
    if (m) {
      // Keep draining stdout so the pipe never fills and wedges the server.
      void (async () => {
        while (!(await reader.read()).done) {
          /* drain */
        }
      })().catch(() => undefined)
      return { url: m[1], pid: proc.pid, log, exited: proc.exited }
    }
  }
  kill(proc.pid, "SIGKILL")
  throw new Error(`opencode serve did not start within ${readyMs} ms; log ${log}:\n${fs.readFileSync(log, "utf8").slice(-2000)}`)
}

// The server leads its own process group (detached), so -pid reaches it and everything it spawned.
export function kill(pid: number, signal: NodeJS.Signals = "SIGTERM", group = true) {
  try {
    process.kill(group ? -pid : pid, signal)
  } catch {
    // already gone
  }
}

export async function stop(server: Server, deadlineMs = 2_000) {
  kill(server.pid, "SIGTERM")
  const done = await Promise.race([server.exited.then(() => true), Bun.sleep(deadlineMs).then(() => false)])
  if (!done) kill(server.pid, "SIGKILL")
  await Promise.race([server.exited, Bun.sleep(deadlineMs)])
}

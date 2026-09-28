import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { app } from "electron"
import { Data, Effect, Option } from "effect"
import { checkHealth } from "../server"
import { type WslCommandLine, findWslOpencode, shellEscape, wslArgs } from "./runtime"
import { pollWslHealth } from "./startup"
import { nativeT } from "../native-translations"

export type WslSidecar = {
  listener: { stop: () => void; onExit: (cb: (code: number | null, signal: NodeJS.Signals | null) => void) => void }
  url: string
  username: string | null
  password: string
}

class WslSidecarError extends Data.TaggedError("WslSidecarError")<{ readonly message: string }> {}

export function spawnWslSidecar(
  distro: string,
  opts: { onLine?: (line: WslCommandLine) => void; healthTimeoutMs?: number } = {},
): Promise<WslSidecar> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const opencode = yield* findWslOpencode(distro).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new WslSidecarError({ message: nativeT("desktop.wsl.error.opencodeNotInstalled", { distro }) }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      )

      const port = yield* allocatePort
      const password = randomUUID()
      const username = "opencode"
      const script = [
        "set -euo pipefail",
        'cd "$HOME" || cd /',
        'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
        "export PATH",
        "export WSLENV=",
        "export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true",
        "export OPENCODE_CLIENT=desktop",
        `export OPENCODE_SERVER_USERNAME=${shellEscape(username)}`,
        `export OPENCODE_SERVER_PASSWORD=${shellEscape(password)}`,
        'export XDG_STATE_HOME="$HOME/.local/state"',
        `exec ${shellEscape(opencode)} --print-logs --log-level ${app.isPackaged ? "WARN" : "INFO"} serve --hostname 0.0.0.0 --port ${port}`,
      ].join("\n")
      const child = spawn("wsl", wslArgs(["bash", "-se"], distro), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      child.stdin.end(script)

      const recentOutput: string[] = []
      const emit = (line: WslCommandLine) => {
        if (!line.text.trim()) return
        recentOutput.push(`[${line.stream}] ${line.text}`)
        if (recentOutput.length > 12) recentOutput.shift()
        opts.onLine?.(line)
      }
      forwardLines(child.stdout, "stdout", emit)
      forwardLines(child.stderr, "stderr", emit)

      // The listeners stay attached after startup, as before; a late resume is ignored.
      const exit = Effect.callback<never, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)))
        child.once("exit", (code, signal) =>
          resume(Effect.fail(new WslSidecarError({ message: startupFailure(code, signal, recentOutput) }))),
        )
      })
      const url = `http://127.0.0.1:${port}`
      // Effect.promise aborts the signal when the race interrupts the poll.
      const health = Effect.promise((signal) => pollWslHealth(() => checkHealth(url, password), signal))
      const timeoutMs = opts.healthTimeoutMs ?? 30_000

      yield* Effect.raceFirst(health, exit).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new WslSidecarError({
                message: nativeT("desktop.wsl.error.healthTimeout", { distro, timeout: timeoutMs }),
              }),
            ),
        }),
        Effect.tapError(() => Effect.sync(() => child.kill())),
      )
      return {
        listener: {
          stop: () => child.kill(),
          onExit: (cb) => child.once("exit", cb),
        },
        url,
        username,
        password,
      } satisfies WslSidecar
    }),
  )
}

const allocatePort = Effect.callback<number, Error>((resume) => {
  const server = createServer()
  server.on("error", (error) => resume(Effect.fail(error)))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || !address) {
      server.close()
      resume(Effect.fail(new WslSidecarError({ message: nativeT("desktop.wsl.error.failedPort") })))
      return
    }
    server.close(() => resume(Effect.succeed(address.port)))
  })
})

function forwardLines(
  stream: NodeJS.ReadableStream,
  source: WslCommandLine["stream"],
  onLine: (line: WslCommandLine) => void,
) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/g)
    // The last piece has no line break yet; keep it for the next chunk.
    pending = lines.at(-1) ?? ""
    lines.slice(0, -1).forEach((text) => onLine({ stream: source, text }))
  })
  stream.on("end", () => {
    if (pending) onLine({ stream: source, text: pending })
  })
}

function startupFailure(code: number | null, signal: NodeJS.Signals | null, recentOutput: string[]) {
  const suffix = recentOutput.length ? `\n${recentOutput.join("\n")}` : ""
  return nativeT("desktop.wsl.error.serverExitedBeforeHealthy", {
    code: code ?? "null",
    signal: signal ?? "null",
    output: suffix,
  })
}

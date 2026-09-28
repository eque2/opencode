import { describe, expect, test } from "bun:test"
import { once } from "node:events"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LSPLaunch } from "@/lsp/launch"
import { tmpdir } from "../fixture/fixture"

// The process behaviours that the callers of the removed util/process.ts relied on, checked
// against AppProcess (run to completion) and LSPLaunch (a long-lived Node child process).

function node(script: string) {
  return ChildProcess.make(process.execPath, ["-e", script], { stdin: "ignore" })
}

function run<A, E>(effect: (appProcess: AppProcess.Interface) => Effect.Effect<A, E>) {
  return Effect.runPromise(AppProcess.Service.use(effect).pipe(Effect.provide(LayerNode.compile(AppProcess.node))))
}

function runFailure<A>(effect: (appProcess: AppProcess.Interface) => Effect.Effect<A, AppProcess.AppProcessError>) {
  return run((appProcess) => effect(appProcess).pipe(Effect.flip))
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await run((appProcess) =>
      appProcess.run(node('process.stdout.write("out");process.stderr.write("err")')),
    )
    expect(out.exitCode).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns the exit code of a failed command", async () => {
    const out = await run((appProcess) => appProcess.run(node("process.exit(7)")))
    expect(out.exitCode).toBe(7)
  })

  test("fails with AppProcessError on non-zero exit when success is required", async () => {
    const err = await runFailure((appProcess) =>
      appProcess
        .run(node('process.stderr.write("bad");process.exit(3)'))
        .pipe(Effect.flatMap(AppProcess.requireSuccess)),
    )
    expect(err).toBeInstanceOf(AppProcess.AppProcessError)
    expect(err.exitCode).toBe(3)
    expect(err.stderr).toBe("bad")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const err = await runFailure((appProcess) =>
      appProcess.run(node("setInterval(() => {}, 1000)"), { signal: abort.signal }),
    )

    expect(err).toBeInstanceOf(AppProcess.AppProcessError)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const err = await runFailure((appProcess) =>
      appProcess.run(
        ChildProcess.make(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
          stdin: "ignore",
          forceKillAfter: "25 millis",
        }),
        { signal: abort.signal },
      ),
    )

    expect(err).toBeInstanceOf(AppProcess.AppProcessError)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await run((appProcess) =>
      appProcess.run(
        ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
          cwd: tmp.path,
          stdin: "ignore",
        }),
      ),
    )
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await run((appProcess) =>
      appProcess.run(
        ChildProcess.make(process.execPath, ["-e", 'process.stdout.write(process.env.OPENCODE_TEST ?? "")'], {
          env: { OPENCODE_TEST: "set" },
          extendEnv: true,
          stdin: "ignore",
        }),
      ),
    )
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await run((appProcess) =>
      appProcess.run(
        ChildProcess.make("set", ["OPENCODE_TEST_SHELL"], {
          shell: true,
          env: { OPENCODE_TEST_SHELL: "ok" },
          extendEnv: true,
          stdin: "ignore",
        }),
      ),
    )

    expect(out.exitCode).toBe(0)
    expect(out.stdout.toString()).toContain("OPENCODE_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = await Effect.runPromise(LSPLaunch.spawn(file, ["--stdio"]))

    expect(await proc.exited).toBe(0)
  })

  test("reports missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const proc = await Effect.runPromise(LSPLaunch.spawn(cmd, []))
    const [err] = await once(proc, "error")

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
    expect(await proc.exited).toBe(1)
  })
})

import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Option } from "effect"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { which } from "@opencode-ai/core/util/which"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const withShell = async (shell: string | undefined, fn: () => void | Promise<void>) => {
  const prev = process.env.SHELL
  if (shell === undefined) delete process.env.SHELL
  else process.env.SHELL = shell
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

describe("shell", () => {
  test("normalizes shell names", () => {
    expect(Shell.name("/bin/bash")).toBe("bash")
    if (process.platform === "win32") {
      expect(Shell.name("C:/tools/NU.EXE")).toBe("nu")
      expect(Shell.name("C:/tools/PWSH.EXE")).toBe("pwsh")
    }
  })

  test("detects login shells", () => {
    expect(Shell.login("/bin/bash")).toBe(true)
    expect(Shell.login("C:/tools/pwsh.exe")).toBe(false)
  })

  test("detects posix shells", () => {
    expect(Shell.posix("/bin/bash")).toBe(true)
    expect(Shell.posix("/bin/fish")).toBe(false)
    expect(Shell.posix("C:/tools/pwsh.exe")).toBe(false)
  })

  test("falls back when configured shell cannot be resolved", async () => {
    await withShell(undefined, async () => {
      const preferred = await run(Shell.preferred())
      const acceptable = await run(Shell.acceptable())
      expect(await run(Shell.preferred("opencode-missing-shell"))).toBe(preferred)
      expect(await run(Shell.acceptable("opencode-missing-shell"))).toBe(acceptable)
    })
  })

  test("falls back for terminal-only acceptable shells", async () => {
    expect(Shell.name(await run(Shell.acceptable("fish")))).not.toBe("fish")
    expect(Shell.name(await run(Shell.acceptable("nu")))).not.toBe("nu")
  })

  test("builds command args per shell family", () => {
    expect(Shell.args("/bin/sh", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    expect(Shell.args("/usr/bin/fish", "echo hi", "/tmp")).toEqual(["-c", "echo hi"])
    const zsh = Shell.args("/bin/zsh", "echo hi", "/tmp")
    expect(zsh[0]).toBe("-l")
    expect(zsh[1]).toBe("-c")
    expect(zsh.at(-1)).toBe("/tmp")
  })

  if (process.platform === "win32") {
    test("rejects blacklisted shells case-insensitively", async () => {
      await withShell("NU.EXE", async () => {
        expect(Shell.name(await run(Shell.acceptable()))).not.toBe("nu")
      })
    })

    test("normalizes Git Bash shell paths from env", async () => {
      const shell = "/cygdrive/c/Program Files/Git/bin/bash.exe"
      await withShell(shell, async () => {
        expect(await run(Shell.preferred())).toBe(FSUtil.windowsPath(shell))
      })
    })

    test("resolves /usr/bin/bash from env to Git Bash", async () => {
      const found = await run(Shell.gitbash())
      if (Option.isNone(found)) return
      const bash = found.value
      await withShell("/usr/bin/bash", async () => {
        expect(await run(Shell.acceptable())).toBe(bash)
        expect(await run(Shell.preferred())).toBe(bash)
      })
    })

    test("resolves bare bash to Git Bash before PATH", async () => {
      const found = await run(Shell.gitbash())
      if (Option.isNone(found)) return
      const bash = found.value
      expect(await run(Shell.acceptable("bash"))).toBe(bash)
      expect(await run(Shell.preferred("bash"))).toBe(bash)
      await withShell("bash", async () => {
        expect(await run(Shell.acceptable())).toBe(bash)
        expect(await run(Shell.preferred())).toBe(bash)
      })
    })

    test("resolves bare PowerShell shells", async () => {
      const pwsh = await run(which("pwsh"))
      const found = Option.isSome(pwsh) ? pwsh : await run(which("powershell"))
      if (Option.isNone(found)) return
      const shell = found.value
      await withShell(path.win32.basename(shell), async () => {
        expect(await run(Shell.preferred())).toBe(shell)
      })
    })
  }
})

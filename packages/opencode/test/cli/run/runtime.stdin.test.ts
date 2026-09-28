import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { Readable } from "node:stream"
import { INTERACTIVE_INPUT_ERROR, resolveTerminalInput } from "@/cli/cmd/run/runtime.stdin"

function stream(isTTY: boolean) {
  return Object.assign(new Readable({ read() {} }), { isTTY })
}

describe("run interactive stdin", () => {
  test("reuses stdin when it is already a tty", () => {
    const stdin = stream(true)
    const seen: string[] = []
    const result = Result.getOrThrow(
      resolveTerminalInput(
        stdin,
        (path) => {
          seen.push(path)
          return stream(true)
        },
        "linux",
      ),
    )

    expect(result.stdin).toBe(stdin)
    expect(result.cleanup).toBeUndefined()
    expect(seen).toEqual([])
  })

  test("opens the controlling terminal when stdin is piped", () => {
    const tty = stream(true)
    const seen: string[] = []
    const result = Result.getOrThrow(
      resolveTerminalInput(
        stream(false),
        (path) => {
          seen.push(path)
          return tty
        },
        "linux",
      ),
    )

    expect(result.stdin).toBe(tty)
    expect(seen).toEqual(["/dev/tty"])

    result.cleanup?.()
    expect(tty.destroyed).toBe(true)
  })

  test("uses CONIN$ on windows", () => {
    const seen: string[] = []
    Result.getOrThrow(
      resolveTerminalInput(
        stream(false),
        (path) => {
          seen.push(path)
          return stream(true)
        },
        "win32",
      ),
    )

    expect(seen).toEqual(["CONIN$"])
  })

  test("throws a clear error when no controlling terminal is available", () => {
    expect(() =>
      Result.getOrThrow(
        resolveTerminalInput(
          stream(false),
          () => {
            throw new Error("open failed")
          },
          "linux",
        ),
      ),
    ).toThrow(INTERACTIVE_INPUT_ERROR)
  })
})

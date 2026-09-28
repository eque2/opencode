import { describe, expect, test } from "bun:test"
import { terminalWriter } from "./terminal-writer"

describe("terminalWriter", () => {
  test("buffers and flushes once per schedule", () => {
    let calls: string[] = []
    let scheduled: VoidFunction[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls = [...calls, data]
        done?.()
      },
      (flush) => {
        scheduled = [...scheduled, flush]
      },
    )

    writer.push("a")
    writer.push("b")
    writer.push("c")

    expect(calls).toEqual([])
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()
    expect(calls).toEqual(["abc"])
  })

  test("flush is a no-op when empty", () => {
    let calls: string[] = []
    const writer = terminalWriter(
      (data, done) => {
        calls = [...calls, data]
        done?.()
      },
      (flush) => flush(),
    )
    writer.flush()
    expect(calls).toEqual([])
  })

  test("flush waits for pending write completion", () => {
    let calls: string[] = []
    let done: VoidFunction | undefined
    const writer = terminalWriter(
      (data, finish) => {
        calls = [...calls, data]
        done = finish
      },
      (flush) => flush(),
    )

    writer.push("a")

    let settled = false
    writer.flush(() => {
      settled = true
    })

    expect(calls).toEqual(["a"])
    expect(settled).toBe(false)

    done?.()
    expect(settled).toBe(true)
  })
})

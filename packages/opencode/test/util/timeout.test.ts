import { describe, expect, test } from "bun:test"
import { withTimeout } from "../lib/timeout"

describe("util.timeout", () => {
  test("should resolve when promise completes before timeout", async () => {
    const fastPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10)
    })

    const result = await withTimeout(fastPromise, 100)
    expect(result).toBe("fast")
  })

  test("should reject when promise exceeds timeout", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200)
    })

    const failure: unknown = await withTimeout(slowPromise, 50).then(
      () => "resolved",
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "Operation timed out after 50ms" })
  })
})

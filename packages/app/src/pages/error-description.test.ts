import { describe, expect, test } from "bun:test"
import { Data } from "effect"
import { errorDescriptionKey } from "./error-description"

/** A startup error from the local server. The desktop shell marks it with `localServerStartup`. */
class LocalServerStartupTestError extends Data.TaggedError("LocalServerStartupTestError")<{
  readonly message: string
  readonly localServerStartup: boolean
}> {}

/** An error with no startup marker. */
class UnknownTestError extends Data.TaggedError("UnknownTestError")<{ readonly message: string }> {}

describe("error description", () => {
  test("describes local server startup errors", () => {
    expect(
      errorDescriptionKey(new LocalServerStartupTestError({ message: "migration failed", localServerStartup: true })),
    ).toBe("error.page.description.localServerStartup")
  })

  test("uses the generic description for other errors", () => {
    expect(errorDescriptionKey(new UnknownTestError({ message: "unknown" }))).toBe("error.page.description")
    expect(
      errorDescriptionKey(new LocalServerStartupTestError({ message: "unknown", localServerStartup: false })),
    ).toBe("error.page.description")
  })
})

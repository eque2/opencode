import { describe, expect, test } from "bun:test"
import { Cause, Data, Deferred, Effect, Exit, Fiber } from "effect"
import { forwardInitializationFailure } from "./initialization"

class SidecarStartupError extends Data.TaggedError("SidecarStartupError")<{ readonly message: string }> {}

describe("desktop initialization", () => {
  const failure = new SidecarStartupError({ message: "sidecar startup failed" })
  const expectFailure = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.squash(exit.cause)).toBe(failure)
  }

  test("forwards loading task failures before renderer initialization", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        const exit = yield* Deferred.await(initialization).pipe(Effect.exit)
        expectFailure(exit)
      }),
    ))

  test("forwards loading task failures while renderer initialization waits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const initialization = yield* Deferred.make<never, unknown>()
        const waiting = yield* Deferred.await(initialization).pipe(Effect.exit, Effect.forkChild)
        yield* forwardInitializationFailure(initialization)(Effect.die(failure)).pipe(Effect.exit)
        const exit = yield* Fiber.join(waiting)
        expectFailure(exit)
      }),
    ))
})

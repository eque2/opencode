import { describe, expect, test } from "bun:test"
import { Data, Effect } from "effect"
import { initializationData, initializationReady } from "./initialization"

/** An initialization error as the Electron IPC bridge delivers it: an Error instance. */
class SidecarStartupError extends Data.TaggedError("SidecarStartupError")<{ readonly message: string }> {}

/** A fresh Solid resource read that has no value yet. */
const unresolved = () => () => {}

/** Runs initializationData and succeeds with the value it throws. */
const initializationFailure = (state: Parameters<typeof initializationData>[0]) =>
  Effect.flip(Effect.try({ try: () => initializationData(state), catch: (failure) => failure }))

describe("desktop renderer initialization", () => {
  test("throws the original initialization error before rendering server providers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = new SidecarStartupError({ message: "sidecar startup failed" })

        const failure = yield* initializationFailure(Object.assign(unresolved(), { error }))
        expect(failure).toBe(error)
        expect(failure).toHaveProperty("localServerStartup", true)
      }),
    ))

  test("removes Electron's remote invocation wrapper from startup errors", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = new SidecarStartupError({
          message:
            "Error invoking remote method 'await-initialization': Error: Cannot migrate session_message projections",
        })

        const failure = yield* initializationFailure(Object.assign(unresolved(), { error }))
        expect(failure).toBe(error)
        expect(failure).toHaveProperty("message", "Cannot migrate session_message projections")
      }),
    ))

  test("returns initialized sidecar data", () => {
    const sidecar = { url: "http://127.0.0.1:1234", username: "opencode", password: "secret" }

    expect(initializationData(() => sidecar)).toBe(sidecar)
  })

  test("does not discard falsy initialization errors", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const caught = yield* initializationFailure(Object.assign(unresolved(), { error: "" }))

        expect(caught).toBeInstanceOf(Error)
        expect(caught).toHaveProperty("message", "")
        expect(caught).toHaveProperty("localServerStartup", true)
      }),
    ))

  test("checks initialization errors before rendering server providers", () => {
    const error = new SidecarStartupError({ message: "sidecar startup failed" })

    expect(() => initializationReady(Object.assign(unresolved(), { error, loading: false }))).toThrow(error)
  })

  test("waits for pending initialization without reading it", () => {
    let reads = 0

    expect(
      initializationReady(
        Object.assign(
          () => {
            reads++
          },
          { loading: true },
        ),
      ),
    ).toBe(false)
    expect(reads).toBe(0)
  })
})

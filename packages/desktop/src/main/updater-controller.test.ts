import { describe, expect, test } from "bun:test"
import { Data, Effect, Option } from "effect"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"

class StopError extends Data.TaggedError("StopError")<{ readonly message: string }> {}

function setup(input?: { currentVersion?: string; ready?: UpdaterReadyRecord }) {
  let calls: ReadonlyArray<string> = []
  const record = (call: string) => {
    calls = [...calls, call]
  }
  const backend: UpdaterBackend = {
    checkForUpdates: () =>
      Effect.runPromise(
        Effect.sync(() => {
          record("check")
          return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
        }),
      ),
    downloadUpdate: () => Effect.runPromise(Effect.sync(() => record("download"))),
    quitAndInstall: () => Effect.sync(() => record("install")),
  }
  let ready = Option.fromNullishOr(input?.ready)
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = Option.some(value)
      },
      clear: () => {
        ready = Option.none()
      },
    },
    stop: () => Effect.runPromise(Effect.sync(() => record("stop"))),
  })
  return { controller, calls: () => calls, getReady: () => ready }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const app = setup()
        let states: ReadonlyArray<ReturnType<typeof app.controller.getState>> = []
        app.controller.subscribe((state) => {
          states = [...states, state]
        })

        yield* Effect.promise(() => app.controller.start())

        expect(app.calls()).toEqual(["check", "download"])
        expect(app.getReady()).toEqual(Option.some({ version: "2.0.0" }))
        expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
        expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
      }),
    ))

  test("revalidates a persisted target through the updater cache on launch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const app = setup({ ready: { version: "2.0.0" } })

        yield* Effect.promise(() => app.controller.start())

        expect(app.calls()).toEqual(["check", "download"])
        expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
      }),
    ))

  test("clears a target already installed before checking", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

        yield* Effect.promise(() => app.controller.start())

        expect(app.getReady()).toEqual(Option.none())
        expect(app.calls()).toEqual(["check"])
      }),
    ))

  test("coalesces concurrent checks", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const app = setup()

        yield* Effect.all(
          [
            Effect.promise(() => app.controller.check()),
            Effect.promise(() => app.controller.check()),
            Effect.promise(() => app.controller.check()),
          ],
          { concurrency: "unbounded" },
        )

        expect(app.calls()).toEqual(["check", "download"])
      }),
    ))

  test("returns to ready when quitAndInstall returns without exiting", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const app = setup()
        yield* Effect.promise(() => app.controller.start())

        yield* Effect.promise(() => app.controller.install())

        expect(app.calls()).toEqual(["check", "download", "stop", "install"])
        expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
      }),
    ))

  test("returns to ready when installation cannot start", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const app = setup()
        yield* Effect.promise(() => app.controller.start())

        const failed = createUpdaterController({
          enabled: true,
          currentVersion: "1.0.0",
          backend: {
            checkForUpdates: () =>
              Effect.runPromise(Effect.succeed({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } })),
            downloadUpdate: () => Effect.runPromise(Effect.void),
            quitAndInstall: () => Effect.void,
          },
          persistence: { get: () => Option.none(), set() {}, clear() {} },
          stop: () => Effect.runPromise(Effect.fail(new StopError({ message: "stop failed" }))),
        })
        yield* Effect.promise(() => failed.start())

        const error = yield* Effect.flip(Effect.tryPromise({ try: () => failed.install(), catch: (cause) => cause }))
        expect(error).toBeInstanceOf(Error)
        expect(error instanceof Error ? error.message : "").toContain("stop failed")
        expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
      }),
    ))
})

import { describe, expect, test, vi } from "bun:test"
import { Chunk, Effect } from "effect"
import { createRoot } from "solid-js"
import { createShellOptions, createSoundPreviewController } from "./general-controller-behavior"

describe("settings v2 controllers", () => {
  test("normalizes shell names and preserves an unavailable configured shell", () => {
    expect(
      createShellOptions({
        shells: [
          { path: "/bin/bash", name: "bash", acceptable: true },
          { path: "/opt/bash", name: "bash", acceptable: false },
          { path: "/bin/zsh", name: "zsh", acceptable: true },
        ],
        current: "fish",
      }),
    ).toEqual([
      { id: "auto", value: "", name: "", terminalOnly: false },
      { id: "/bin/bash", value: "/bin/bash", name: "/bin/bash", terminalOnly: false },
      { id: "/opt/bash", value: "/opt/bash", name: "/opt/bash", terminalOnly: true },
      { id: "/bin/zsh", value: "zsh", name: "zsh", terminalOnly: false },
      { id: "fish", value: "fish", name: "fish", terminalOnly: false },
    ])
  })

  test("debounces previews and stops owned audio on disposal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.useFakeTimers()
        let played = Chunk.empty<string>()
        let stopped = Chunk.empty<string>()
        // The promise of the last preview that started. Its reactions run in registration order,
        // so the controller stores the stop function before the test reads it.
        let started: Promise<unknown> = Effect.runPromise(Effect.void)
        const owned = createRoot((dispose) => ({
          dispose,
          preview: createSoundPreviewController((id) => {
            played = Chunk.append(played, id ?? "")
            const preview = Effect.runPromise(
              Effect.succeed(() => {
                stopped = Chunk.append(stopped, id ?? "")
              }),
            )
            started = preview
            return preview
          }),
        }))

        owned.preview.play("first")
        vi.advanceTimersByTime(99)
        expect(Chunk.toReadonlyArray(played)).toEqual([])

        owned.preview.play("second")
        vi.advanceTimersByTime(100)
        yield* Effect.promise(() => started)
        expect(Chunk.toReadonlyArray(played)).toEqual(["second"])

        owned.dispose()
        expect(Chunk.toReadonlyArray(stopped)).toEqual(["second"])
      }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers()))),
    ))
})

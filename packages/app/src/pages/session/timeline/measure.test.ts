import { expect, test } from "bun:test"
import { Effect } from "effect"
import { scheduleConnectedMeasure } from "./measure"

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})

test("does not measure an element detached before the frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const element = document.createElement("div")
      document.body.append(element)
      let calls = 0

      scheduleConnectedMeasure(element, () => {
        calls += 1
      })
      element.remove()
      yield* nextFrame

      expect(calls).toBe(0)
    }),
  ))

test("measures a connected element on the next frame", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const element = document.createElement("div")
      document.body.append(element)
      let calls = 0

      scheduleConnectedMeasure(element, () => {
        calls += 1
      })
      yield* nextFrame

      expect(calls).toBe(1)
      element.remove()
    }),
  ))

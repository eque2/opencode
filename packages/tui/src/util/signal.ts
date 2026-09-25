import { Effect, Fiber, Option, Schedule } from "effect"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

export function createDebouncedSignal<T>(value: T, ms: number): [Accessor<T>, (value: T) => void] {
  const [get, set] = createSignal(value)
  // A new value restarts the delay; cleanup stops an update that is still pending.
  let timer: Option.Option<Fiber.Fiber<void>> = Option.none()
  const cancel = () => {
    if (Option.isSome(timer)) Effect.runFork(Fiber.interrupt(timer.value))
    timer = Option.none()
  }
  const debounced = (next: T) => {
    cancel()
    timer = Option.some(
      Effect.runFork(
        Effect.sleep(ms).pipe(
          Effect.andThen(
            Effect.sync(() => {
              timer = Option.none()
              set(() => next)
            }),
          ),
        ),
      ),
    )
  }
  onCleanup(cancel)
  return [get, debounced]
}

export function createFadeIn(show: Accessor<boolean>, enabled: Accessor<boolean>) {
  const [alpha, setAlpha] = createSignal(show() ? 1 : 0)
  let revealed = show()

  createEffect(
    on([show, enabled], ([visible, animate]) => {
      if (!visible) {
        setAlpha(0)
        return
      }

      if (!animate || revealed) {
        revealed = true
        setAlpha(1)
        return
      }

      const start = performance.now()
      revealed = true
      setAlpha(0)

      // Step the fade every 16 ms until it reaches full opacity.
      const step = Effect.sync(() => {
        const progress = Math.min((performance.now() - start) / 160, 1)
        setAlpha(progress * progress * (3 - 2 * progress))
        return progress
      })
      const fade = Effect.runFork(
        Effect.sleep("16 millis").pipe(
          Effect.andThen(step.pipe(Effect.repeat({ schedule: Schedule.spaced("16 millis"), until: (p) => p >= 1 }))),
        ),
      )

      onCleanup(() => {
        Effect.runFork(Fiber.interrupt(fade))
      })
    }),
  )

  return alpha
}

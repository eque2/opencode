import { Effect, Fiber, Option } from "effect"
import { onCleanup } from "solid-js"

/**
 * A holder for at most one running fiber.
 *
 * `run` interrupts the fiber that still runs, then forks the new effect.
 * `interrupt` stops the fiber that still runs.
 */
export type FiberSlot = {
  readonly run: <A>(effect: Effect.Effect<A>) => void
  readonly interrupt: () => void
}

/**
 * Holds at most one running fiber, with no owner cleanup.
 *
 * Use it in module-level code that has no Solid owner. The caller must call
 * `interrupt` when the work is no longer needed.
 * A defect in the effect goes to the Effect logger, as an exception in a timer
 * callback goes to the console.
 *
 * Use it for a delayed update: `slot.run(Effect.sleep("800 millis").pipe(Effect.andThen(Effect.sync(update))))`.
 * A new call to `run` restarts the delay, and an interrupted sleep never runs its continuation.
 */
export function makeFiberSlot(): FiberSlot {
  let current: Option.Option<Fiber.Fiber<unknown>> = Option.none()

  const interrupt = () => {
    if (Option.isSome(current)) Effect.runFork(Fiber.interrupt(current.value))
    current = Option.none()
  }

  const run = <A>(effect: Effect.Effect<A>) => {
    interrupt()
    current = Option.some(Effect.runFork(effect.pipe(Effect.tapDefect((defect) => Effect.logError(defect)))))
  }

  return { run, interrupt }
}

/**
 * Holds at most one running fiber for the current Solid owner.
 *
 * It has the same shape as `makeFiberSlot`. The owner's cleanup calls
 * `interrupt`, so no fiber outlives the component or effect that made the slot.
 *
 * This is the app copy of the contract in packages/ui/src/hooks/create-fiber-slot.ts,
 * which packages/ui does not export.
 */
export function createFiberSlot(): FiberSlot {
  const slot = makeFiberSlot()
  onCleanup(slot.interrupt)
  return slot
}

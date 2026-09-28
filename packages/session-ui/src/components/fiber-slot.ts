import { Effect, Fiber, Option } from "effect"
import { onCleanup } from "solid-js"

/**
 * Holds at most one running fiber for the current Solid owner.
 *
 * `run` interrupts the fiber that still runs, then forks the new effect.
 * `interrupt` stops the fiber that still runs. The owner's cleanup calls
 * `interrupt`, so no fiber outlives the component or effect that made the slot.
 * A defect in the effect goes to the Effect logger, as an exception in a timer
 * callback goes to the console.
 *
 * Use it for a delayed UI update: `slot.run(Effect.sleep("800 millis").pipe(Effect.andThen(Effect.sync(update))))`.
 * A new call to `run` restarts the delay, and an interrupted sleep never runs its continuation.
 *
 * This is the session-ui copy of the contract in packages/ui/src/hooks/create-fiber-slot.ts,
 * which packages/ui does not export.
 */
export function createFiberSlot() {
  let current: Option.Option<Fiber.Fiber<unknown>> = Option.none()

  const interrupt = () => {
    if (Option.isSome(current)) Effect.runFork(Fiber.interrupt(current.value))
    current = Option.none()
  }

  const run = <A>(effect: Effect.Effect<A>) => {
    interrupt()
    current = Option.some(Effect.runFork(effect.pipe(Effect.tapDefect((defect) => Effect.logError(defect)))))
  }

  onCleanup(interrupt)

  return { run, interrupt }
}

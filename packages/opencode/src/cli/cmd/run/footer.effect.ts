// Effect helpers for the direct-mode footer.
//
// The footer is a Solid/opentui UI. Its callbacks stay synchronous, and each
// one runs its Effect once at that edge. These helpers hold the pieces that
// the footer controller and its bodies share: a typed error for host
// callbacks, an adapter for callbacks that may return a Promise, and a slot
// that holds at most one delayed fiber.
import { Effect, Fiber, Option, Predicate, Schema } from "effect"
import { onCleanup } from "solid-js"

/** A host callback (reply, editor, file search, render) threw or rejected. */
export class FooterCallbackError extends Schema.TaggedError<FooterCallbackError>()("FooterCallbackError", {
  action: Schema.String,
  cause: Schema.Defect(),
}) {}

function isPromiseLikeOf<A>(value: A | PromiseLike<A>): value is PromiseLike<A> {
  return Predicate.isPromiseLike(value)
}

/**
 * Runs a host callback that may return a plain value or a Promise.
 *
 * A synchronous throw and a rejection both fail with FooterCallbackError, so
 * the caller handles them in one place.
 */
export function fromCallback<A>(action: string, run: () => A | PromiseLike<A>) {
  return Effect.try({ try: run, catch: (cause) => new FooterCallbackError({ action, cause }) }).pipe(
    Effect.flatMap((value) =>
      isPromiseLikeOf(value)
        ? Effect.tryPromise({ try: () => value, catch: (cause) => new FooterCallbackError({ action, cause }) })
        : Effect.succeed(value),
    ),
  )
}

/**
 * A holder for at most one running fiber.
 *
 * `run` interrupts the fiber that still runs, then forks the new effect.
 * `interrupt` stops the fiber that still runs.
 */
export type FiberSlot = {
  readonly run: <A>(effect: Effect.Effect<A>) => void
  readonly interrupt: () => void
  readonly active: () => boolean
}

/**
 * Holds at most one running fiber, with no owner cleanup.
 *
 * Use it in code that has no Solid owner, such as the RunFooter class. The
 * owner must call `interrupt` when the work is no longer needed. An
 * interrupted sleep never runs its continuation.
 */
export function makeFiberSlot(): FiberSlot {
  let current: Option.Option<Fiber.Fiber<unknown>> = Option.none()

  const interrupt = () => {
    if (Option.isSome(current)) Effect.runFork(Fiber.interrupt(current.value))
    current = Option.none()
  }

  const run = <A>(effect: Effect.Effect<A>) => {
    interrupt()
    const fiber = Effect.runFork(effect)
    current = Option.some(fiber)
    // A finished fiber leaves the slot, so `active` reports only pending work.
    fiber.addObserver(() => {
      if (Option.exists(current, (item) => item === fiber)) current = Option.none()
    })
  }

  const active = () => Option.isSome(current)

  return { run, interrupt, active }
}

/**
 * Holds at most one running fiber for the current Solid owner.
 *
 * The owner's cleanup calls `interrupt`, so no fiber outlives the component.
 */
export function createFiberSlot(): FiberSlot {
  const slot = makeFiberSlot()
  onCleanup(slot.interrupt)
  return slot
}

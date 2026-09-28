import { Effect, MutableHashSet } from "effect"

type Disposer = (directory: string) => Promise<void>

const disposers = MutableHashSet.empty<Disposer>()

export function registerDisposer(disposer: Disposer) {
  MutableHashSet.add(disposers, disposer)
  return () => {
    MutableHashSet.remove(disposers, disposer)
  }
}

/**
 * Run every registered disposer for a directory at once. A disposer that throws or rejects does
 * not stop the others and does not fail the disposal.
 */
export const dispose = Effect.fn("InstanceRegistry.dispose")(function* (directory: string) {
  yield* Effect.forEach(
    Array.from(disposers),
    (disposer) => Effect.tryPromise(() => disposer(directory)).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  )
})

/** Promise form of {@link dispose} for callers that still bridge through `Effect.promise`. */
export function disposeInstance(directory: string) {
  return Effect.runPromise(dispose(directory))
}

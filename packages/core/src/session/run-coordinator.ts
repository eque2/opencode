export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, MutableHashMap, Option, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator, in the order the keys became active. */
  readonly active: Effect.Effect<ReadonlyArray<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = MutableHashMap.empty<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(
            Effect.suspend(() => options.drain(key, force)).pipe(
              Effect.withSpan("SessionRunCoordinator.drain", {
                attributes: { "session.id": String(key), force, successor },
              }),
            ),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => settle(key, entry, exit)).pipe(
              // No successor drain means the session has no eligible input left.
              Effect.andThen(
                Effect.suspend(() =>
                  MutableHashMap.has(active, key)
                    ? Effect.void
                    : Effect.logInfo("session idle", { "session.id": String(key) }).pipe(
                        Effect.annotateLogs({ category: "session.idle" }),
                      ),
                ),
              ),
            ),
          ),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      if (entry.pendingWake) {
        const successor = makeEntry()
        MutableHashMap.set(active, key, successor)
        start(key, successor, false, true)
      } else MutableHashMap.remove(active, key)
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const current = MutableHashMap.get(active, key)
        if (Option.isSome(current)) {
          const entry = current.value
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        MutableHashMap.set(active, key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const current = MutableHashMap.get(active, key)
        if (Option.isSome(current)) {
          current.value.pendingWake = true
          return
        }

        const next = makeEntry()
        MutableHashMap.set(active, key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const current = MutableHashMap.get(active, key)
        if (Option.isNone(current)) return Effect.void
        const entry = current.value
        if (entry.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => Array.from(MutableHashMap.keys(active))), run, wake, interrupt }
  })

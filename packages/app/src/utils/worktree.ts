import { Deferred, Effect, MutableHashMap, Option } from "effect"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

const normalize = (directory: string) => directory.replace(/[\\/]+$/, "")
const key = (scope: ServerScope, directory: string) => ScopedKey.from(scope, normalize(directory))

type State =
  | {
      status: "pending"
    }
  | {
      status: "ready"
    }
  | {
      status: "failed"
      message: string
    }

const state = MutableHashMap.empty<string, State>()
// One shared waiter per worktree. The Promise is kept, so every wait() call for a worktree gets the same Promise.
const waiters = MutableHashMap.empty<
  string,
  {
    readonly deferred: Deferred.Deferred<State>
    readonly promise: Promise<State>
  }
>()

function settle(id: string, next: State) {
  MutableHashMap.set(state, id, next)
  const waiter = MutableHashMap.get(waiters, id)
  if (Option.isNone(waiter)) return
  MutableHashMap.remove(waiters, id)
  Deferred.doneUnsafe(waiter.value.deferred, Effect.succeed(next))
}

export const Worktree = {
  get(scope: ServerScope, directory: string) {
    return Option.getOrUndefined(MutableHashMap.get(state, key(scope, directory)))
  },
  pending(scope: ServerScope, directory: string) {
    const id = key(scope, directory)
    if (Option.exists(MutableHashMap.get(state, id), (current) => current.status !== "pending")) return
    MutableHashMap.set(state, id, { status: "pending" })
  },
  ready(scope: ServerScope, directory: string) {
    settle(key(scope, directory), { status: "ready" })
  },
  failed(scope: ServerScope, directory: string, message: string) {
    settle(key(scope, directory), { status: "failed", message })
  },
  wait(scope: ServerScope, directory: string): Promise<State> {
    const id = key(scope, directory)
    const current = MutableHashMap.get(state, id)
    if (Option.isSome(current) && current.value.status !== "pending")
      return Effect.runPromise(Effect.succeed(current.value))

    const existing = MutableHashMap.get(waiters, id)
    if (Option.isSome(existing)) return existing.value.promise

    const deferred = Deferred.makeUnsafe<State>()
    const promise = Effect.runPromise(Deferred.await(deferred))
    MutableHashMap.set(waiters, id, { deferred, promise })
    return promise
  },
}

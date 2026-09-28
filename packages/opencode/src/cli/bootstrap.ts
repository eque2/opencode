import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore } from "../project/instance-store"
import { context } from "../project/instance-context"

// Public Promise API exported from src/node.ts. The callback runs inside the loaded instance
// context, and the instance is disposed on every exit, including a rejected callback.
export function bootstrap<T>(directory: string, cb: () => Promise<T>): Promise<T> {
  return AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      Effect.acquireUseRelease(
        store.load({ directory }),
        (ctx) => Effect.promise(() => context.provide(ctx, cb)),
        (ctx) => store.dispose(ctx),
      ),
    ),
  )
}

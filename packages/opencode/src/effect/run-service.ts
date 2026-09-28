import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect"
import * as Context from "effect/Context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import * as Observability from "@opencode-ai/core/observability"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { memoMap } from "@opencode-ai/core/effect/memo-map"

export type Refs = {
  readonly instance: Option.Option<InstanceContext>
  readonly workspace: Option.Option<WorkspaceV2.ID>
}

export function attachWith<A, E, R>(effect: Effect.Effect<A, E, R>, refs: Refs): Effect.Effect<A, E, R> {
  const withInstance = Option.match(refs.instance, {
    onNone: () => effect,
    onSome: (instance) => effect.pipe(Effect.provideService(InstanceRef, Option.some(instance))),
  })
  // An empty workspace ID means no workspace, as the earlier truthiness check treated it.
  return Option.match(
    Option.filter(refs.workspace, (workspace) => workspace !== ""),
    {
      onNone: () => withInstance,
      onSome: (workspace) => withInstance.pipe(Effect.provideService(WorkspaceRef, Option.some(workspace))),
    },
  )
}

export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const fiber = Option.fromNullishOr(Fiber.getCurrent())
  return attachWith(effect, {
    instance: Option.flatMap(fiber, (current) => Context.get(current.context, InstanceRef)),
    workspace: Option.fromNullishOr(WorkspaceContext.workspaceID).pipe(
      Option.orElse(() => Option.flatMap(fiber, (current) => Context.get(current.context, WorkspaceRef))),
    ),
  })
}

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  const getRuntime = () => (rt ??= ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), { memoMap }))

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(attach(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(attach(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(attach(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(attach(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      getRuntime().runCallback(attach(service.use(fn))),
  }
}

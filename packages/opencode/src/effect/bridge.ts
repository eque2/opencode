import { Context, Effect, Fiber, Option, Predicate } from "effect"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { attachWith } from "./run-service"

export interface Shape {
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>
}

function restoreWorkspace<R>(workspace: Option.Option<WorkspaceV2.ID>, fn: () => R): R {
  return Option.match(workspace, {
    onNone: fn,
    onSome: (id) => WorkspaceContext.restore(id, fn),
  })
}

function captureSync() {
  const fiber = Option.fromNullishOr(Fiber.getCurrent())
  const instance = Option.flatMapNullishOr(fiber, (current) => Context.get(current.context, InstanceRef))
  const workspace = Option.flatMapNullishOr(fiber, (current) => Context.get(current.context, WorkspaceRef)).pipe(
    Option.orElse(() => Option.fromNullishOr(WorkspaceContext.workspaceID)),
  )
  return { instance, workspace }
}

/**
 * Bridge from Effect into a Promise-returning JS callback while preserving
 * `WorkspaceContext` AsyncLocalStorage for callback code that still reads it.
 * `InstanceRef` is captured for effects run through the returned bridge APIs;
 * plain JS callbacks that need it should receive the ref explicitly.
 *
 * Mirrors `Effect.promise` but restores workspace ALS first.
 */
export const fromPromise = <T>(fn: () => Promise<T> | T): Effect.Effect<T> =>
  Effect.gen(function* () {
    const workspace = Option.fromNullishOr(yield* WorkspaceRef)
    return yield* Effect.suspend(() => {
      const result = restoreWorkspace(workspace, fn)
      return Predicate.isPromiseLike(result) ? Effect.promise(() => result) : Effect.succeed(result)
    })
  })

export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const ctx = yield* Effect.context()
    const captured = captureSync()
    const instance = Option.fromNullishOr(yield* InstanceRef).pipe(Option.orElse(() => captured.instance))
    const workspace = Option.fromNullishOr(yield* WorkspaceRef).pipe(Option.orElse(() => captured.workspace))
    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      attachWith(effect.pipe(Effect.provide(ctx)) as Effect.Effect<A, E>, { instance, workspace })

    return {
      promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restoreWorkspace(workspace, () => Effect.runPromise(wrap(effect))),
      fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restoreWorkspace(workspace, () => Effect.runFork(wrap(effect))),
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.callback<A, E>((resume) => {
          restoreWorkspace(workspace, () => Effect.runFork(wrap(effect)).addObserver(resume))
        }),
    } satisfies Shape
  })
}

export * as EffectBridge from "./bridge"

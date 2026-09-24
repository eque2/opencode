export * as PluginV2 from "./plugin"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Exit, Layer, MutableHashMap, Option, Scope } from "effect"
import type { Plugin as PluginRuntime } from "@opencode-ai/plugin/v2/effect"
import { Plugin } from "@opencode-ai/schema/plugin"
import { AgentV2 } from "./agent"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { CommandV2 } from "./command"
import { EventV2 } from "./event"
import { Integration } from "./integration"
import { KeyedMutex } from "./effect/keyed-mutex"
import { PluginHost } from "./plugin/host"
import { Reference } from "./reference"
import { SkillV2 } from "./skill"
import { State } from "./state"

export const ID = Plugin.ID
export type ID = typeof ID.Type
export const Event = Plugin.Event

export interface Interface {
  readonly add: (id: ID, effect: PluginRuntime["effect"]) => Effect.Effect<void>
  readonly remove: (id: ID) => Effect.Effect<void>
  readonly wait: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Plugin") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const locks = KeyedMutex.makeUnsafe<ID>()
    const scope = yield* Scope.make()
    const active = MutableHashMap.empty<ID, Scope.Closeable>()
    const loading = new Set<ID>()
    const waiters = MutableHashMap.empty<ID, Set<Deferred.Deferred<void>>>()
    const failures = MutableHashMap.empty<ID, Exit.Exit<void, never>>()
    const waitersOf = (id: ID) => Option.getOrElse(MutableHashMap.get(waiters, id), () => [])
    let host: Parameters<PluginRuntime["effect"]>[0]

    const add = Effect.fn("Plugin.add")(function* (id: ID, effect: PluginRuntime["effect"]) {
      if (loading.has(id)) return yield* Effect.die(`Plugin load cycle detected for ${id}`)

      yield* locks.withLock(id)(
        Effect.sync(() => {
          loading.add(id)
          MutableHashMap.remove(failures, id)
        }).pipe(
          Effect.andThen(
            State.batch(
              Effect.gen(function* () {
                const existing = MutableHashMap.get(active, id)
                MutableHashMap.remove(active, id)
                if (Option.isSome(existing)) yield* Scope.close(existing.value, Exit.void).pipe(Effect.ignore)

                const child = yield* Scope.fork(scope)
                yield* effect(host).pipe(
                  Scope.provide(child),
                  Effect.withSpan("Plugin.load", { attributes: { "plugin.id": id } }),
                  Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
                )
                yield* events.publish(Event.Added, { id })
                MutableHashMap.set(active, id, child)
                yield* Effect.forEach(waitersOf(id), (waiter) => Deferred.succeed(waiter, undefined), {
                  discard: true,
                })
                MutableHashMap.remove(waiters, id)
              }),
            ),
          ),
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            MutableHashMap.set(failures, id, exit)
            return Effect.forEach(waitersOf(id), (waiter) => Deferred.done(waiter, exit), {
              discard: true,
            }).pipe(Effect.ensuring(Effect.sync(() => MutableHashMap.remove(waiters, id))))
          }),
          Effect.ensuring(Effect.sync(() => loading.delete(id))),
        ),
      )
    })

    const remove = Effect.fn("Plugin.remove")(function* (id: ID) {
      if (loading.has(id)) return yield* Effect.die(`Cannot remove plugin ${id} while it is loading`)

      yield* locks.withLock(id)(
        State.batch(
          Effect.gen(function* () {
            const current = MutableHashMap.get(active, id)
            MutableHashMap.remove(active, id)
            MutableHashMap.remove(failures, id)
            if (Option.isSome(current)) yield* Scope.close(current.value, Exit.void).pipe(Effect.ignore)
          }),
        ),
      )
    })

    const wait = Effect.fn("Plugin.wait")(function* (id: ID) {
      const waiter = yield* Deferred.make<void>()
      const pending = yield* locks.withLock(id)(
        Effect.sync(() => {
          if (MutableHashMap.has(active, id)) return false
          const failure = MutableHashMap.get(failures, id)
          if (Option.isSome(failure)) return failure.value
          const current = Option.getOrElse(MutableHashMap.get(waiters, id), () => new Set<Deferred.Deferred<void>>())
          current.add(waiter)
          MutableHashMap.set(waiters, id, current)
          return true
        }),
      )
      if (!pending) return
      if (typeof pending !== "boolean") return yield* pending
      yield* Deferred.await(waiter).pipe(
        Effect.ensuring(
          locks.withLock(id)(
            Effect.sync(() => {
              const current = MutableHashMap.get(waiters, id)
              if (Option.isNone(current)) return
              current.value.delete(waiter)
              if (current.value.size === 0) MutableHashMap.remove(waiters, id)
            }),
          ),
        ),
      )
    })

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        MutableHashMap.clear(active)
        yield* State.batch(Scope.close(scope, exit))
      }),
    )

    const service = Service.of({
      add,
      remove,
      wait,
    })
    host = yield* PluginHost.make(service)
    return service
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(AgentV2.locationLayer),
  Layer.provideMerge(AISDK.locationLayer),
  Layer.provideMerge(Catalog.locationLayer),
  Layer.provideMerge(CommandV2.locationLayer),
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Reference.locationLayer),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ],
})

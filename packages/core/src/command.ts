export * as CommandV2 from "./command"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, MutableHashMap, Option, Types } from "effect"
import { Command } from "@opencode-ai/schema/command"
import { State } from "./state"

export const Info = Command.Info
export type Info = Command.Info

export type Data = {
  // MutableHashMap iterates in insertion order, so list() keeps the order commands were added.
  commands: MutableHashMap.MutableHashMap<string, Types.DeepMutable<Info>>
}

export type Draft = {
  list: () => readonly Info[]
  get: (name: string) => Info | undefined
  update: (name: string, update: (command: Types.DeepMutable<Info>) => void) => void
  remove: (name: string) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Command") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const state = State.create<Data, Draft>({
      initial: () => ({ commands: MutableHashMap.empty() }),
      draft: (draft) => ({
        list: () => Array.from(MutableHashMap.values(draft.commands)) as Info[],
        get: (name) => Option.getOrUndefined(MutableHashMap.get(draft.commands, name)),
        update: (name, update) => {
          const current = Option.getOrElse(
            MutableHashMap.get(draft.commands, name),
            (): Types.DeepMutable<Info> => ({ name, template: "" }),
          )
          if (!MutableHashMap.has(draft.commands, name)) MutableHashMap.set(draft.commands, name, current)
          update(current)
          current.name = name
        },
        remove: (name) => {
          MutableHashMap.remove(draft.commands, name)
        },
      }),
    })

    return Service.of({
      reload: state.reload,
      transform: state.transform,
      get: Effect.fn("CommandV2.get")(function* (name) {
        return Option.getOrUndefined(MutableHashMap.get(state.get().commands, name))
      }),
      list: Effect.fn("CommandV2.list")(function* () {
        return Array.from(MutableHashMap.values(state.get().commands))
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })

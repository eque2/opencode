export * as AgentV2 from "./agent"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, MutableHashMap, Option, Types } from "effect"
import { Agent } from "@opencode-ai/schema/agent"
import { State } from "./state"

export const ID = Agent.ID
export type ID = typeof ID.Type
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  // MutableHashMap iterates in insertion order, which list(), all() and the default fallback rely on.
  agents: MutableHashMap.MutableHashMap<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Draft = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly default: () => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Agent") {}

// The values of Agent.Info.empty, built as the mutable draft that update() edits in place.
// The "creates agents with runtime defaults" test checks that the two stay equal.
const emptyDraft = (id: ID): Types.DeepMutable<Info> => ({
  id,
  request: { headers: {}, body: {} },
  mode: "all",
  hidden: false,
  permissions: [],
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ agents: MutableHashMap.empty() }),
      draft: (draft) => ({
        list: () => Array.fromIterable(MutableHashMap.values(draft.agents)) as Info[],
        get: (id) => Option.getOrUndefined(MutableHashMap.get(draft.agents, id)),
        default: (id) => {
          draft.default = id
        },
        update: (id, fn) => {
          const current = Option.getOrElse(MutableHashMap.get(draft.agents, id), () => emptyDraft(id))
          if (!MutableHashMap.has(draft.agents, id)) MutableHashMap.set(draft.agents, id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          MutableHashMap.remove(draft.agents, id)
        },
      }),
    })
    const selectable = (agent: Info) => agent.mode !== "subagent" && !agent.hidden
    // The configured default wins, then "build", then the first selectable agent in insertion order.
    const selectedDefault = (): Option.Option<Info> => {
      const data = state.get()
      return Option.fromUndefinedOr(data.default).pipe(
        Option.filter((id) => id.length > 0),
        Option.flatMap((id) => MutableHashMap.get(data.agents, id)),
        Option.filter(selectable),
        Option.orElse(() => MutableHashMap.get(data.agents, ID.make("build")).pipe(Option.filter(selectable))),
        Option.orElse(() => Array.findFirst(MutableHashMap.values(data.agents), selectable)),
      )
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("AgentV2.get")(function* (id) {
        return Option.getOrUndefined(MutableHashMap.get(state.get().agents, id))
      }),
      default: Effect.fn("AgentV2.default")(function* () {
        return Option.getOrUndefined(selectedDefault())
      }),
      resolve: Effect.fn("AgentV2.resolve")(function* (id) {
        if (id !== undefined) return Option.getOrUndefined(MutableHashMap.get(state.get().agents, ID.make(id)))
        return Option.getOrUndefined(selectedDefault())
      }),
      select: Effect.fn("AgentV2.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: Option.getOrUndefined(MutableHashMap.get(state.get().agents, selected)) }
        }
        const info = selectedDefault()
        return {
          id: Option.match(info, { onNone: () => defaultID, onSome: (agent) => agent.id }),
          info: Option.getOrUndefined(info),
        }
      }),
      all: Effect.fn("AgentV2.all")(function* () {
        return Array.fromIterable(MutableHashMap.values(state.get().agents))
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })

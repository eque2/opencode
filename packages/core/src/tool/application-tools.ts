export * as ApplicationTools from "./application-tools"

import { Context, Effect, Layer, MutableHashMap, Option, Scope } from "effect"
import { State } from "../state"
import { Tool } from "./tool"
import { makeGlobalNode } from "../effect/app-node"

type Data = {
  readonly entries: MutableHashMap.MutableHashMap<string, Entry>
}

type Draft = {
  readonly set: (name: string, entry: Entry) => void
}

export interface Entry {
  readonly identity: object
  readonly tool: Tool.AnyTool
}

export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
  /** Active registrations in registration order. */
  readonly entries: () => ReadonlyArray<readonly [string, Entry]>
  /** The active registration for one tool name. */
  readonly get: (name: string) => Option.Option<Entry>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ApplicationTools") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ entries: MutableHashMap.empty() }),
      draft: (draft) => ({
        set: (name, tool) => {
          MutableHashMap.set(draft.entries, name, tool)
        },
      }),
    })

    return Service.of({
      register: Effect.fn("ApplicationTools.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => Tool.validateName(name), { discard: true })
        const registrations = entries.map(([name, tool]) => [name, { identity: {}, tool }] as const)
        yield* state.transform((draft) => {
          for (const [name, entry] of registrations) draft.set(name, entry)
        })
      }),
      entries: () => Array.from(state.get().entries),
      get: (name) => MutableHashMap.get(state.get().entries, name),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })

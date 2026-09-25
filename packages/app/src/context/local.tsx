import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useModels } from "@/context/models"
import { useSettings } from "@/context/settings"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import { Persist, persisted } from "@/utils/persist"
import { hasCustomAgent, resolveAgent } from "./local-agent"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServerSDK } from "./server-sdk"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { HashMap, HashSet, MutableHashMap, Option } from "effect"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = MutableHashMap.empty<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return undefined
  return {
    ...value,
    ...(value.model ? { model: { ...value.model } } : {}),
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const sync = useSync()
    const serverSDK = useServerSDK()
    const providers = useProviders(() => sdk().directory)
    const models = useModels()
    const settings = useSettings()

    const id = createMemo(() => Option.fromNullishOr(params.id).pipe(Option.filter((value) => value !== "")))
    const list = createMemo(() => sync().data.agent.filter((item) => item.mode !== "subagent" && !item.hidden))
    const agentsVisible = createMemo(() => settings.visibility.customAgents() || hasCustomAgent(list()))
    const connected = createMemo(() => HashSet.fromIterable(providers.connected().map((item) => item.id)))

    const [saved, setSaved, , savedReady] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK().scope, sdk().directory, "model-selection", ["model-selection.v1"]),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      promoting?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
    })

    // Solid deletes a store key that is set to undefined; these helpers delete it directly.
    const clearCurrent = () =>
      setStore(
        produce((state) => {
          delete state.current
        }),
      )
    const clearDraft = () =>
      setStore(
        produce((state) => {
          delete state.draft
        }),
      )
    const clearPromoting = () =>
      setStore(
        produce((state) => {
          delete state.promoting
        }),
      )

    const validModel = (model: ModelKey) => {
      const provider = HashMap.get(providers.all(), model.providerID)
      return (
        Option.exists(provider, (item) => !!item.models[model.modelID]) && HashSet.has(connected(), model.providerID)
      )
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
      return undefined
    }

    const pickAgent = (name: string | undefined) => {
      return resolveAgent(list(), name)
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) clearCurrent()
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() =>
      Option.match(id(), {
        onNone: () => store.draft ?? store.promoting,
        onSome: (session) =>
          saved.session[session] ??
          Option.getOrUndefined(MutableHashMap.get(handoff, handoffKey(serverSDK().scope, sdk().directory, session))),
      }),
    )

    createEffect(() => {
      const session = id()
      if (Option.isNone(session)) return

      const key = handoffKey(serverSDK().scope, sdk().directory, session.value)
      const next = MutableHashMap.get(handoff, key)
      if (Option.isNone(next)) return
      if (saved.session[session.value] !== undefined) {
        MutableHashMap.remove(handoff, key)
        clearPromoting()
        return
      }

      setSaved("session", session.value, clone(next.value))
      MutableHashMap.remove(handoff, key)
      clearPromoting()
    })

    const configuredModel = () => {
      const model = resolveDefaultModel(providers.defaultModel(), sync().data.config.model)
      if (!model) return undefined
      if (validModel(model)) return model
      return undefined
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
      return undefined
    }

    const defaultModel = () => {
      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
      return undefined
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      visible: agentsVisible,
      current() {
        return pickAgent(agentsVisible() ? (scope()?.agent ?? store.current) : "build")
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          clearCurrent()
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (Option.isSome(session)) {
            setSaved("session", session.value, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          clearCurrent()
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const current = () => {
      const item = firstModel(
        () => scope()?.model,
        () => agent.current()?.model,
        fallback,
      )
      if (!item) return undefined
      return models.find(item)
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return undefined
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        ...(model ? { model: { providerID: model.provider.id, modelID: model.id } } : {}),
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (Option.isSome(session)) {
        setSaved("session", session.value, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        void startTransition(() =>
          batch(() => {
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant: selected(),
            })
            write({ model: item })
            if (!item) return
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return undefined
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
          return undefined
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          void startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value ?? null,
              })
              write({ variant: value ?? null })
              if (model) {
                models.variant.set({ providerID: model.provider.id, modelID: model.id }, value)
              }
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      session: {
        ready: savedReady,
        reset() {
          setStore(
            produce((state) => {
              delete state.draft
              delete state.promoting
            }),
          )
        },
        promote(dir: string, session: string, state?: State) {
          const next = clone(state ?? snapshot())
          if (!next) return
          const key = handoffKey(serverSDK().scope, dir, session)
          MutableHashMap.set(handoff, key, next)

          if (dir === sdk().directory) {
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          clearDraft()
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey }) {
          const session = id()
          if (Option.isNone(session)) return
          if (msg.sessionID !== session.value) return
          if (saved.session[session.value] !== undefined) return
          if (MutableHashMap.has(handoff, handoffKey(serverSDK().scope, sdk().directory, session.value))) return

          setSaved("session", session.value, {
            agent: msg.agent,
            model: msg.model,
            variant: msg.model?.variant ?? null,
          })
        },
      },
    }
    return result
  },
})

export type ModelSelection = ReturnType<typeof useLocal>["model"]

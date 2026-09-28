import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { batch, createEffect, createMemo, createSignal } from "solid-js"
import { useSync } from "./sync"
import { useEvent } from "./event"
import path from "path"
import { useTuiPaths } from "./runtime"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { Array, Effect, Equal, HashSet, Option, Schema } from "effect"
import { fileSystemLayer, readJson, writeJsonAtomic } from "../util/persistence"
import { useTheme } from "./theme"
import { useToast } from "../ui/toast"
import { useRoute } from "./route"
import { usePermission } from "./permission"

export type LocalTheme = {
  secondary: RGBA
  accent: RGBA
  success: RGBA
  warning: RGBA
  primary: RGBA
  error: RGBA
  info: RGBA
}

const ModelRef = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
}).annotate({ identifier: "TuiLocal.ModelRef" })

// model.json keeps the recent and favorite models and the selected variant for each model.
const ModelState = Schema.Struct({
  recent: Schema.optional(Schema.mutable(Schema.Array(ModelRef))),
  favorite: Schema.optional(Schema.mutable(Schema.Array(ModelRef))),
  variant: Schema.optional(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))),
}).annotate({ identifier: "TuiLocal.ModelState" })
const ModelStateFile = Schema.fromJsonString(ModelState)

// session.json keeps the pinned session IDs.
const SessionState = Schema.Struct({
  pinned: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
}).annotate({ identifier: "TuiLocal.SessionState" })
const SessionStateFile = Schema.fromJsonString(SessionState)

/** The server could not connect or disconnect an MCP server. The cause is the SDK rejection. */
class McpToggleError extends Schema.TaggedError<McpToggleError>()("TuiLocal.McpToggleError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: providerID,
    modelID: rest.join("/"),
  }
}

export function recentModels(
  model: { providerID: string; modelID: string },
  recent: { providerID: string; modelID: string }[],
) {
  // Keep the first occurrence of each model, so the given model moves to the front.
  return Array.dedupeWith([model, ...recent], (a, b) => a.providerID === b.providerID && a.modelID === b.modelID)
    .slice(0, 10)
    .map((item) => ({ providerID: item.providerID, modelID: item.modelID }))
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const theme = useTheme().theme
    const route = useRoute()
    const paths = useTuiPaths()
    const args = useArgs()
    const event = useEvent()
    const permission = usePermission()

    // The theme proxy forwards `in` to a theme object, so its own keys are the theme entry names.
    function isThemeKey(key: string): key is keyof typeof theme {
      return key in theme
    }

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    // The first candidate that is present and names a valid model.
    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      return Array.findFirst(modelFns, (modelFn) => Option.filter(Option.fromNullishOr(modelFn()), isModelValid))
    }

    function createAgent() {
      const agents = createMemo(() => sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((agent) => !agent.hidden))
      // The selected agent name; none selects the first agent.
      const [currentName, setCurrentName] = createSignal(Option.none<string>(), {
        equals: (previous, next) => Equal.equals(previous, next),
      })
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return Option.flatMap(currentName(), (name) => Array.findFirst(agents(), (x) => x.name === name)).pipe(
            Option.getOrElse(() => agents().at(0)),
          )
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setCurrentName(Option.some(name))
        },
        move(direction: 1 | -1) {
          batch(() => {
            const current = this.current()
            if (!current) return
            let next = agents().findIndex((x) => x.name === current.name) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setCurrentName(Option.some(value.name))
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // Config validates the theme color name; a name that is not a theme color uses the palette.
            if (isThemeKey(color)) {
              const value = theme[color]
              if (value instanceof RGBA) return value
            }
          }
          return colors()[index % colors().length]
        },
      }
    }

    const agent = createAgent()

    function createModel() {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(paths.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Effect.runFork(
          writeJsonAtomic(filePath, ModelStateFile, {
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            variant: modelStore.variant,
          }).pipe(
            Effect.catchCause((cause) => Effect.logError("Failed to write model state", cause)),
            Effect.provide(fileSystemLayer),
          ),
        )
      }

      // A missing or invalid model.json leaves the defaults in place.
      Effect.runFork(
        readJson(filePath, ModelStateFile).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (value.recent) setModelStore("recent", value.recent)
              if (value.favorite) setModelStore("favorite", value.favorite)
              if (value.variant) setModelStore("variant", value.variant)
            }),
          ),
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              setModelStore("ready", true)
              if (state.pending) save()
            }),
          ),
          Effect.provide(fileSystemLayer),
        ),
      )

      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return Option.getOrUndefined(
          getFirstValidModel(
            () => a && modelStore.model[a.name],
            () => a && a.model,
            fallbackModel,
          ),
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((item) => item.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          const a = agent.current()
          if (!a) return
          setModelStore("model", a.name, { ...next })
          setModelStore("recent", recentModels(next, modelStore.recent))
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const a = agent.current()
            if (!a) return
            setModelStore("model", a.name, model)
            if (options?.recent) {
              setModelStore("recent", recentModels(model, modelStore.recent))
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((item) => item.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              // set stores "default" for a missing value, which clears the variant.
              this.set("default")
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    }

    const model = createModel()

    function createSession() {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const filePath = path.join(paths.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Effect.runFork(
          writeJsonAtomic(filePath, SessionStateFile, { pinned: sessionStore.pinned }).pipe(
            Effect.catchCause((cause) => Effect.logError("Failed to write session state", cause)),
            Effect.provide(fileSystemLayer),
          ),
        )
      }

      // A missing or invalid session.json leaves no pinned sessions.
      Effect.runFork(
        readJson(filePath, SessionStateFile).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              if (value.pinned) setSessionStore("pinned", value.pinned)
            }),
          ),
          Effect.ignore,
          Effect.ensuring(
            Effect.sync(() => {
              setSessionStore("ready", true)
              if (state.pending) save()
            }),
          ),
          Effect.provide(fileSystemLayer),
        ),
      )

      const slots = createMemo(() => {
        const existing = HashSet.fromIterable(
          sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id),
        )
        return sessionStore.pinned.filter((id) => HashSet.has(existing, id)).slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.info.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    }

    const session = createSession()

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      toggle(name: string) {
        return Effect.runPromise(
          Effect.gen(function* () {
            const status = sync.data.mcp[name]
            if (status?.status === "connected") {
              // Disable: disconnect the MCP
              yield* Effect.tryPromise({
                try: () => sdk.client.mcp.disconnect({ name }),
                catch: (cause) => new McpToggleError({ message: `Failed to disconnect MCP server ${name}`, cause }),
              })
              return
            }
            // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
            yield* Effect.tryPromise({
              try: () => sdk.client.mcp.connect({ name }),
              catch: (cause) => new McpToggleError({ message: `Failed to connect MCP server ${name}`, cause }),
            })
          }),
        )
      },
    }

    createEffect(() => {
      const value = agent.current()
      if (!value?.model) return
      if (isModelValid(value.model)) return
      toast.show({
        variant: "warning",
        message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
        duration: 3000,
      })
    })

    const result = {
      model,
      agent,
      mcp,
      session,
      permission,
    }
    return result
  },
})

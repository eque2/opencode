export * as Catalog from "./catalog"

import { makeLocationNode } from "./effect/app-node"
import {
  Array,
  Clock,
  Context,
  Effect,
  HashMap,
  HashSet,
  Layer,
  MutableHashMap,
  Option,
  Order,
  pipe,
  Schema,
} from "effect"
import { Catalog } from "@opencode-ai/schema/catalog"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"
import { EventV2 } from "./event"
import { Policy } from "./policy"
import { State } from "./state"
import { Integration } from "./integration"

export type ProviderRecord = {
  provider: ProviderV2.MutableInfo
  models: Map<ModelV2.ID, ModelV2.MutableInfo>
}

export type DefaultModel = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

export const PolicyActions = Schema.Literals(["provider.use"])

export const Event = Catalog.Event

type Data = {
  providers: MutableHashMap.MutableHashMap<ProviderV2.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Draft = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: ProviderV2.ID) => ProviderRecord | undefined
    update: (providerID: ProviderV2.ID, fn: (provider: ProviderV2.MutableInfo) => void) => void
    remove: (providerID: ProviderV2.ID) => void
  }
  model: {
    get: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => ModelV2.Info | undefined
    update: (providerID: ProviderV2.ID, modelID: ModelV2.ID, fn: (model: ModelV2.MutableInfo) => void) => void
    remove: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => void
    }
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly provider: {
    readonly get: (providerID: ProviderV2.ID) => Effect.Effect<ProviderV2.Info | undefined>
    readonly all: () => Effect.Effect<ProviderV2.Info[]>
    readonly available: () => Effect.Effect<ProviderV2.Info[]>
  }
  readonly model: {
    readonly get: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<ModelV2.Info | undefined>
    readonly all: () => Effect.Effect<ModelV2.Info[]>
    readonly available: () => Effect.Effect<ModelV2.Info[]>
    readonly default: () => Effect.Effect<ModelV2.Info | undefined>
    readonly small: (providerID: ProviderV2.ID) => Effect.Effect<ModelV2.Info | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Catalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const policy = yield* Policy.Service
    const integrations = yield* Integration.Service

    const available = (provider: ProviderV2.Info, integration: Option.Option<Integration.Info>) => {
      if (provider.disabled) return false
      if (typeof provider.request.body.apiKey === "string") return true
      if (Option.exists(integration, (item) => item.connections.length > 0)) return true
      return provider.integrationID === undefined && Option.isNone(integration)
    }

    const projectModel = (model: ModelV2.Info, provider: ProviderV2.Info) => {
      const api =
        model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
          ? { ...provider.api, id: model.api.id }
          : model.api.type === "aisdk" && provider.api.type === "aisdk" && !model.api.url
            ? { ...model.api, url: provider.api.url, settings: { ...provider.api.settings, ...model.api.settings } }
            : model.api.type === "aisdk" && provider.api.type === "aisdk"
              ? { ...model.api, settings: { ...provider.api.settings, ...model.api.settings } }
              : model.api
      const request = {
        headers: { ...provider.request.headers, ...model.request.headers },
        body: { ...provider.request.body, ...model.request.body },
        variant: model.request.variant,
      }
      return ModelV2.Info.make({
        id: model.id,
        providerID: model.providerID,
        ...(model.family === undefined ? {} : { family: model.family }),
        name: model.name,
        api,
        capabilities: model.capabilities,
        request,
        variants: model.variants,
        time: model.time,
        cost: model.cost,
        status: model.status,
        enabled: model.enabled,
        limit: model.limit,
      })
    }

    // A new, empty model that transforms edit in place. Model.Info types its arrays as readonly, so the
    // arrays are copied into mutable ones; the copies hold the same (empty) contents.
    const emptyModel = (providerID: ProviderV2.ID, modelID: ModelV2.ID): ModelV2.MutableInfo => {
      const model = ModelV2.Info.empty(providerID, modelID)
      return {
        ...model,
        capabilities: {
          ...model.capabilities,
          input: [...model.capabilities.input],
          output: [...model.capabilities.output],
        },
        variants: [...model.variants],
        cost: [...model.cost],
      }
    }

    const normalizeApi = (item: ProviderV2.MutableInfo | ModelV2.MutableInfo) => {
      if (typeof item.request.body.baseURL !== "string") return
      item.api.url = item.request.body.baseURL
      delete item.request.body.baseURL
    }

    const state = State.create<Data, Draft>({
      initial: () => ({ providers: MutableHashMap.empty() }),
      draft: (draft) => {
        // The record for a provider, created empty the first time a transform touches it.
        const providerRecord = (providerID: ProviderV2.ID) => {
          const existing = MutableHashMap.get(draft.providers, providerID)
          if (Option.isSome(existing)) return existing.value
          const created: ProviderRecord = {
            provider: ProviderV2.Info.empty(providerID) as ProviderV2.MutableInfo,
            // eslint-disable-next-line effect/no-map-use-hashmap -- (a) @opencode-ai/plugin CatalogProviderRecord.models is a ReadonlyMap; plugins call has/get/values on this live draft record
            models: new Map<ModelV2.ID, ModelV2.MutableInfo>(),
          }
          MutableHashMap.set(draft.providers, providerID, created)
          return created
        }
        const result: Draft = {
          provider: {
            list: () => Array.fromIterable(MutableHashMap.values(draft.providers)),
            get: (providerID) => Option.getOrUndefined(MutableHashMap.get(draft.providers, providerID)),
            update: (providerID, fn) => {
              const current = providerRecord(providerID)
              fn(current.provider)
              normalizeApi(current.provider)
            },
            remove: (providerID) => {
              MutableHashMap.remove(draft.providers, providerID)
            },
          },
          model: {
            get: (providerID, modelID) =>
              Option.getOrUndefined(
                MutableHashMap.get(draft.providers, providerID).pipe(
                  Option.flatMapNullishOr((record) => record.models.get(modelID)),
                ),
              ),
            update: (providerID, modelID, fn) => {
              const record = providerRecord(providerID)
              const model = record.models.get(modelID) ?? emptyModel(providerID, modelID)
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
              normalizeApi(model)
            },
            remove: (providerID, modelID) => {
              const record = MutableHashMap.get(draft.providers, providerID)
              if (Option.isSome(record)) record.value.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("CatalogV2.finalize")(function* (catalog) {
        if (policy.hasStatements()) {
          for (const record of catalog.provider.list()) {
            if ((yield* policy.evaluate("provider.use", record.provider.id, "allow")) === "deny") {
              catalog.provider.remove(record.provider.id)
            }
          }
        }
        yield* events.publish(Event.Updated, {})
      }),
    })
    // A cheap, recent text model of the provider, for small tasks such as titles and summaries.
    const smallModel = (
      record: ProviderRecord,
      providerID: ProviderV2.ID,
      now: number,
    ): Option.Option<ModelV2.Info> => {
      const provider = record.provider

      // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
      if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
        return Option.none()
      }

      if (providerID === ProviderV2.ID.opencode) {
        const gpt5Nano = record.models.get(ModelV2.ID.make("gpt-5-nano"))
        if (gpt5Nano?.enabled && gpt5Nano.status === "active") return Option.some(projectModel(gpt5Nano, provider))
      }

      const candidates = pipe(
        Array.fromIterable(record.models.values()),
        Array.filter(
          (model) =>
            model.providerID === providerID &&
            model.enabled &&
            model.status === "active" &&
            model.capabilities.input.some((item) => item.startsWith("text")) &&
            model.capabilities.output.some((item) => item.startsWith("text")),
        ),
        Array.map((model) => ({
          model,
          cost: model.cost[0] ? model.cost[0].input + model.cost[0].output : 999,
          age: (now - model.time.released) / (1000 * 60 * 60 * 24 * 30),
          small: SMALL_MODEL_RE.test(`${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()),
        })),
        Array.filter((item) => item.cost > 0 && item.age <= 18),
      )

      const pick = (items: typeof candidates) => {
        const maxCost = Math.max(...items.map((item) => item.cost), 0.01)
        const maxAge = Math.max(...items.map((item) => item.age), 0.01)
        return Array.head(
          Array.sortWith(items, (item) => (item.cost / maxCost) * 0.8 + (item.age / maxAge) * 0.2, Order.Number),
        ).pipe(Option.map((item) => projectModel(item.model, provider)))
      }

      const small = candidates.filter((item) => item.small)
      return pick(small.length > 0 ? small : candidates)
    }

    const result: Interface = {
      transform: state.transform,
      reload: state.reload,

      provider: {
        get: Effect.fn("CatalogV2.provider.get")(function* (providerID) {
          return Option.getOrUndefined(
            Option.map(MutableHashMap.get(state.get().providers, providerID), (record) => record.provider),
          )
        }),

        all: Effect.fn("CatalogV2.provider.all")(function* () {
          return Array.fromIterable(MutableHashMap.values(state.get().providers)).map((record) => record.provider)
        }),

        available: Effect.fn("CatalogV2.provider.available")(function* () {
          const active = HashMap.fromIterable(
            (yield* integrations.list()).map((integration): [Integration.ID, Integration.Info] => [
              integration.id,
              integration,
            ]),
          )
          return (yield* result.provider.all()).filter((provider) =>
            available(provider, HashMap.get(active, provider.integrationID ?? Integration.ID.make(provider.id))),
          )
        }),
      },

      model: {
        get: Effect.fn("CatalogV2.model.get")(function* (providerID, modelID) {
          return Option.getOrUndefined(
            MutableHashMap.get(state.get().providers, providerID).pipe(
              Option.flatMap((record) =>
                Option.map(Option.fromUndefinedOr(record.models.get(modelID)), (model) =>
                  projectModel(model, record.provider),
                ),
              ),
            ),
          )
        }),

        all: Effect.fn("CatalogV2.model.all")(function* () {
          return pipe(
            Array.fromIterable(MutableHashMap.values(state.get().providers)),
            Array.flatMap((record) => {
              return Array.fromIterable(record.models.values()).map((model) => projectModel(model, record.provider))
            }),
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("CatalogV2.model.available")(function* () {
          const providers = HashSet.fromIterable((yield* result.provider.available()).map((provider) => provider.id))
          return (yield* result.model.all()).filter(
            (model) => HashSet.has(providers, model.providerID) && model.enabled,
          )
        }),

        default: Effect.fn("CatalogV2.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const provider = yield* result.provider.get(defaultModel.providerID)
            if (provider && (yield* result.provider.available()).some((item) => item.id === provider.id)) {
              const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID)
              if (model?.enabled) return model
            }
          }

          return Option.getOrUndefined(
            pipe(
              yield* result.model.available(),
              Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
              Array.head,
            ),
          )
        }),

        small: Effect.fn("CatalogV2.model.small")(function* (providerID) {
          const now = yield* Clock.currentTimeMillis
          return Option.getOrUndefined(
            MutableHashMap.get(state.get().providers, providerID).pipe(
              Option.flatMap((record) => smallModel(record, providerID, now)),
            ),
          )
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/

export const locationLayer = layer.pipe(
  Layer.provideMerge(Integration.locationLayer),
  Layer.provideMerge(Policy.locationLayer),
)

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Policy.node, Integration.node] })

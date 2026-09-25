import { type Accessor, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime, Effect, HashMap, HashSet, Option } from "effect"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5
// A model counts as latest within six months of its release, with 30-day months as luxon measured them.
const LATEST_WINDOW_MS = 6 * 30 * 24 * 60 * 60 * 1000

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  gate: false,
  init: (props: { directory?: Accessor<string | undefined> }) => {
    const providers = useProviders(() => props.directory?.())

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const available = createMemo(() =>
      providers.connected().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    // The release date of each model; none when the date does not parse.
    const release = createMemo(() =>
      HashMap.fromIterable(
        available().map(
          (model) =>
            [
              modelKey({ providerID: model.provider.id, modelID: model.id }),
              DateTime.make(model.release_date),
            ] as const,
        ),
      ),
    )
    const releaseOf = (key: string) => Option.flatten(HashMap.get(release(), key))

    const latest = createMemo(() => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
      return pipe(
        available(),
        filter((x) =>
          Option.exists(
            releaseOf(modelKey({ providerID: x.provider.id, modelID: x.id })),
            (date) => Math.abs(DateTime.toEpochMillis(date) - now) < LATEST_WINDOW_MS,
          ),
        ),
        groupBy((x) => x.provider.id),
        mapValues((models) =>
          values(groupBy(models, (x) => x.family)).flatMap((g) => {
            const first = firstBy(g, [(x) => x.release_date, "desc"])
            return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
          }),
        ),
        values(),
        flat(),
      )
    })

    const latestSet = createMemo(() => HashSet.fromIterable(latest().map((x) => modelKey(x))))

    // When a model appears twice in the user list, the last entry wins, as with the Map it replaces.
    const visibility = createMemo(() =>
      HashMap.fromIterable(store.user.map((item) => [modelKey(item), item.visibility] as const)),
    )

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const state = HashMap.get(visibility(), key)
      if (Option.isSome(state)) return state.value === "show"
      if (HashSet.has(latestSet(), key)) return true
      // A model with no valid release date stays visible.
      return Option.isNone(releaseOf(key))
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    // The source reads the recent list now, so the resource tracks it, and resolves once storage is ready.
    const [recentModels] = createResource(
      () => {
        const recent = store.recent
        return Effect.runPromise(
          Option.match(Option.fromNullishOr(ready.promise), {
            onNone: () => Effect.succeed(recent),
            onSome: (promise) => Effect.promise(() => promise).pipe(Effect.as(recent)),
          }),
        )
      },
      (p) => p,
      { initialValue: [] },
    )
    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      recent: {
        list: () => recentModels(),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})

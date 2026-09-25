import type { TuiPluginApi, TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import { MutableHashMap, Option } from "effect"
import { createSignal } from "solid-js"

type RouteEntry = {
  key: symbol
  render: TuiRouteDefinition["render"]
}

export type RouteMap = MutableHashMap.MutableHashMap<string, ReadonlyArray<RouteEntry>>

export function createPluginRoutes() {
  const routes: RouteMap = MutableHashMap.empty()
  const [revision, setRevision] = createSignal(0)
  const entries = (name: string) =>
    Option.getOrElse(MutableHashMap.get(routes, name), (): ReadonlyArray<RouteEntry> => [])

  return {
    register(list: TuiRouteDefinition[]) {
      const key = Symbol()
      list.forEach((item) =>
        MutableHashMap.set(routes, item.name, [...entries(item.name), { key, render: item.render }]),
      )
      setRevision((value) => value + 1)

      return () => {
        list.forEach((item) => {
          const next = entries(item.name).filter((entry) => entry.key !== key)
          if (next.length) {
            MutableHashMap.set(routes, item.name, next)
            return
          }
          MutableHashMap.remove(routes, item.name)
        })
        setRevision((value) => value + 1)
      }
    },
    get(name: string) {
      revision()
      return entries(name).at(-1)?.render
    },
  }
}

export type PluginRoutes = ReturnType<typeof createPluginRoutes>

export function createTuiApi(input: Omit<TuiPluginApi, "lifecycle">): TuiPluginApi {
  return {
    ...input,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose() {
        return () => {}
      },
    },
  }
}

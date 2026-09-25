import { Option } from "effect"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type Route = HomeRoute | SessionRoute | PluginRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute).pipe(Option.getOrElse((): Route => ({ type: "home" }))),
    )

    return {
      get data() {
        return store
      },
      navigate: (route: Route) => {
        setStore(reconcile(route))
      },
    }
  },
})

function initialRoute(value: unknown): Option.Option<Route> {
  if (!value || typeof value !== "object" || !("type" in value)) return Option.none()
  if (value.type === "home") return Option.some({ type: "home" })
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return Option.some({ type: "session", sessionID: value.sessionID })
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return Option.some({ type: "plugin", id: value.id })
  }
  return Option.none()
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}

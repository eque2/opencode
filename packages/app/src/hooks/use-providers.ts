import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { HashSet, Iterable, Option } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = HashSet.fromIterable(popularProviders)

/**
 * Reads the provider catalog of a project directory.
 * An absent directory, or an empty one, reads the global catalog.
 */
export function useProviders(directory: Accessor<string | undefined>) {
  const params = useParams()
  return useProvidersIn(() => Option.fromNullishOr(directory ? directory() : decode64(params.dir)))
}

/** Reads the global provider catalog, which names no project directory. */
export function useGlobalProviders() {
  return useProvidersIn(() => Option.none())
}

/** Reads the provider catalog of `directory`. None, or an empty directory, reads the global catalog. */
export function useProvidersIn(directory: Accessor<Option.Option<string>>) {
  const serverSync = useServerSync()
  const providers = () => {
    const value = Option.filter(directory(), (dir) => dir.length > 0)
    if (Option.isNone(value)) return selectProviderCatalog({ explicit: false, global: serverSync().data.provider })
    const [projectStore] = serverSync().child(value.value)
    return selectProviderCatalog({
      explicit: true,
      directory: value.value,
      catalog: { ready: projectStore.provider_ready, providers: projectStore.provider },
    })
  }

  return {
    all: () => providers().all,
    default: () => providers().default,
    defaultModel: () => providers().defaultModel,
    popular: () =>
      providers().all.pipe(
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => HashSet.has(popularProviderSet, p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = HashSet.fromIterable(providers().connected)
      return providers().all.pipe(
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => HashSet.has(connected, p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = HashSet.fromIterable(providers().connected)
      return Array.from(
        Iterable.filter(
          providers().all,
          ([id, provider]) =>
            HashSet.has(connected, id) &&
            (id !== "opencode" || Object.values(provider.models).some((m) => m.cost?.input)),
        ),
      )
    },
  }
}

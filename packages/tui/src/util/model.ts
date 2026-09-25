import type { Provider } from "@opencode-ai/sdk/v2"
import { Option } from "effect"

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider =
    list instanceof Map
      ? Option.fromNullishOr(list.get(providerID))
      : Array.isArray(list)
        ? Option.fromNullishOr(list.find((item) => item.id === providerID))
        : Option.none()
  return Option.flatMap(provider, (item) => Option.fromNullishOr(item.models[modelID]))
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID).pipe(
    Option.flatMap((model) => Option.fromNullishOr(model.name)),
    Option.getOrElse(() => modelID),
  )
}

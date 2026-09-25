import { Predicate } from "effect"

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!Predicate.isObject(state)) return {}
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !Predicate.isObject(state.structured)) return {}
  return state.structured
}

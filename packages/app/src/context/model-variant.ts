import { Option, Predicate } from "effect"

type AgentModel = {
  providerID: string
  modelID: string
}

type Agent = {
  model?: AgentModel
  variant?: string
}

type Model = AgentModel & {
  variants?: Record<string, unknown>
}

/**
 * The user's variant choice. `None` means that nothing is chosen, `Some(None)` is an explicit "default"
 * choice, and `Some(Some(name))` chooses the variant `name`.
 */
export type VariantSelection = Option.Option<Option.Option<string>>

/**
 * Decodes a saved variant. The saved state keeps JSON null for an explicit "default" choice and leaves the
 * value out when nothing is chosen.
 */
export const decodeVariantSelection = (saved: string | null | undefined): VariantSelection =>
  Predicate.isUndefined(saved) ? Option.none() : Option.some(Option.fromNullOr(saved))

type VariantInput = {
  variants: string[]
  selected: VariantSelection
  configured?: string
}

const isExplicitDefault = (input: VariantInput) => Option.exists(input.selected, Option.isNone)

const chosenVariant = (input: VariantInput) =>
  Option.filter(Option.flatten(input.selected), (name) => !!name && input.variants.includes(name))

export function getConfiguredAgentVariant(input: { agent: Agent | undefined; model: Model | undefined }) {
  if (!input.agent?.variant) return undefined
  if (!input.agent.model) return undefined
  if (!input.model?.variants) return undefined
  if (input.agent.model.providerID !== input.model.providerID) return undefined
  if (input.agent.model.modelID !== input.model.modelID) return undefined
  if (!(input.agent.variant in input.model.variants)) return undefined
  return input.agent.variant
}

export function resolveModelVariant(input: VariantInput) {
  if (isExplicitDefault(input)) return undefined
  const selected = chosenVariant(input)
  if (Option.isSome(selected)) return selected.value
  if (input.configured && input.variants.includes(input.configured)) return input.configured
  return undefined
}

export function cycleModelVariant(input: VariantInput) {
  if (input.variants.length === 0) return undefined
  if (isExplicitDefault(input)) return input.variants[0]
  const selected = chosenVariant(input)
  if (Option.isSome(selected)) {
    const index = input.variants.indexOf(selected.value)
    if (index === input.variants.length - 1) return undefined
    return input.variants[index + 1]
  }
  if (input.configured && input.variants.includes(input.configured)) {
    const index = input.variants.indexOf(input.configured)
    if (index === input.variants.length - 1) return input.variants[0]
    return input.variants[index + 1]
  }
  return input.variants[0]
}

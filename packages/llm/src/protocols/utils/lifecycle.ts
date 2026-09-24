import { Array as Arr } from "effect"
import { LLMEvent, type FinishReason, type ProviderMetadata, type Usage } from "../../schema"

/**
 * Step and block bookkeeping shared by the protocol stream parsers.
 *
 * `text` and `reasoning` hold the ids of the open blocks in the order they
 * opened. `finish` closes the open blocks in that order, so the ids live in
 * insertion-ordered arrays and not in a hash-ordered set.
 */
export interface State {
  readonly stepStarted: boolean
  readonly text: ReadonlyArray<string>
  readonly reasoning: ReadonlyArray<string>
}

export const initial = (): State => ({ stepStarted: false, text: [], reasoning: [] })

/** Whether the reasoning block `id` is open. */
export const isReasoningOpen = (state: State, id: string): boolean => Arr.contains(state.reasoning, id)

const isTextOpen = (state: State, id: string): boolean => Arr.contains(state.text, id)

export const stepStart = (state: State, events: LLMEvent[]): State => {
  if (state.stepStarted) return state
  events.push(LLMEvent.stepStart({ index: 0 }))
  return { ...state, stepStarted: true }
}

export const textDelta = (state: State, events: LLMEvent[], id: string, text: string): State => {
  const stepped = stepStart(state, events)
  if (isTextOpen(stepped, id)) {
    events.push(LLMEvent.textDelta({ id, text }))
    return stepped
  }
  events.push(LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text }))
  return { ...stepped, text: Arr.append(stepped.text, id) }
}

export const reasoningStart = (
  state: State,
  events: LLMEvent[],
  id: string,
  providerMetadata?: ProviderMetadata,
): State => {
  if (isReasoningOpen(state, id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.reasoningStart({ id, providerMetadata }))
  return { ...stepped, reasoning: Arr.append(stepped.reasoning, id) }
}

export const reasoningDelta = (
  state: State,
  events: LLMEvent[],
  id: string,
  text: string,
  providerMetadata?: ProviderMetadata,
): State => {
  const started = reasoningStart(state, events, id, providerMetadata)
  events.push(LLMEvent.reasoningDelta({ id, text }))
  return started
}

export const reasoningEnd = (
  state: State,
  events: LLMEvent[],
  id: string,
  providerMetadata?: ProviderMetadata,
): State => {
  if (!isReasoningOpen(state, id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.reasoningEnd({ id, providerMetadata }))
  return { ...stepped, reasoning: Arr.filter(stepped.reasoning, (open) => open !== id) }
}

export const textEnd = (state: State, events: LLMEvent[], id: string, providerMetadata?: ProviderMetadata): State => {
  if (!isTextOpen(state, id)) return state
  const stepped = stepStart(state, events)
  events.push(LLMEvent.textEnd({ id, providerMetadata }))
  return { ...stepped, text: Arr.filter(stepped.text, (open) => open !== id) }
}

const closeOpenBlocks = (state: State, events: LLMEvent[]): State => {
  for (const id of state.reasoning) events.push(LLMEvent.reasoningEnd({ id }))
  for (const id of state.text) events.push(LLMEvent.textEnd({ id }))
  return { ...state, text: [], reasoning: [] }
}

export const finish = (
  state: State,
  events: LLMEvent[],
  input: {
    readonly reason: FinishReason
    readonly usage?: Usage
    readonly providerMetadata?: ProviderMetadata
  },
): State => {
  const stepped = closeOpenBlocks(stepStart(state, events), events)
  events.push(
    LLMEvent.stepFinish({
      index: 0,
      reason: input.reason,
      usage: input.usage,
      providerMetadata: input.providerMetadata,
    }),
    LLMEvent.finish(input),
  )
  return { ...stepped, stepStarted: false }
}

export * as Lifecycle from "./lifecycle"

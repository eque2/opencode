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

/**
 * One pure lifecycle transition: the next state and the events it emits, in
 * emission order. It has the same shape as a protocol step result.
 */
export type Transition = readonly [State, ReadonlyArray<LLMEvent>]

export const initial = (): State => ({ stepStarted: false, text: [], reasoning: [] })

/** Keep the state and emit no events. */
export const unchanged = (state: State): Transition => [state, []]

/**
 * Run `next` on the state that `transition` produced. The result emits the
 * events of `transition` first, then the events of `next`.
 */
export const andThen = (transition: Transition, next: (state: State) => Transition): Transition => {
  const [state, events] = transition
  const [nextState, nextEvents] = next(state)
  return [nextState, Arr.appendAll(events, nextEvents)]
}

/** Whether the reasoning block `id` is open. */
export const isReasoningOpen = (state: State, id: string): boolean => Arr.contains(state.reasoning, id)

const isTextOpen = (state: State, id: string): boolean => Arr.contains(state.text, id)

export const stepStart = (state: State): Transition =>
  state.stepStarted ? [state, []] : [{ ...state, stepStarted: true }, [LLMEvent.stepStart({ index: 0 })]]

/**
 * Emit provider events inside the current step. A non-empty list starts the
 * step first. An empty list keeps the state and emits nothing.
 */
export const emit = (state: State, events: ReadonlyArray<LLMEvent>): Transition =>
  events.length === 0 ? [state, events] : andThen(stepStart(state), (stepped) => [stepped, events])

export const textDelta = (state: State, id: string, text: string): Transition => {
  const [stepped, started] = stepStart(state)
  if (isTextOpen(stepped, id)) return [stepped, Arr.append(started, LLMEvent.textDelta({ id, text }))]
  return [
    { ...stepped, text: Arr.append(stepped.text, id) },
    Arr.appendAll(started, [LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text })]),
  ]
}

export const reasoningStart = (state: State, id: string, providerMetadata?: ProviderMetadata): Transition => {
  if (isReasoningOpen(state, id)) return unchanged(state)
  const [stepped, started] = stepStart(state)
  return [
    { ...stepped, reasoning: Arr.append(stepped.reasoning, id) },
    Arr.append(started, LLMEvent.reasoningStart({ id, providerMetadata })),
  ]
}

export const reasoningDelta = (
  state: State,
  id: string,
  text: string,
  providerMetadata?: ProviderMetadata,
): Transition => {
  const [started, events] = reasoningStart(state, id, providerMetadata)
  return [started, Arr.append(events, LLMEvent.reasoningDelta({ id, text }))]
}

export const reasoningEnd = (state: State, id: string, providerMetadata?: ProviderMetadata): Transition => {
  if (!isReasoningOpen(state, id)) return unchanged(state)
  const [stepped, started] = stepStart(state)
  return [
    { ...stepped, reasoning: Arr.filter(stepped.reasoning, (open) => open !== id) },
    Arr.append(started, LLMEvent.reasoningEnd({ id, providerMetadata })),
  ]
}

export const textEnd = (state: State, id: string, providerMetadata?: ProviderMetadata): Transition => {
  if (!isTextOpen(state, id)) return unchanged(state)
  const [stepped, started] = stepStart(state)
  return [
    { ...stepped, text: Arr.filter(stepped.text, (open) => open !== id) },
    Arr.append(started, LLMEvent.textEnd({ id, providerMetadata })),
  ]
}

// Close reasoning blocks before text blocks, each in the order they opened.
const closeOpenBlocks = (state: State): Transition => [
  { ...state, text: [], reasoning: [] },
  Arr.appendAll(
    Arr.map(state.reasoning, (id) => LLMEvent.reasoningEnd({ id })),
    Arr.map(state.text, (id) => LLMEvent.textEnd({ id })),
  ),
]

export const finish = (
  state: State,
  input: {
    readonly reason: FinishReason
    readonly usage?: Usage
    readonly providerMetadata?: ProviderMetadata
  },
): Transition => {
  const [closed, events] = andThen(stepStart(state), closeOpenBlocks)
  return [
    { ...closed, stepStarted: false },
    Arr.appendAll(events, [
      LLMEvent.stepFinish({
        index: 0,
        reason: input.reason,
        usage: input.usage,
        providerMetadata: input.providerMetadata,
      }),
      LLMEvent.finish(input),
    ]),
  ]
}

export * as Lifecycle from "./lifecycle"

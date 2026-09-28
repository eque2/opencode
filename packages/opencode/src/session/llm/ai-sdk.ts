import { FinishReason, LLMEvent, ToolResultValue, type ProviderMetadata } from "@opencode-ai/llm"
import { Effect, Option, Predicate, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { ProviderError } from "@/provider/error"
import { LLMJson } from "./json"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: Option.none<string>(),
    currentReasoningID: Option.none<string>(),
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: Option.none<number>(),
  }
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

// AI SDK metadata values may hold undefined-valued keys, which the LLM JSON schemas reject; keep their wire form.
function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (!isRecord(value)) return undefined
  return LLMJson.objectEntries(value)
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown): Option.Option<number> {
  if (!isRecord(value)) return Option.none()
  const response = Option.liftPredicate(value.response, isRecord)
  return Option.fromNullishOr(value.copilot_usage).pipe(
    Option.orElse(() => Option.flatMapNullishOr(response, (item) => item.copilot_usage)),
    Option.filter(isRecord),
    Option.map((usage) => usage.total_nano_aiu),
    Option.filter(Predicate.isNumber),
    Option.filter((total) => Number.isFinite(total) && total >= 0),
  )
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWriteInputTokens: item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  // No usage field at all is "no usage info", not an empty usage record.
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  const current = Option.getOrElse(
    Option.orElse(Option.fromNullishOr(id), () => state.currentTextID),
    () => `text-${state.text++}`,
  )
  state.currentTextID = Option.some(current)
  return current
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  const current = Option.getOrElse(
    Option.orElse(Option.fromNullishOr(id), () => state.currentReasoningID),
    () => `reasoning-${state.reasoning++}`,
  )
  state.currentReasoningID = Option.some(current)
  return current
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      if (event.rawFinishReason === "network_error")
        return Effect.fail(new ProviderError.ResponseStreamError("Provider finish_reason: network_error"))
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata = Option.match(state.copilotTotalNanoAiu, {
          onNone: () => original,
          onSome: (totalNanoAiu) => ({
            ...original,
            copilot: {
              ...original?.copilot,
              totalNanoAiu,
            },
          }),
        })
        state.copilotTotalNanoAiu = Option.none()
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            ...("providerMetadata" in event ? { providerMetadata: providerMetadata(event.providerMetadata) } : {}),
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        return [
          LLMEvent.textStart({
            id: currentTextID(state, event.id),
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = Option.none()
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        return [
          LLMEvent.reasoningStart({
            id: currentReasoningID(state, event.id),
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = Option.none()
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            ...("providerExecuted" in event ? { providerExecuted: event.providerExecuted } : {}),
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            ...("providerExecuted" in event ? { providerExecuted: event.providerExecuted } : {}),
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = Option.orElse(copilotTotalNanoAiu(event.rawValue), () => state.copilotTotalNanoAiu)
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"

import { Array as Arr, HashSet, Option, Predicate, Schema } from "effect"
import type { LLMRequest, ReasoningEffort, TextVerbosity as TextVerbosityValue } from "../../schema"
import { ReasoningEfforts, TextVerbosity } from "../../schema"

export const OpenAIReasoningEfforts = ReasoningEfforts.filter(
  (effort): effort is Exclude<ReasoningEffort, "max"> => effort !== "max",
)
export type OpenAIReasoningEffort = (typeof OpenAIReasoningEfforts)[number]

// Mirrors OpenAI's `ResponseIncludable` union from the official SDK. Keep this
// in lockstep with `openai-node/src/resources/responses/responses.ts`.
export const OpenAIResponseIncludables = [
  "file_search_call.results",
  "web_search_call.results",
  "web_search_call.action.sources",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
  "code_interpreter_call.outputs",
  "reasoning.encrypted_content",
  "message.output_text.logprobs",
] as const
export type OpenAIResponseIncludable = (typeof OpenAIResponseIncludables)[number]
export const OpenAIServiceTiers = ["auto", "default", "flex", "priority"] as const
export type OpenAIServiceTier = (typeof OpenAIServiceTiers)[number]

const REASONING_EFFORTS = HashSet.fromIterable<string>(ReasoningEfforts)
const OPENAI_REASONING_EFFORTS = HashSet.fromIterable<string>(OpenAIReasoningEfforts)
const TEXT_VERBOSITY = HashSet.fromIterable<string>(["low", "medium", "high"])
const INCLUDABLES = HashSet.fromIterable<string>(OpenAIResponseIncludables)
const SERVICE_TIERS = HashSet.fromIterable<string>(OpenAIServiceTiers)

export const OpenAIReasoningEffort = Schema.Literals(OpenAIReasoningEfforts)
export const OpenAITextVerbosity = TextVerbosity
export const OpenAIResponseIncludable = Schema.Literals(OpenAIResponseIncludables)
export const OpenAIServiceTier = Schema.Literals(OpenAIServiceTiers)

const isAnyReasoningEffort = (effort: unknown): effort is ReasoningEffort =>
  typeof effort === "string" && HashSet.has(REASONING_EFFORTS, effort)

export const isReasoningEffort = (effort: unknown): effort is OpenAIReasoningEffort =>
  typeof effort === "string" && HashSet.has(OPENAI_REASONING_EFFORTS, effort)

const isTextVerbosity = (value: unknown): value is TextVerbosityValue =>
  typeof value === "string" && HashSet.has(TEXT_VERBOSITY, value)

const isServiceTier = (value: unknown): value is OpenAIServiceTier =>
  typeof value === "string" && HashSet.has(SERVICE_TIERS, value)

const isAutoSummary = (value: unknown): value is "auto" => value === "auto"

const isIncludable = (value: unknown): value is OpenAIResponseIncludable =>
  typeof value === "string" && HashSet.has(INCLUDABLES, value)

const options = (request: LLMRequest) => request.providerOptions?.openai

// The exported readers keep their `T | undefined` results for the protocol
// and provider callers; each one validates the raw option value as an Option
// and converts it at this boundary.
export const store = (request: LLMRequest): boolean | undefined =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.store, Predicate.isBoolean))

export const reasoningEffort = (request: LLMRequest): ReasoningEffort | undefined =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.reasoningEffort, isAnyReasoningEffort))

export const reasoningSummary = (request: LLMRequest): "auto" | undefined =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.reasoningSummary, isAutoSummary))

// Resolve the OpenAI Responses `include` field. Filters out unknown
// includable values defensively so a typo in upstream config drops the
// invalid entry instead of poisoning the wire body. An empty array (either
// passed directly or produced by filtering) is treated as "no include" and
// returns undefined so the request body omits the field entirely.
export const include = (request: LLMRequest): ReadonlyArray<OpenAIResponseIncludable> | undefined => {
  const value = options(request)?.include
  if (!Array.isArray(value)) return undefined
  return Option.getOrUndefined(Option.liftPredicate(value.filter(isIncludable), Arr.isArrayNonEmpty))
}

export const promptCacheKey = (request: LLMRequest) =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.promptCacheKey, Predicate.isString))

export const textVerbosity = (request: LLMRequest) =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.textVerbosity, isTextVerbosity))

export const serviceTier = (request: LLMRequest) =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.serviceTier, isServiceTier))

export const instructions = (request: LLMRequest) =>
  Option.getOrUndefined(Option.liftPredicate(options(request)?.instructions, Predicate.isString))

export * as OpenAIOptions from "./openai-options"

import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { Data, Option, Predicate, Schema } from "effect"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"

// Both errors abort fetch signals and cross the AI SDK stream, so they stay Error instances with
// positional constructors. MessageV2.fromError reports `name` as the wire error code.
export class HeaderTimeoutError extends Data.TaggedError("ProviderHeaderTimeoutError")<{
  readonly ms: number
  readonly message: string
}> {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(ms: number) {
    super({ ms, message: `Provider response headers timed out after ${ms}ms` })
  }
}

export class ResponseStreamError extends Data.TaggedError("ProviderResponseStreamError")<{
  readonly message: string
  readonly cause?: unknown
}> {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(options ? { message, cause: options.cause } : { message })
  }
}

type JsonObject = { readonly [key: PropertyKey]: unknown }

// Opaque provider payloads: only a few fields are read, each through a typeof check.
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// Arrays count as objects without fields, as property reads on them found nothing before.
const toObject = (value: unknown): Option.Option<JsonObject> => {
  if (Predicate.isObject(value)) return Option.some(value)
  if (Array.isArray(value)) return Option.some({})
  return Option.none()
}

const nonEmptyString = (value: unknown): Option.Option<string> =>
  typeof value === "string" && value !== "" ? Option.some(value) : Option.none()

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    // try to extract common error message fields
    const errMsg = decodeJson(e.responseBody).pipe(
      Option.flatMap(toObject),
      Option.flatMap((body) => nonEmptyString(body.message || body.error)),
    )
    if (Option.isSome(errMsg)) {
      return `${msg}: ${errMsg.value}`
    }

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown): Option.Option<JsonObject> {
  if (typeof input === "string") return decodeJson(input).pipe(Option.flatMap(toObject))
  return toObject(input)
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  return Option.getOrUndefined(streamError(input))
}

function streamError(input: unknown): Option.Option<ParsedStreamError> {
  return json(input).pipe(
    Option.map((raw) => (typeof raw.message === "string" ? Option.getOrElse(json(raw.message), () => raw) : raw)),
    Option.filter((body) => body.type === "error"),
    Option.flatMap((body) => encodeJson(body).pipe(Option.map((responseBody) => classifyStreamError(body, responseBody)))),
  )
}

function classifyStreamError(body: JsonObject, responseBody: string): ParsedStreamError {
  const error = Option.getOrElse(toObject(body.error), (): JsonObject => ({}))
  const errorMessage = typeof error.message === "string" ? Option.some(error.message) : Option.none<string>()
  switch (error.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: Option.getOrElse(errorMessage, () => "Invalid prompt."),
        isRetryable: false,
        responseBody,
      }
  }

  return {
    type: "api_error",
    message: Option.getOrElse(errorMessage, () => "Server error."),
    isRetryable: true,
    responseBody,
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const code = json(input.error.responseBody).pipe(
    Option.flatMap((body) => toObject(body.error)),
    Option.map((error) => error.code),
  )
  if (isContextOverflow(m) || input.error.statusCode === 413 || Option.contains(code, "context_length_exceeded")) {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    ...(input.error.url ? { metadata: { url: input.error.url } } : {}),
  }
}

export * as ProviderError from "./error"

import { Option, Schema } from "effect"
import { ModelID, ProviderID, ProviderMetadata, RouteID } from "./ids"

export const ProviderFailureClassification = Schema.Literal("context-overflow")
export type ProviderFailureClassification = typeof ProviderFailureClassification.Type

export class HttpRequestDetails extends Schema.Class<HttpRequestDetails>("LLM.HttpRequestDetails")({
  method: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpResponseDetails extends Schema.Class<HttpResponseDetails>("LLM.HttpResponseDetails")({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpRateLimitDetails extends Schema.Class<HttpRateLimitDetails>("LLM.HttpRateLimitDetails")({
  retryAfterMs: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  remaining: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reset: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class HttpContext extends Schema.Class<HttpContext>("LLM.HttpContext")({
  request: HttpRequestDetails,
  response: Schema.optional(HttpResponseDetails),
  body: Schema.optional(Schema.String),
  bodyTruncated: Schema.optional(Schema.Boolean),
  requestId: Schema.optional(Schema.String),
  rateLimit: Schema.optional(HttpRateLimitDetails),
}) {}

export class InvalidRequestReason extends Schema.TaggedClass<InvalidRequestReason>("LLM.Error.InvalidRequest")(
  "InvalidRequest",
  {
    message: Schema.String,
    parameter: Schema.optional(Schema.String),
    classification: Schema.optional(ProviderFailureClassification),
    providerMetadata: Schema.optional(ProviderMetadata),
    http: Schema.optional(HttpContext),
  },
) {
  get retryable() {
    return false
  }
}

export class NoRouteReason extends Schema.TaggedClass<NoRouteReason>("LLM.Error.NoRoute")("NoRoute", {
  route: RouteID,
  provider: ProviderID,
  model: ModelID,
}) {
  get retryable() {
    return false
  }

  get message() {
    return `No LLM route for ${this.provider}/${this.model} using ${this.route}`
  }
}

export class AuthenticationReason extends Schema.TaggedClass<AuthenticationReason>("LLM.Error.Authentication")(
  "Authentication",
  {
    message: Schema.String,
    kind: Schema.Literals(["missing", "invalid", "expired", "insufficient-permissions", "unknown"]),
    providerMetadata: Schema.optional(ProviderMetadata),
    http: Schema.optional(HttpContext),
  },
) {
  get retryable() {
    return false
  }
}

export class RateLimitReason extends Schema.TaggedClass<RateLimitReason>("LLM.Error.RateLimit")("RateLimit", {
  message: Schema.String,
  retryAfterMs: Schema.optional(Schema.Number),
  rateLimit: Schema.optional(HttpRateLimitDetails),
  providerMetadata: Schema.optional(ProviderMetadata),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return true
  }
}

export class QuotaExceededReason extends Schema.TaggedClass<QuotaExceededReason>("LLM.Error.QuotaExceeded")(
  "QuotaExceeded",
  {
    message: Schema.String,
    providerMetadata: Schema.optional(ProviderMetadata),
    http: Schema.optional(HttpContext),
  },
) {
  get retryable() {
    return false
  }
}

export class ContentPolicyReason extends Schema.TaggedClass<ContentPolicyReason>("LLM.Error.ContentPolicy")(
  "ContentPolicy",
  {
    message: Schema.String,
    providerMetadata: Schema.optional(ProviderMetadata),
    http: Schema.optional(HttpContext),
  },
) {
  get retryable() {
    return false
  }
}

export class ProviderInternalReason extends Schema.TaggedClass<ProviderInternalReason>("LLM.Error.ProviderInternal")(
  "ProviderInternal",
  {
    message: Schema.String,
    status: Schema.Number,
    retryAfterMs: Schema.optional(Schema.Number),
    providerMetadata: Schema.optional(ProviderMetadata),
    http: Schema.optional(HttpContext),
  },
) {
  get retryable() {
    return true
  }
}

export class TransportReason extends Schema.TaggedClass<TransportReason>("LLM.Error.Transport")("Transport", {
  message: Schema.String,
  kind: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
}) {
  get retryable() {
    return false
  }
}

export class InvalidProviderOutputReason extends Schema.TaggedClass<InvalidProviderOutputReason>(
  "LLM.Error.InvalidProviderOutput",
)("InvalidProviderOutput", {
  message: Schema.String,
  route: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.String),
  providerMetadata: Schema.optional(ProviderMetadata),
}) {
  get retryable() {
    return false
  }
}

export class UnknownProviderReason extends Schema.TaggedClass<UnknownProviderReason>("LLM.Error.UnknownProvider")(
  "UnknownProvider",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    providerMetadata: Schema.optional(ProviderMetadata),
    http: Schema.optional(HttpContext),
  },
) {
  get retryable() {
    return false
  }
}

export const LLMErrorReason = Schema.Union([
  InvalidRequestReason,
  NoRouteReason,
  AuthenticationReason,
  RateLimitReason,
  QuotaExceededReason,
  ContentPolicyReason,
  ProviderInternalReason,
  TransportReason,
  InvalidProviderOutputReason,
  UnknownProviderReason,
]).pipe(Schema.toTaggedUnion("_tag"))
export type LLMErrorReason = Schema.Schema.Type<typeof LLMErrorReason>

/** Provider-requested retry delay; only rate-limit and provider-internal reasons carry one. */
const reasonRetryAfterMs = (reason: LLMErrorReason): Option.Option<number> =>
  "retryAfterMs" in reason ? Option.fromUndefinedOr(reason.retryAfterMs) : Option.none()

export class LLMError extends Schema.TaggedError<LLMError>()("LLM.Error", {
  module: Schema.String,
  method: Schema.String,
  reason: LLMErrorReason,
}) {
  override readonly cause = this.reason

  get retryable() {
    return this.reason.retryable
  }

  get retryAfterMs() {
    return Option.getOrUndefined(reasonRetryAfterMs(this.reason))
  }

  override get message() {
    return `${this.module}.${this.method}: ${this.reason.message}`
  }
}

/**
 * Failure type for tool execute handlers. Handlers must map their internal
 * errors to this shape; the runtime catches `ToolFailure`s and surfaces them
 * as `tool-error` events plus a `tool-result` of `type: "error"` so the model
 * can self-correct.
 *
 * Anything thrown or yielded by a handler that is not a `ToolFailure` is
 * treated as a defect and fails the stream.
 */
export class ToolFailure extends Schema.TaggedError<ToolFailure>()("LLM.ToolFailure", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.JsonObject),
}) {}

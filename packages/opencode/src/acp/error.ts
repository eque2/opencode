import { RequestError } from "@agentclientprotocol/sdk"
import { Schema } from "effect"

// ACP clients send these ids on the wire. The brands name the domain of each
// id. They do not claim that the id exists or that it is valid.
export const RequestedSessionId = Schema.String.pipe(Schema.brand("ACPRequestedSessionId"))
export const RequestedConfigId = Schema.String.pipe(Schema.brand("ACPRequestedConfigId"))
export const RequestedModelId = Schema.String.pipe(Schema.brand("ACPRequestedModelId"))
export const RequestedAuthMethodId = Schema.String.pipe(Schema.brand("ACPRequestedAuthMethodId"))

export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()("ACPSessionNotFoundError", {
  sessionId: RequestedSessionId,
}) {}

export class InvalidConfigOptionError extends Schema.TaggedError<InvalidConfigOptionError>()(
  "ACPInvalidConfigOptionError",
  {
    configId: RequestedConfigId,
  },
) {}

export class InvalidModelError extends Schema.TaggedError<InvalidModelError>()("ACPInvalidModelError", {
  modelId: RequestedModelId,
  providerId: Schema.optional(Schema.String),
}) {}

export class InvalidEffortError extends Schema.TaggedError<InvalidEffortError>()("ACPInvalidEffortError", {
  effort: Schema.String,
}) {}

export class InvalidModeError extends Schema.TaggedError<InvalidModeError>()("ACPInvalidModeError", {
  mode: Schema.String,
}) {}

export class AuthRequiredError extends Schema.TaggedError<AuthRequiredError>()("ACPAuthRequiredError", {
  providerId: Schema.optional(Schema.String),
}) {}

export class UnknownAuthMethodError extends Schema.TaggedError<UnknownAuthMethodError>()("ACPUnknownAuthMethodError", {
  methodId: RequestedAuthMethodId,
}) {}

export class UnsupportedOperationError extends Schema.TaggedError<UnsupportedOperationError>()(
  "ACPUnsupportedOperationError",
  {
    method: Schema.String,
  },
) {}

export class ServiceFailureError extends Schema.TaggedError<ServiceFailureError>()("ACPServiceFailureError", {
  safeMessage: Schema.String,
  service: Schema.optional(Schema.String),
  errorName: Schema.optional(Schema.String),
}) {}

export type Error =
  | SessionNotFoundError
  | InvalidConfigOptionError
  | InvalidModelError
  | InvalidEffortError
  | InvalidModeError
  | AuthRequiredError
  | UnknownAuthMethodError
  | UnsupportedOperationError
  | ServiceFailureError

export function toRequestError(error: Error) {
  switch (error._tag) {
    case "ACPSessionNotFoundError":
      return RequestError.invalidParams({ sessionId: error.sessionId }, `session not found: ${error.sessionId}`)
    case "ACPInvalidConfigOptionError":
      return RequestError.invalidParams({ configId: error.configId }, `unknown config option: ${error.configId}`)
    case "ACPInvalidModelError":
      return RequestError.invalidParams(
        { providerId: error.providerId, modelId: error.modelId },
        `model not found: ${error.modelId}`,
      )
    case "ACPInvalidEffortError":
      return RequestError.invalidParams({ effort: error.effort }, `effort not found: ${error.effort}`)
    case "ACPInvalidModeError":
      return RequestError.invalidParams({ mode: error.mode }, `mode not found: ${error.mode}`)
    case "ACPAuthRequiredError":
      return RequestError.authRequired({ providerId: error.providerId }, "provider authentication required")
    case "ACPUnknownAuthMethodError":
      return RequestError.invalidParams({ methodId: error.methodId }, `unknown auth method: ${error.methodId}`)
    case "ACPUnsupportedOperationError":
      return RequestError.methodNotFound(error.method)
  }
  // The switch narrows the remaining case to ServiceFailureError.
  return RequestError.internalError(
    {
      ...(error.service ? { service: error.service } : {}),
      ...(error.errorName ? { errorName: error.errorName } : {}),
    },
    error.safeMessage,
  )
}

export function fromUnknownDefect(_defect: unknown, safeMessage = "Internal service failure") {
  return new ServiceFailureError({ safeMessage })
}

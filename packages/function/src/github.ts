import { Effect, Schema } from "effect"
import type { JWTPayload } from "jose"

export class RepositoryClaimError extends Schema.TaggedError<RepositoryClaimError>()("RepositoryClaimError", {
  message: Schema.String,
}) {}

export function parseRepositoryClaim(
  payload: JWTPayload,
): Effect.Effect<{ owner: string; repo: string }, RepositoryClaimError> {
  const claim = payload.repository
  if (typeof claim !== "string")
    return Effect.fail(new RepositoryClaimError({ message: "Repository claim is missing" }))

  const parts = claim.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1])
    return Effect.fail(new RepositoryClaimError({ message: "Repository claim is invalid" }))

  return Effect.succeed({
    owner: parts[0],
    repo: parts[1],
  })
}

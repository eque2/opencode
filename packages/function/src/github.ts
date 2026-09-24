import { Schema } from "effect"
import type { JWTPayload } from "jose"

export class RepositoryClaimError extends Schema.TaggedError<RepositoryClaimError>()("RepositoryClaimError", {
  message: Schema.String,
}) {}

export function parseRepositoryClaim(payload: JWTPayload) {
  const claim = payload.repository
  if (typeof claim !== "string") throw new RepositoryClaimError({ message: "Repository claim is missing" })

  const parts = claim.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new RepositoryClaimError({ message: "Repository claim is invalid" })

  return {
    owner: parts[0],
    repo: parts[1],
  }
}

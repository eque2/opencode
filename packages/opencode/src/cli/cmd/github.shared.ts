import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Array as Arr, Effect, Option, Schema } from "effect"

export { parseGitHubRemote } from "@/util/repository"

/** Raised when the assistant returned no response parts at all. */
export class GithubResponseError extends Schema.TaggedError<GithubResponseError>()("GithubResponseError", {
  message: Schema.String,
}) {}

/**
 * Extracts displayable text from assistant response parts.
 * Succeeds with none for non-text responses (signals summary needed).
 * Fails only for truly empty responses.
 */
export function extractResponseText(
  parts: ReadonlyArray<SessionV1.Part>,
): Effect.Effect<Option.Option<string>, GithubResponseError> {
  const textPart = Arr.findLast(parts, (p): p is SessionV1.TextPart => p.type === "text")
  if (Option.isSome(textPart)) return Effect.succeed(Option.some(textPart.value.text))

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return Effect.succeed(Option.none())

  return Effect.fail(new GithubResponseError({ message: "Failed to parse response: no parts returned" }))
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: ReadonlyArray<{ filename: string; content: string }>): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}

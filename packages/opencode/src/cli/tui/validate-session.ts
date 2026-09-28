import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { SessionID } from "@/session/schema"
import { errorMessage } from "@/util/error"
import { Effect, Schema } from "effect"

/** The --session value is not a valid session ID. */
export class InvalidSessionIDError extends Schema.TaggedError<InvalidSessionIDError>()("InvalidSessionIDError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** The server could not load the session. The message is the SDK error message. */
export class SessionLookupError extends Schema.TaggedError<SessionLookupError>()("SessionLookupError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type Input = {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}

/** Checks that the session in `sessionID` exists on the server. A missing `sessionID` passes. */
export const validate = Effect.fn("Tui.validateSession")(function* (input: Input) {
  if (!input.sessionID) return
  const sessionID = yield* Schema.decodeUnknownEffect(SessionID)(input.sessionID).pipe(
    Effect.mapError((cause) => new InvalidSessionIDError({ message: `Invalid session ID: ${cause.message}`, cause })),
  )
  const client = createOpencodeClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  })
  yield* Effect.tryPromise({
    try: () => client.session.get({ sessionID }, { throwOnError: true }),
    catch: (cause) => new SessionLookupError({ message: errorMessage(cause), cause }),
  })
})

// Promise form for the attach and TUI commands, which wrap it in Effect.tryPromise, and for the SDK parity tests.
export function validateSession(input: Input): Promise<void> {
  return Effect.runPromise(validate(input))
}

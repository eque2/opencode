import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { Data, Effect, Schema } from "effect"

// Matches the exact `{ info, messages: [{ info, parts }] }` structure produced by `opencode export` CLI
export type SessionExportData = {
  info: Session
  messages: {
    info: Message
    parts: Part[]
  }[]
}

export type SessionExportClient = {
  session: {
    get: (input: { sessionID: string }) => Promise<{ data?: Session | null }>
    messages: (input: { sessionID: string }) => Promise<{ data?: SessionExportData["messages"] | null }>
  }
}

/** The server returned no session or no messages. `message` is the text that the export toast shows. */
export class SessionExportMissingError extends Data.TaggedError("App.SessionExportMissingError")<{
  readonly message: string
}> {}

/** A client request for the export rejected. `cause` is the rejection. */
export class SessionExportRequestError extends Data.TaggedError("App.SessionExportRequestError")<{
  readonly cause: unknown
}> {}

export type SessionExportFetchError = SessionExportMissingError | SessionExportRequestError

const request = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new SessionExportRequestError({ cause }) })

/** Loads the session and its messages at the same time, as the `opencode export` CLI writes them. */
export const fetchSessionExport = (input: {
  sessionID: string
  client: SessionExportClient
}): Effect.Effect<SessionExportData, SessionExportFetchError> =>
  Effect.all(
    [
      request(() => input.client.session.get({ sessionID: input.sessionID })),
      request(() => input.client.session.messages({ sessionID: input.sessionID })),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([sessionRes, messagesRes]) => {
      if (!sessionRes?.data) {
        return Effect.fail(new SessionExportMissingError({ message: `Session not found: ${input.sessionID}` }))
      }
      if (!messagesRes?.data) {
        return Effect.fail(
          new SessionExportMissingError({ message: `Failed to load messages for session: ${input.sessionID}` }),
        )
      }
      return Effect.succeed({
        info: sessionRes.data,
        messages: messagesRes.data,
      })
    }),
  )

/**
 * The error that an export failure toast describes: the rejection of a failed
 * request, or the missing-data error itself. Its message is the toast text.
 */
export const sessionExportFailureCause = (error: SessionExportFetchError): unknown =>
  error._tag === "App.SessionExportRequestError" ? error.cause : error

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${clean || session.id}.json`
}

// Writes the same text as JSON.stringify(data, null, 2).
const encodeExport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export function downloadSessionExport(filename: string, data: unknown) {
  const json = encodeExport(data)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

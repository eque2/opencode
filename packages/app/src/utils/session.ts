import type { SessionApi, SessionInfo, SessionListInput } from "@opencode-ai/client/promise"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Data, Effect, Option } from "effect"
import { withTimestampedFallback } from "./session-title"

/** A session as the server sent it. The server can leave out the title, and normalizeSessionInfo supplies one. */
export type RawSessionInfo = Omit<SessionInfo, "title"> & { readonly title?: string }

export function normalizeSessionInfo(input: RawSessionInfo | Session): Session {
  if (!("location" in input)) return input
  return {
    id: input.id,
    slug: input.id,
    projectID: input.projectID,
    workspaceID: input.location.workspaceID,
    directory: input.location.directory,
    path: input.subpath,
    parentID: input.parentID,
    cost: input.cost,
    tokens: input.tokens,
    title: withTimestampedFallback(input),
    agent: input.agent,
    model: input.model,
    version: "",
    time: input.time,
    revert: input.revert && {
      messageID: input.revert.messageID,
      partID: input.revert.partID,
      snapshot: input.revert.snapshot,
    },
  }
}

/** A session list request that rejected. `cause` is the original rejection. */
export class SessionListError extends Data.TaggedError("App.SessionListError")<{ readonly cause: unknown }> {}

/** Loads every page of the session list, in server order. The request keeps `input` and sets the page cursor. */
export function listAllSessions(
  api: Pick<SessionApi, "list">,
  input: Omit<SessionListInput, "cursor">,
): Effect.Effect<Session[], SessionListError> {
  const load = (cursor: Option.Option<string>): Effect.Effect<Session[], SessionListError> =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () =>
          api.list({
            ...input,
            limit: input.limit ?? 100,
            ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
          }),
        catch: (cause) => new SessionListError({ cause }),
      })
      const sessions = result.data.map(normalizeSessionInfo)
      if (result.data.length === 0 || !result.cursor.next) return sessions
      return [...sessions, ...(yield* load(Option.some(result.cursor.next)))]
    })
  return load(Option.none())
}

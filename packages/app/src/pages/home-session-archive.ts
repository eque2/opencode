import { Data, Effect } from "effect"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import type { ServerConnection } from "@/context/server"

type HomeSession = {
  id: string
  directory: string
}

/** The archive request or the local cleanup after it failed. `cause` is the original error. */
export class HomeSessionArchiveError extends Data.TaggedError("App.HomeSessionArchiveError")<{
  readonly cause: unknown
}> {}

/**
 * Archives a Home session, then removes it and closes its open titlebar tabs.
 *
 * A failure goes to `onError` with the original error, and the session stays. The effect itself does not fail.
 */
export function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  archive: (sessionID: string) => Promise<unknown>
  remove: () => void
  onError?: (error: unknown) => void
}): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => input.archive(input.session.id),
    catch: (cause) => new HomeSessionArchiveError({ cause }),
  }).pipe(
    Effect.andThen(
      Effect.try({
        try: () => {
          input.remove()
          notifySessionTabsRemoved({
            server: input.server,
            directory: input.session.directory,
            sessionIDs: [input.session.id],
          })
        },
        catch: (cause) => new HomeSessionArchiveError({ cause }),
      }),
    ),
    Effect.catch((error) => Effect.sync(() => input.onError?.(error.cause))),
  )
}

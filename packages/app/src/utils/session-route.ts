import { base64Encode } from "@opencode-ai/core/util/encode"
import { Data, Effect, MutableHashSet, Option } from "effect"
import { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

export function legacySessionHref(directory: string, sessionID: string) {
  return `/${base64Encode(directory)}/session/${sessionID}`
}

/** A server route segment that is not the canonical base64 form of a server key. */
export class InvalidServerRouteError extends Data.TaggedError("App.InvalidServerRouteError")<{
  readonly message: string
}> {}

/** A session whose parent chain returns to a session already seen. */
export class SessionParentCycleError extends Data.TaggedError("App.SessionParentCycleError")<{
  readonly message: string
}> {}

// Route params are read inside Solid ErrorBoundaries, so an invalid segment throws synchronously.
export function requireServerKey(segment: string | undefined) {
  const key = Option.getOrThrowWith(
    Option.filter(Option.fromNullishOr(decode64(segment)), (value) => !!value && base64Encode(value) === segment),
    () => new InvalidServerRouteError({ message: "Invalid server route" }),
  )
  return ServerConnection.Key.make(key)
}

export function legacySessionServer(
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[],
  sessionID: string,
  active: ServerConnection.Key,
) {
  const matches = tabs.filter((tab) => tab.sessionId === sessionID)
  return matches.find((tab) => tab.server === active)?.server ?? (matches.length === 1 ? matches[0]?.server : active)
}

type SessionParent = { id: string; parentID?: string }

/** Follows the parent chain of `session` to its root. A parent cycle fails with SessionParentCycleError. */
export const rootSession = <T extends SessionParent, E>(
  session: T,
  get: (sessionID: string) => Effect.Effect<T, E>,
): Effect.Effect<T, E | SessionParentCycleError> =>
  Effect.gen(function* () {
    const seen = MutableHashSet.make(session.id)
    let current = session
    while (current.parentID) {
      if (MutableHashSet.has(seen, current.parentID))
        return yield* new SessionParentCycleError({ message: `Session parent cycle: ${current.parentID}` })
      MutableHashSet.add(seen, current.parentID)
      current = yield* get(current.parentID)
    }
    return current
  })

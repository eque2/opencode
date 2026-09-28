import type { SessionApi } from "@opencode-ai/client/promise"
import { normalizeSessionInfo } from "@/utils/session"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { Data, Effect } from "effect"

/** A session list request that failed; `cause` is the value the request rejected with. */
export class SessionListError extends Data.TaggedError("SessionListError")<{ readonly cause: unknown }> {}

/** Runs one session list request and maps its rejection to a SessionListError. */
const listRequest = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: () => run(), catch: (cause) => new SessionListError({ cause }) })

export function loadRootSessions(input: { api: Pick<SessionApi, "list">; directory: string; limit: number }) {
  return listRequest(() =>
    input.api.list({
      directory: input.directory,
      // Root sessions have no parent. The session API reads a null parentID as that filter.
      // eslint-disable-next-line effect/no-null-use-option -- (b) @opencode-ai/client session.list reads parentID null as the root-session filter; the null is a wire-protocol literal and no other field selects roots
      parentID: null,
      limit: input.limit,
      order: "desc",
    }),
  ).pipe(
    Effect.map(
      (result) =>
        ({
          data: result.data.map(normalizeSessionInfo),
          limit: input.limit,
          limited: true,
        }) as const,
    ),
  )
}

/** Loads a limited page of root sessions; if the limited request fails, loads every root session instead. */
export function loadRootSessionsV1(input: { client: OpencodeClient; directory: string; limit: number }) {
  return listRequest(() =>
    input.client.session.list({ directory: input.directory, roots: true, limit: input.limit }),
  ).pipe(
    Effect.map((result) => ({ data: result.data, limit: input.limit, limited: true }) as const),
    Effect.catch(() =>
      listRequest(() => input.client.session.list({ directory: input.directory, roots: true })).pipe(
        Effect.map((result) => ({ data: result.data, limit: input.limit, limited: false }) as const),
      ),
    ),
  )
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}

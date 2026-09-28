import type { Message, UserMessage } from "@opencode-ai/sdk/v2"
import { Effect, Option } from "effect"
import { createMemo, createResource, onCleanup, untrack, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"

const emptyUserMessages: UserMessage[] = []
const sessionFreshness = 15_000

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
}) {
  const serverSync = useServerSync()
  const sync = useSync()
  let refreshFrame = Option.none<number>()
  let refreshTimer = Option.none<number>()

  const [resource] = createResource(
    () => input.sessionID(),
    (id) => {
      clearRefresh()
      if (!id) return undefined

      const cached = untrack(() => sync().data.message[id] !== undefined)
      const stale = cached && !serverSync().session.fresh(id, sessionFreshness)

      refreshFrame = Option.some(
        requestAnimationFrame(() => {
          refreshFrame = Option.none()
          refreshTimer = Option.some(
            window.setTimeout(() => {
              refreshTimer = Option.none()
              if (input.sessionID() !== id) return
              untrack(() => {
                if (stale) void sync().session.sync(id, { force: true })
              })
            }, 0),
          )
        }),
      )

      return sync().session.sync(id)
    },
  )
  const messages = createMemo(() => {
    const id = input.sessionID()
    return id ? (sync().data.message[id] ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || isTimelineReady(sync().data.message[id], serverSync().session.history.loading(id))
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => {
      return selectVisibleUserMessages(userMessages(), input.revertMessageID())
    },
    emptyUserMessages,
    { equals: same },
  )
  const more = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.more(id) : false
  })
  const loading = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.loading(id) : false
  })
  // session.tsx awaits this Promise; it rejects with the original loadMore rejection.
  const loadOlder = (options?: { before?: () => void; after?: (done: boolean) => void }) =>
    Effect.runPromise(
      loadOlderTimeline({
        sessionID: input.sessionID,
        more,
        loading,
        loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
        before: options?.before,
        after: options?.after,
      }),
    )

  onCleanup(clearRefresh)

  return {
    history: { loadOlder, loading, more },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    resource,
    userMessages,
    visibleUserMessages,
  }

  function clearRefresh() {
    if (Option.isSome(refreshFrame)) cancelAnimationFrame(refreshFrame.value)
    if (Option.isSome(refreshTimer)) window.clearTimeout(refreshTimer.value)
    refreshFrame = Option.none()
    refreshTimer = Option.none()
  }
}

export function selectUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user")
}

export function isTimelineReady(messages: Message[] | undefined, loading: boolean) {
  return messages !== undefined && (messages.some((message) => message.role === "user") || !loading)
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string) {
  if (!revertMessageID) return messages
  const boundary = messages.findIndex((message) => message.id === revertMessageID)
  return boundary < 0 ? messages : messages.slice(0, boundary)
}

/**
 * Loads one older history page of the current session. A failed load still
 * releases the anchor, then fails with the loadMore rejection as a defect, so
 * Effect.runPromise rejects with that same error.
 */
export const loadOlderTimeline = Effect.fnUntraced(function* (input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  input.before?.()
  yield* Effect.promise(() => input.loadMore(id)).pipe(
    Effect.tapCause(() =>
      Effect.sync(() => {
        if (input.sessionID() === id) input.after?.(true)
      }),
    ),
  )
  if (input.sessionID() !== id) return
  input.after?.(true)
})

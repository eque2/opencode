import { useNavigate } from "@solidjs/router"
import { Clock, Data, Effect, Option } from "effect"
import { produce } from "solid-js/store"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { errorMessage } from "@/pages/layout/helpers"
import { useSessionKey } from "@/pages/session/session-layout"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"

/** The archive request, or the local cleanup after it, failed. `cause` is the original error. */
class SessionArchiveError extends Data.TaggedError("App.SessionArchiveError")<{ readonly cause: unknown }> {}

export function useSessionArchive() {
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const tabs = useTabs()
  const { params } = useSessionKey()

  const navigateAfterRemoval = (
    sessionID: string,
    parentID: Option.Option<string>,
    nextSessionID: Option.Option<string>,
  ) => {
    if (params.id !== sessionID) return
    const href = (id: string) =>
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id)
    if (Option.isSome(parentID)) {
      navigate(href(parentID.value))
      return
    }
    if (Option.isSome(nextSessionID)) {
      navigate(href(nextSessionID.value))
      return
    }
    if (params.serverKey) {
      const server = requireServerKey(params.serverKey)
      // The draft tab opens in a transition that nothing waits for. A failure goes to the Effect logger.
      Effect.runFork(
        Effect.promise(() => tabs.newDraft({ server, directory: sdk().directory })).pipe(
          Effect.tapCause((cause) => Effect.logError(cause)),
        ),
      )
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archive = Effect.fnUntraced(function* (sessionID: string) {
    const session = sync().session.get(sessionID)
    if (!session) return
    if ((yield* Effect.promise(() => sdk().protocol)) !== "v1") return

    const sessions = sync().data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? Option.none() : Option.fromNullishOr(sessions[index + 1] ?? sessions[index - 1])
    const archived = yield* Clock.currentTimeMillis

    yield* Effect.tryPromise({
      try: () => sdk().client.session.update({ sessionID, directory: sdk().directory, time: { archived } }),
      catch: (cause) => new SessionArchiveError({ cause }),
    }).pipe(
      // A throw in the local cleanup shows the same toast as a rejected request, as the old promise chain did.
      Effect.andThen(
        Effect.try({
          try: () => {
            sync().set(
              produce((draft) => {
                const index = draft.session.findIndex((s) => s.id === sessionID)
                if (index !== -1) draft.session.splice(index, 1)
              }),
            )
            sync().session.evict(sessionID)
            serverSync().homeSessions.remove(sessionID)
            navigateAfterRemoval(
              sessionID,
              Option.fromNullishOr(session.parentID),
              Option.map(nextSession, (next) => next.id),
            )
            notifySessionTabsRemoved({ directory: sdk().directory, sessionIDs: [sessionID] })
          },
          catch: (cause) => new SessionArchiveError({ cause }),
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() =>
          showToast({
            title: language.t("common.requestFailed"),
            description: errorMessage(error.cause, language.t("common.requestFailed")),
          }),
        ),
      ),
    )
  })

  return { archive, navigateAfterRemoval }
}

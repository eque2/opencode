import { expect, test } from "bun:test"
import { Data, Effect } from "effect"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { archiveHomeSession } from "./home-session-archive"
import { ServerConnection } from "@/context/server"

const remote = ServerConnection.Key.make("remote")

/** The rejection of the archive stand-in. */
class ArchiveTestFailure extends Data.TaggedError("ArchiveTestFailure")<{ readonly message: string }> {}

test("archiving a Home session removes its open titlebar tab", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let detail: ReturnType<typeof readSessionTabsRemovedDetail>
      let removed = false
      window.addEventListener(
        SESSION_TABS_REMOVED_EVENT,
        (event) => {
          detail = readSessionTabsRemovedDetail(event)
        },
        { once: true },
      )

      yield* archiveHomeSession({
        server: remote,
        session: { id: "ses_1", directory: "/workspace" },
        archive: () => Effect.runPromise(Effect.void),
        remove: () => {
          removed = true
        },
      })

      expect(removed).toBe(true)
      expect(detail).toEqual({ server: remote, directory: "/workspace", sessionIDs: ["ses_1"] })
    }),
  ))

test("reports archive failures without removing the session", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failure = new ArchiveTestFailure({ message: "offline" })
      let error: unknown
      let removed = false

      yield* archiveHomeSession({
        server: remote,
        session: { id: "ses_1", directory: "/workspace" },
        archive: () => Effect.runPromise(Effect.fail(failure)),
        remove: () => {
          removed = true
        },
        onError: (value) => {
          error = value
        },
      })

      expect(error).toBe(failure)
      expect(removed).toBe(false)
    }),
  ))

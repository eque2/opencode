import { Schema } from "effect"
import { ServerConnection } from "./server"
import type { Tab } from "./tabs"

/** A persisted server key. Tabs saved before multi-server support have none. */
const StoredServer = Schema.optionalKey(Schema.String)

/** A persisted session tab, as the window storage holds it. */
const StoredSessionTab = Schema.Struct({
  type: Schema.Literal("session"),
  server: StoredServer,
  sessionId: Schema.String.pipe(Schema.brand("TabMigration.SessionId")),
}).annotate({
  identifier: "TabMigration.StoredSessionTab",
})

/** A persisted draft tab, as the window storage holds it. */
const StoredDraftTab = Schema.Struct({
  type: Schema.Literal("draft"),
  server: StoredServer,
  draftID: Schema.String,
  directory: Schema.String,
  worktree: Schema.optional(Schema.String),
}).annotate({
  identifier: "TabMigration.StoredDraftTab",
})

const isStoredSessionTab = Schema.is(StoredSessionTab)
const isStoredDraftTab = Schema.is(StoredDraftTab)

const serverKey = (server: string | undefined, fallback: ServerConnection.Key) =>
  server === undefined ? fallback : ServerConnection.Key.make(server)

/**
 * Reads the persisted tab list. Entries that are not a session or draft tab
 * are dropped, and legacy tabs without a server get `fallback`.
 */
export function migrateTabs(value: unknown, fallback: ServerConnection.Key): Tab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((tab: unknown): Tab[] => {
    if (isStoredSessionTab(tab)) {
      return [{ type: tab.type, server: serverKey(tab.server, fallback), sessionId: tab.sessionId }]
    }
    if (isStoredDraftTab(tab)) {
      return [
        {
          type: tab.type,
          server: serverKey(tab.server, fallback),
          draftID: tab.draftID,
          directory: tab.directory,
          ...(tab.worktree === undefined ? {} : { worktree: tab.worktree }),
        },
      ]
    }
    return []
  })
}

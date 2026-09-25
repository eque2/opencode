import type { Session } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { createEffect, getOwner, onCleanup, startTransition } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { sessionHref } from "@/utils/session-route"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import { createDraftPromptSession, type PromptModel, type PromptSession } from "./prompt-state"
import { migrateTabs } from "./tab-migration"
import { Array as Arr, Data, Effect, HashMap, HashSet, MutableHashSet, Option } from "effect"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

/** No open draft tab has the requested draft ID. tabs.draft throws it synchronously. */
class DraftNotFoundError extends Data.TaggedError("App.DraftNotFoundError")<{ readonly message: string }> {}

/** A tab store transition that rejected because its update threw. `cause` is the rejection. */
class TabsTransitionError extends Data.TaggedError("App.TabsTransitionError")<{ readonly cause: unknown }> {}

/** Runs `update` in a Solid transition. It fails when the update throws, as the transition Promise rejects. */
const transition = (update: () => void) =>
  Effect.tryPromise({
    try: () => startTransition(update),
    catch: (cause) => new TabsTransitionError({ cause }),
  })

export type TabInfo = {
  title?: string
  directory?: string
}

type RecentTab = {
  key?: string
}

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft" ? draftHref(tab.draftID) : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

export const { use: useTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.window("tabs"),
        migrate: (value: unknown) => migrateTabs(value, fallback),
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.window("tabs.recent"), createStore<RecentTab>({}))
    const [info, setInfo] = persisted(Persist.window("tabs.info"), createStore<Record<string, TabInfo>>({}))
    const [closed, setClosed, , closedReady] = persisted(Persist.window("tabs.closed"), createStore<ClosedTab[]>([]))

    const params = useParams()
    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory<PromptSession>(getOwner())

    const closing = MutableHashSet.empty<string>()
    let recentWrite = 0
    let recentValue: string | undefined

    const recentKey = () => (recentWrite ? recentValue : recent.key)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) setRecent("key", key)
      })
    }

    const updateClosed = (update: (stack: ClosedTab[]) => ClosedTab[]) => {
      const apply = () => setClosed((stack) => update(stack))
      if (closedReady()) {
        apply()
        return
      }
      void closedReady.promise?.then(apply)
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) {
        const target = Persist.draft(draftID, key)
        removePersisted(key === "prompt" ? Persist.prompt(target) : target, platform)
      }
    }

    const removeInfo = (key: string) => {
      if (!info[key]) return
      setInfo(
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = HashSet.fromIterable(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => HashSet.has(servers, tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!HashSet.has(servers, tab.server)) {
            const key = tabKey(tab)
            memory.remove(key)
            removeInfo(key)
          }
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
      const keys = HashSet.fromIterable(next.map(tabKey))
      for (const key of Object.keys(info)) {
        if (!HashSet.has(keys, key)) removeInfo(key)
      }
    })

    createEffect(() => {
      if (!closedReady()) return
      const servers = HashSet.fromIterable(server.list.map(ServerConnection.key))
      const next = closed.filter((entry) => HashSet.has(servers, entry.tab.server))
      if (next.length !== closed.length) setClosed(() => next)
    })

    const navigateTab = (tab: Tab) => {
      const href = tabHref(tab)
      setRecentKey(tabKey(tab))
      navigate(href)
    }

    const removeTab = (index: number) => {
      const tab = store[index]
      if (!tab) return
      const key = tabKey(tab)
      const draftID = tab.type === "draft" ? tab.draftID : undefined
      const nextTab = nextTabAfterClose(store, index, recentKey() === key && location.pathname !== "/")
      MutableHashSet.add(closing, key)
      void startTransition(() => {
        setStore((tabs) => Arr.remove(tabs, index))
        if (nextTab === null) {
          setRecentKey(undefined)
          navigate("/")
        }
        if (nextTab) navigateTab(nextTab)
      }).finally(() => MutableHashSet.remove(closing, key))
      memory.remove(key)
      removeInfo(key)
      if (draftID) removeDraftPersisted(draftID)
    }

    const actions = {
      addSessionTab: (tab: Omit<SessionTab, "type">) => {
        const next = { type: "session" as const, ...tab }
        const existing = store.find((item) => tabKey(item) === tabKey(next))
        if (existing) return existing
        void startTransition(() => {
          setStore((tabs) => (tabs.some((item) => tabKey(item) === tabKey(next)) ? tabs : [...tabs, next]))
        })
        return next
      },
      reorder(keys: string[]) {
        setStore((tabs) => {
          const byKey = HashMap.fromIterable(tabs.map((tab) => [tabKey(tab), tab] as const))
          const next = Arr.getSomes(keys.map((key) => HashMap.get(byKey, key)))
          return next.length === tabs.length ? next : tabs
        })
      },
      draft(draftID: string) {
        return Option.getOrThrowWith(
          Arr.findFirst(store, (item): item is DraftTab => item.type === "draft" && item.draftID === draftID),
          () => new DraftNotFoundError({ message: `Draft not found: ${draftID}` }),
        )
      },
      newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string, model?: PromptModel) {
        const draftID = uuid()
        const tab = { type: "draft" as const, draftID, ...draft }
        memory.ensure(tabKey(tab), "prompt", () => createDraftPromptSession(draftID, { prompt, model }))
        return Effect.runPromise(
          transition(() => {
            setStore((tabs) => [...tabs, tab])
            navigate(draftHref(draftID))
          }).pipe(Effect.as(tab)),
        )
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        void startTransition(() => {
          setStore(
            (tab) => tab.type === "draft" && tab.draftID === draftID,
            produce((tab) => Object.assign(tab, draft)),
          )
        })
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        const active = location.pathname === "/new-session" && location.query.draftId === draftID
        const next = { type: "session" as const, ...session }
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
              if (index !== -1) tabs[index] = next
            }),
          )
          if (recent.key === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        memory.remove(`draft:${draftID}`)
        removeDraftPersisted(draftID)
      },
      removeTab,
      // User-initiated close: records the tab so it can be reopened.
      // Cleanup paths (missing sessions, archive, server removal) go through
      // removeTab and friends directly and are not recorded.
      closeTab(index: number) {
        const tab = store[index]
        if (!tab) return
        if (tab.type === "session") updateClosed((stack) => pushClosedTab(stack, tab, index))
        removeTab(index)
      },
      reopenClosedTab() {
        if (!closedReady()) {
          void closedReady.promise?.then(() => actions.reopenClosedTab())
          return
        }
        const result = takeClosedTab(closed, store)
        if (result.stack.length === closed.length) return
        setClosed(() => result.stack)
        const entry = result.entry
        if (!entry) return
        const index = Math.min(entry.index, store.length)
        void startTransition(() => {
          // Insert at `index`, or append when fewer tabs are open by then.
          setStore((tabs) =>
            tabs.some((item) => tabKey(item) === tabKey(entry.tab))
              ? tabs
              : [...tabs.slice(0, index), entry.tab, ...tabs.slice(index)],
          )
          navigateTab(entry.tab)
        })
      },
      removeSessionTab(input: Omit<SessionTab, "type">) {
        updateClosed((stack) => removeClosedTabs(stack, input.server, [input.sessionId]))
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index)
      },
      removeServer(key: ServerConnection.Key) {
        updateClosed((stack) => stack.filter((entry) => entry.tab.server !== key))
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server ?? server.key
        updateClosed((stack) => removeClosedTabs(stack, targetServer, input.sessionIDs))
        const removed = store
          .filter(
            (tab) => tab.type === "session" && tab.server === targetServer && input.sessionIDs.includes(tab.sessionId),
          )
          .map(tabKey)
        void startTransition(() => {
          const sessionIDs = HashSet.fromIterable(input.sessionIDs)
          const isRemoved = (tab: Tab) =>
            tab.type === "session" && tab.server === targetServer && HashSet.has(sessionIDs, tab.sessionId)
          const currentHref =
            targetServer === server.key && params.dir && params.id
              ? Option.some(tabHref({ type: "session", server: targetServer, sessionId: params.id }))
              : Option.none<string>()
          // The position of the open session's tab, when this removal closes it.
          const removedIndex = currentHref.pipe(
            Option.flatMap((href) =>
              Arr.findFirstIndex(
                store,
                (tab) => tab.type === "session" && tab.server === targetServer && tabHref(tab) === href,
              ),
            ),
            Option.filter((index) => Option.exists(Arr.get(store, index), isRemoved)),
          )
          const next = store.filter((tab) => !isRemoved(tab))
          setStore(() => next)
          if (Option.isSome(removedIndex)) {
            // Move to the nearest session tab at or after the closed position, else before it.
            const index = removedIndex.value
            const nextTab = Option.orElse(
              Arr.findFirst(next.slice(index), (tab) => tab.type === "session"),
              () => Arr.findLast(next.slice(0, index), (tab) => tab.type === "session"),
            )
            if (Option.isSome(nextTab)) navigateTab(nextTab.value)
            else navigate("/")
          }
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        })
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
      },
      rememberSessionInfo(tab: SessionTab, session: Session) {
        const key = tabKey(tab)
        const next = { title: session.title, directory: session.directory }
        const current = info[key]
        if (current?.title === next.title && current.directory === next.directory) return
        setInfo(key, next)
      },
      select: navigateTab,
      remember(tab: Tab) {
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      state(tab: Tab, name: string, init: () => PromptSession) {
        return memory.ensure(tabKey(tab), name, init)
      },
      stateValue(tab: Tab, name: string) {
        return memory.get(tabKey(tab), name)
      },
    }

    return { ...actions, store, info, ready, recentReady }
  },
})

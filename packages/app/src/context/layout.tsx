import {
  Array as Arr,
  Data,
  DateTime,
  Effect,
  HashMap,
  HashSet,
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  Random,
} from "effect"
import { createStore, produce, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup, onMount, type Accessor } from "solid-js"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useServerSync } from "./server-sync"
import { useServerSDK } from "./server-sdk"
import { RECENTLY_CLOSED_DISPLAY_LIMIT, ServerConnection, useServer } from "./server"
import { usePlatform } from "./platform"
import { Project } from "@opencode-ai/sdk/v2"
import { normalizeProjectInfo } from "./global-sync/utils"
import { Persist, persisted, removePersisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import { decode64 } from "@/utils/base64"
import { same } from "@/utils/same"
import { createScrollPersistence, type SessionScroll } from "./layout-scroll"
import { createPathHelpers } from "./file/path"
import type { ProjectAvatarVariant } from "@opencode-ai/ui/v2/project-avatar-v2"
import { migrateLegacySessionStateKeys, ServerScope, SessionStateKey } from "@/utils/server-scope"
import { createSessionKeyReader, ensureSessionKey, pruneSessionKeys } from "./layout-helpers"
import { requireServerKey } from "@/utils/session-route"
import { type DraftTab, useTabs } from "./tabs"
import { closeSessionTab, openSessionTab, previewSessionTab, type SessionTabs } from "./layout-tabs"
import { createFiberSlot } from "@/utils/fiber-slot"
import { nextFrame } from "@/utils/next-frame"

export { createSessionKeyReader, ensureSessionKey, pruneSessionKeys }

export type { ProjectAvatarVariant }

const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
const DEFAULT_SIDEBAR_WIDTH = 344
const DEFAULT_FILE_TREE_WIDTH = 200
const DEFAULT_SESSION_WIDTH = 600
const DEFAULT_TERMINAL_HEIGHT = 280
const DEFAULT_REVIEW_PANEL_OPENED = false
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

const isAvatarColorKey = (key: string): key is AvatarColorKey => AVATAR_COLOR_KEYS.some((item) => item === key)

// Avatar colors are picked in sync Solid effects outside any fiber, so they read the default Random service directly.
const random = Random.Random.defaultValue()

/** A layout context request to the server that rejected. `cause` is the original rejection. */
class LayoutContextRequestError extends Data.TaggedError("App.LayoutContextRequestError")<{
  readonly cause: unknown
}> {}

/** Runs one server request as an Effect. A rejection fails with LayoutContextRequestError. */
const layoutRequest = <A,>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new LayoutContextRequestError({ cause }) })

export function getAvatarColors(key?: string) {
  if (key && isAvatarColorKey(key)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function getProjectAvatarVariant(key?: string): ProjectAvatarVariant {
  if (key === "mint") return "cyan"
  if (key === "lime") return "green"
  if (
    key === "orange" ||
    key === "yellow" ||
    key === "cyan" ||
    key === "green" ||
    key === "red" ||
    key === "pink" ||
    key === "blue" ||
    key === "purple" ||
    key === "gray"
  )
    return key
  return "gray"
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  reviewMode?: ReviewChangeMode
  reviewFile?: string
  pendingMessage?: string
  pendingMessageAt?: number
  todoCollapsed?: boolean
}

type TabHandoff = {
  scope: ServerScope
  dir: string
  id: string
  at: number
}

/** The persisted tab handoff. An absent `tabs` key means no handoff is pending. */
type TabHandoffState = { tabs?: TabHandoff }

export type LocalProject = Partial<Project> & { worktree: string; expanded: boolean }
export type HomeProjectSelection = { server: ServerConnection.Key; directory?: string }

export type ReviewDiffStyle = "unified" | "split"
export type ReviewChangeMode = "git" | "branch" | "turn"
export type ReviewPanelSource = "context-button" | "other"

export type LayoutRoute =
  | { type: "home" }
  | { type: "draft"; draftID: string; server?: ServerConnection.Key }
  | { type: "dir-new-sesssion"; dir: string; dirBase64: string; server?: ServerConnection.Key }
  | { type: "session"; sessionId: string; server?: ServerConnection.Key }

const sessionPath = (key: string) => {
  const dir = SessionStateKey.route(key).split("/")[0]
  if (!dir) return undefined
  const root = decode64(dir)
  if (!root) return undefined
  return createPathHelpers(() => root)
}

const normalizeSessionTab = (path: ReturnType<typeof createPathHelpers> | undefined, tab: string) => {
  if (!tab.startsWith("file://")) return tab
  if (!path) return tab
  return path.tab(tab)
}

const normalizeSessionTabList = (path: ReturnType<typeof createPathHelpers> | undefined, all: string[]) =>
  Arr.dedupe(all.map((tab) => normalizeSessionTab(path, tab)))

const normalizeStoredSessionTabs = (key: string, tabs: SessionTabs) => {
  const path = sessionPath(key)
  return {
    all: normalizeSessionTabList(path, tabs.all),
    active: tabs.active ? normalizeSessionTab(path, tabs.active) : tabs.active,
  }
}

export const currentRoute = (pathname: string, search: string): LayoutRoute => {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return { type: "home" }

  if (parts[0] === "new-session") {
    const draftID = new URLSearchParams(search).get("draftId")
    if (!draftID) return { type: "home" }
    return { type: "draft", draftID }
  }

  if (parts[0] === "server" && parts[2] === "session" && parts[3]) {
    return {
      type: "session",
      sessionId: parts[3],
      server: requireServerKey(parts[1]),
    }
  }

  const dirBase64 = parts[0]
  const dir = decode64(dirBase64)
  if (!dir) return { type: "home" }

  if (parts[1] !== "session") return { type: "home" }

  const id = parts[2]
  if (id) return { type: "session", sessionId: id }
  return { type: "dir-new-sesssion", dir, dirBase64 }
}

export const { use: useLayout, provider: LayoutProvider } = createSimpleContext({
  name: "Layout",
  gate: false,
  init: () => {
    const serverSdk = useServerSDK()
    const serverSync = useServerSync()
    const server = useServer()
    const tabs = useTabs()
    const platform = usePlatform()
    const location = useLocation()
    const route = createMemo(() => {
      const value = currentRoute(location.pathname, location.search)
      if (value.type === "home") return value
      if (value.server) return value
      if (value.type === "draft") {
        const draft = tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === value.draftID)
        if (draft) return { ...value, server: draft.server }
      }
      return { ...value, server: server.key }
    })

    const migrate = (value: unknown) => {
      if (!Predicate.isObject(value)) return value

      const sidebar = value.sidebar
      const migratedSidebar = (() => {
        if (!Predicate.isObject(sidebar)) return sidebar
        if (typeof sidebar.workspaces !== "boolean") return sidebar
        return {
          ...sidebar,
          workspaces: {},
          workspacesDefault: sidebar.workspaces,
        }
      })()

      const review = value.review
      const fileTree = value.fileTree
      const migratedFileTree = (() => {
        if (!Predicate.isObject(fileTree)) return fileTree
        if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

        const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_FILE_TREE_WIDTH
        return {
          ...fileTree,
          opened: true,
          width: width === 260 ? DEFAULT_FILE_TREE_WIDTH : width,
          tab: "changes",
        }
      })()

      const migratedReview = (() => {
        if (!Predicate.isObject(review)) return review
        if (typeof review.panelOpened === "boolean") return review

        const opened =
          Predicate.isObject(fileTree) && typeof fileTree.opened === "boolean"
            ? fileTree.opened
            : DEFAULT_REVIEW_PANEL_OPENED
        return {
          ...review,
          panelOpened: opened,
        }
      })()

      const sessionTabs = migrateLegacySessionStateKeys(value.sessionTabs)
      const sessionView = migrateLegacySessionStateKeys(value.sessionView)
      const migratedSessionTabs = (() => {
        if (!Predicate.isObject(sessionTabs)) return sessionTabs

        let changed = false
        const next = Object.fromEntries(
          Object.entries(sessionTabs).map(([key, tabs]) => {
            if (!Predicate.isObject(tabs) || !Array.isArray(tabs.all)) return [key, tabs]

            const current: SessionTabs = {
              all: tabs.all.filter((tab): tab is string => typeof tab === "string"),
              ...(typeof tabs.active === "string" ? { active: tabs.active } : {}),
            }
            const normalized = normalizeStoredSessionTabs(key, current)
            if (current.all.length !== tabs.all.length) changed = true
            if (!same(current.all, normalized.all) || current.active !== normalized.active) changed = true
            if (tabs.active !== undefined && typeof tabs.active !== "string") changed = true
            return [key, normalized]
          }),
        )

        if (!changed) return sessionTabs
        return next
      })()

      if (
        migratedSidebar === sidebar &&
        migratedReview === review &&
        migratedFileTree === fileTree &&
        migratedSessionTabs === value.sessionTabs &&
        sessionView === value.sessionView
      ) {
        return value
      }

      return {
        ...value,
        sidebar: migratedSidebar,
        review: migratedReview,
        fileTree: migratedFileTree,
        sessionTabs: migratedSessionTabs,
        sessionView,
      }
    }

    const target = Persist.serverGlobal(serverSdk().scope, "layout", ["layout.v6"])
    const [store, setStore, _, ready] = persisted(
      { ...target, migrate },
      createStore({
        sidebar: {
          opened: false,
          width: DEFAULT_SIDEBAR_WIDTH,
          workspaces: {} as Record<string, boolean>,
          workspacesDefault: false,
        },
        terminal: {
          height: DEFAULT_TERMINAL_HEIGHT,
          opened: false,
        },
        review: {
          diffStyle: "split" as ReviewDiffStyle,
          panelOpened: DEFAULT_REVIEW_PANEL_OPENED,
        },
        fileTree: {
          opened: false,
          width: DEFAULT_FILE_TREE_WIDTH,
          tab: "changes" as "changes" | "all",
        },
        session: {
          width: DEFAULT_SESSION_WIDTH,
        },
        mobileSidebar: {
          opened: false,
        },
        sessionTabs: {} as Record<string, SessionTabs>,
        sessionView: {} as Record<string, SessionView>,
        handoff: {} as TabHandoffState,
        home: {
          selection: { server: server.key } as HomeProjectSelection,
        },
      }),
    )
    const [ephemeral, setEphemeral] = createStore({
      reviewPanelSource: "other" as ReviewPanelSource,
      sessionTabPreview: {} as Record<string, string | undefined>,
    })

    const MAX_SESSION_KEYS = 50
    const PENDING_MESSAGE_TTL_MS = 2 * 60 * 1000
    const usage = {
      active: Option.none<string>(),
      pruned: false,
      used: MutableHashMap.empty<string, number>(),
    }

    const SESSION_STATE_KEYS = [
      { key: "prompt", legacy: "prompt", version: "v2" },
      { key: "terminal", legacy: "terminal", version: "v1" },
      { key: "file-view", legacy: "file", version: "v1" },
    ] as const

    const dropSessionState = (keys: string[]) => {
      for (const key of keys) {
        const scope = SessionStateKey.scope(key)
        const parts = SessionStateKey.route(key).split("/")
        const dir = parts[0]
        const session = parts[1]
        if (!dir) continue

        for (const entry of SESSION_STATE_KEYS) {
          const target = session
            ? Persist.serverSession(scope, dir, session, entry.key)
            : Persist.serverWorkspace(scope, dir, entry.key)
          removePersisted(target, platform)

          if (scope !== ServerScope.local) continue
          const legacyKey = `${dir}/${entry.legacy}${session ? "/" + session : ""}.${entry.version}`
          removePersisted({ key: legacyKey }, platform)
        }
      }
    }

    function prune(keep?: string) {
      const drop = pruneSessionKeys({
        keep,
        max: MAX_SESSION_KEYS,
        used: usage.used,
        view: Object.keys(store.sessionView),
        tabs: Object.keys(store.sessionTabs),
      })
      if (drop.length === 0) return

      setStore(
        produce((draft) => {
          for (const key of drop) {
            delete draft.sessionView[key]
            delete draft.sessionTabs[key]
          }
        }),
      )

      scroll.drop(drop)
      dropSessionState(drop)
      setEphemeral(
        "sessionTabPreview",
        produce((draft) => {
          for (const key of drop) delete draft[key]
        }),
      )

      for (const key of drop) {
        MutableHashMap.remove(usage.used, key)
      }
    }

    function touch(sessionKey: string) {
      usage.active = Option.some(sessionKey)
      MutableHashMap.set(usage.used, sessionKey, DateTime.toEpochMillis(DateTime.nowUnsafe()))

      if (!ready()) return
      if (usage.pruned) return

      usage.pruned = true
      prune(sessionKey)
    }

    const scroll = createScrollPersistence({
      debounceMs: 250,
      getSnapshot: (sessionKey) => store.sessionView[sessionKey]?.scroll,
      onFlush: (sessionKey, next) => {
        const current = store.sessionView[sessionKey]
        const keep = Option.getOrElse(usage.active, () => sessionKey)
        if (!current) {
          setStore("sessionView", sessionKey, { scroll: next })
          prune(keep)
          return
        }

        setStore("sessionView", sessionKey, "scroll", (prev) => ({ ...prev, ...next }))
        prune(keep)
      },
    })

    const ensureKey = (key: string) => ensureSessionKey(key, touch, (sessionKey) => scroll.seed(sessionKey))

    createEffect(() => {
      if (!ready()) return
      if (usage.pruned) return
      const active = usage.active
      if (Option.isNone(active)) return
      usage.pruned = true
      prune(active.value)
    })

    onMount(() => {
      const flush = () => batch(() => scroll.flushAll())
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") return
        flush()
      }

      makeEventListener(window, "pagehide", flush)
      makeEventListener(document, "visibilitychange", handleVisibility)

      onCleanup(() => {
        scroll.dispose()
      })
    })

    const [colors, setColors] = createStore<Record<string, AvatarColorKey>>({})
    const colorRequested = MutableHashMap.empty<string, AvatarColorKey>()

    function pickAvailableColor(used: MutableHashSet.MutableHashSet<string>): AvatarColorKey {
      const available = AVATAR_COLOR_KEYS.filter((c) => !MutableHashSet.has(used, c))
      if (available.length === 0)
        return AVATAR_COLOR_KEYS[Math.floor(random.nextDoubleUnsafe() * AVATAR_COLOR_KEYS.length)]
      return available[Math.floor(random.nextDoubleUnsafe() * available.length)]
    }

    function enrich(project: { worktree: string; expanded: boolean }) {
      const [childStore] = serverSync().child(project.worktree, { bootstrap: false })
      const projectID = childStore.project
      const metadata = projectID
        ? serverSync().data.project.find((x) => x.id === projectID)
        : serverSync().data.project.find((x) => x.worktree === project.worktree)

      // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
      // Without this, different subdirectories of the same git repo would share the same
      // icon from the database instead of using their individual overrides.
      const base = { ...metadata, ...project }
      if (childStore.icon) {
        return { ...base, icon: { ...base.icon, override: childStore.icon } }
      }
      return base
    }

    const roots = createMemo(() =>
      HashMap.fromIterable(
        serverSync().data.project.flatMap((project) =>
          (project.sandboxes ?? []).map((sandbox) => [sandbox, project.worktree] as const),
        ),
      ),
    )

    const rootFor = (directory: string) => {
      const map = roots()
      if (HashMap.isEmpty(map)) return directory

      const visited = MutableHashSet.empty<string>()
      const chain = [directory]

      while (chain.length) {
        const current = chain[chain.length - 1]
        if (!current) return directory

        const next = HashMap.get(map, current)
        if (Option.isNone(next) || !next.value) return current

        if (MutableHashSet.has(visited, next.value)) return directory
        MutableHashSet.add(visited, next.value)
        chain.push(next.value)
      }

      return directory
    }

    createEffect(() => {
      const projects = server.projects.list()
      const seen = MutableHashSet.fromIterable(projects.map((project) => project.worktree))

      batch(() => {
        for (const project of projects) {
          const root = rootFor(project.worktree)
          if (root === project.worktree) continue

          server.projects.remove(project.worktree)

          if (!MutableHashSet.has(seen, root)) {
            server.projects.open(root)
            MutableHashSet.add(seen, root)
          }

          if (project.expanded) server.projects.expand(root)
        }
      })
    })

    const enriched = createMemo(() => server.projects.list().map(enrich))
    const list = createMemo(() => {
      const projects = enriched()
      return projects.map((project) => {
        const color = project.icon?.color ?? colors[project.worktree]
        if (!color) return project
        const icon = project.icon ? { ...project.icon, color } : { color }
        return { ...project, icon }
      })
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return
      if (!serverSync().ready) return

      for (const project of projects) {
        if (!project.id) continue
        if (project.id === "global") continue
        serverSync().project.icon(project.worktree, project.icon?.override)
      }
    })

    createEffect(() => {
      const projects = enriched()
      if (projects.length === 0) return

      for (const project of projects) {
        if (project.icon?.color) MutableHashMap.remove(colorRequested, project.worktree)
      }

      const used = MutableHashSet.empty<string>()
      for (const project of projects) {
        const color = project.icon?.color ?? colors[project.worktree]
        if (color) MutableHashSet.add(used, color)
      }

      for (const project of projects) {
        if (project.icon?.color || project.icon?.override || project.icon?.url) continue
        const worktree = project.worktree
        const existing = colors[worktree]
        const color = existing ?? pickAvailableColor(used)
        if (!existing) {
          MutableHashSet.add(used, color)
          setColors(worktree, color)
        }
        if (!project.id) continue

        if (Option.contains(MutableHashMap.get(colorRequested, worktree), color)) continue
        MutableHashMap.set(colorRequested, worktree, color)

        if (project.id === "global") {
          serverSync().project.meta(worktree, { icon: { color } })
          continue
        }

        const projectID = project.id
        const sdk = serverSdk()
        // Any failure clears the pending request, so a later effect run can ask again.
        Effect.runFork(
          Effect.gen(function* () {
            const protocol = yield* layoutRequest(() => sdk.protocol)
            if (protocol !== "v1") return
            const response = yield* layoutRequest(() =>
              sdk.client.project.update({ projectID, directory: worktree, icon: { color } }),
            )
            const result = response.data
            if (!result) return
            serverSync().set("project", (items) =>
              items.map((item) => (item.id === result.id ? normalizeProjectInfo(result) : item)),
            )
          }).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => {
                if (Option.contains(MutableHashMap.get(colorRequested, worktree), color))
                  MutableHashMap.remove(colorRequested, worktree)
              }),
            ),
          ),
        )
      }
    })

    // The owner's cleanup interrupts the slot, which cancels a pending frame or task.
    const sessionLoad = createFiberSlot()

    onMount(() => {
      // Load the sessions of every open project in the task after the first frame, so the layout paints first.
      sessionLoad.run(
        nextFrame.pipe(
          Effect.andThen(Effect.sleep("0 millis")),
          Effect.andThen(
            Effect.suspend(() =>
              Effect.forEach(
                server.projects.list(),
                (project) =>
                  layoutRequest(() => serverSync().project.loadSessions(project.worktree)).pipe(
                    Effect.catch((error) => Effect.logError(error)),
                  ),
                { concurrency: "unbounded", discard: true },
              ),
            ),
          ),
        ),
      )
    })

    return {
      route,
      ready,
      home: {
        selection: createMemo(() => store.home.selection),
        setSelection(selection: HomeProjectSelection) {
          setStore("home", "selection", reconcile(selection))
        },
      },
      handoff: {
        tabs: createMemo(() => store.handoff?.tabs),
        setTabs(dir: string, id: string) {
          setStore("handoff", "tabs", {
            scope: serverSdk().scope,
            dir,
            id,
            at: DateTime.toEpochMillis(DateTime.nowUnsafe()),
          })
        },
        clearTabs() {
          if (!store.handoff?.tabs) return
          setStore(
            "handoff",
            produce((draft) => {
              delete draft.tabs
            }),
          )
        },
      },
      projects: {
        list,
        recentlyClosed: createMemo(() => {
          const known = HashSet.fromIterable(serverSync().data.project.map((project) => pathKey(project.worktree)))
          return server.projects
            .recentlyClosed()
            .filter((worktree) => HashSet.has(known, pathKey(worktree)))
            .slice(0, RECENTLY_CLOSED_DISPLAY_LIMIT)
            .map((worktree) => enrich({ worktree, expanded: false }))
        }),
        open(directory: string) {
          const root = rootFor(directory)
          if (server.projects.list().find((x) => x.worktree === root)) return
          void serverSync().project.loadSessions(root)
          server.projects.open(root)
        },
        close(directory: string) {
          server.projects.close(directory)
        },
        expand(directory: string) {
          server.projects.expand(directory)
        },
        collapse(directory: string) {
          server.projects.collapse(directory)
        },
        move(directory: string, toIndex: number) {
          server.projects.move(directory, toIndex)
        },
      },
      sidebar: {
        opened: createMemo(() => store.sidebar.opened),
        open() {
          setStore("sidebar", "opened", true)
        },
        close() {
          setStore("sidebar", "opened", false)
        },
        toggle() {
          setStore("sidebar", "opened", (x) => !x)
        },
        width: createMemo(() => store.sidebar.width),
        resize(width: number) {
          setStore("sidebar", "width", width)
        },
        workspaces(directory: string) {
          return () => store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
        },
        setWorkspaces(directory: string, value: boolean) {
          setStore("sidebar", "workspaces", directory, value)
        },
        toggleWorkspaces(directory: string) {
          const current = store.sidebar.workspaces[directory] ?? store.sidebar.workspacesDefault ?? false
          setStore("sidebar", "workspaces", directory, !current)
        },
      },
      terminal: {
        height: createMemo(() => store.terminal.height),
        resize(height: number) {
          setStore("terminal", "height", height)
        },
      },
      review: {
        diffStyle: createMemo(() => store.review?.diffStyle ?? "split"),
        setDiffStyle(diffStyle: ReviewDiffStyle) {
          if (!store.review) {
            setStore("review", { diffStyle, panelOpened: DEFAULT_REVIEW_PANEL_OPENED })
            return
          }
          setStore("review", "diffStyle", diffStyle)
        },
      },
      fileTree: {
        opened: createMemo(() => store.fileTree?.opened ?? true),
        width: createMemo(() => store.fileTree?.width ?? DEFAULT_FILE_TREE_WIDTH),
        tab: createMemo(() => store.fileTree?.tab ?? "changes"),
        setTab(tab: "changes" | "all") {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab })
            return
          }
          setStore("fileTree", "tab", tab)
        },
        open() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", true)
        },
        close() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: false, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", false)
        },
        toggle() {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width: DEFAULT_FILE_TREE_WIDTH, tab: "changes" })
            return
          }
          setStore("fileTree", "opened", (x) => !x)
        },
        resize(width: number) {
          if (!store.fileTree) {
            setStore("fileTree", { opened: true, width, tab: "changes" })
            return
          }
          setStore("fileTree", "width", width)
        },
      },
      session: {
        width: createMemo(() => store.session?.width ?? DEFAULT_SESSION_WIDTH),
        resize(width: number) {
          if (!store.session) {
            setStore("session", { width })
            return
          }
          setStore("session", "width", width)
        },
      },
      mobileSidebar: {
        opened: createMemo(() => store.mobileSidebar?.opened ?? false),
        show() {
          setStore("mobileSidebar", "opened", true)
        },
        hide() {
          setStore("mobileSidebar", "opened", false)
        },
        toggle() {
          setStore("mobileSidebar", "opened", (x) => !x)
        },
      },
      pendingMessage: {
        set(sessionKey: string, messageID: string) {
          const at = DateTime.toEpochMillis(DateTime.nowUnsafe())
          touch(sessionKey)
          const current = store.sessionView[sessionKey]
          if (!current) {
            setStore("sessionView", sessionKey, {
              scroll: {},
              pendingMessage: messageID,
              pendingMessageAt: at,
            })
            prune(Option.getOrElse(usage.active, () => sessionKey))
            return
          }

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              draft.pendingMessage = messageID
              draft.pendingMessageAt = at
            }),
          )
        },
        consume(sessionKey: string) {
          const current = store.sessionView[sessionKey]
          const message = current?.pendingMessage
          const at = current?.pendingMessageAt
          if (!message || !at) return undefined

          setStore(
            "sessionView",
            sessionKey,
            produce((draft) => {
              delete draft.pendingMessage
              delete draft.pendingMessageAt
            }),
          )

          if (DateTime.toEpochMillis(DateTime.nowUnsafe()) - at > PENDING_MESSAGE_TTL_MS) return undefined
          return message
        },
      },
      view(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const s = createMemo(() => store.sessionView[key()] ?? { scroll: {} })
        const reviewMode = createMemo(() => {
          const mode = s().reviewMode
          if (mode === "git" || mode === "branch" || mode === "turn") return mode
          return undefined
        })
        const reviewFile = createMemo(() => {
          const file = s().reviewFile
          if (typeof file === "string") return file
          return undefined
        })
        const terminalOpened = createMemo(() => store.terminal?.opened ?? false)
        const reviewPanelOpened = createMemo(() => store.review?.panelOpened ?? DEFAULT_REVIEW_PANEL_OPENED)
        const reviewPanelSource = createMemo(() => (reviewPanelOpened() ? ephemeral.reviewPanelSource : "other"))

        function setTerminalOpened(next: boolean) {
          const current = store.terminal
          if (!current) {
            setStore("terminal", { height: DEFAULT_TERMINAL_HEIGHT, opened: next })
            return
          }

          const value = current.opened ?? false
          if (value === next) return
          setStore("terminal", "opened", next)
        }

        function setReviewPanelOpened(next: boolean, source: ReviewPanelSource) {
          const nextSource = next ? source : "other"
          const current = store.review
          if (!current) {
            batch(() => {
              setStore("review", { diffStyle: "split" as ReviewDiffStyle, panelOpened: next })
              setEphemeral("reviewPanelSource", nextSource)
            })
            return
          }

          const value = current.panelOpened ?? DEFAULT_REVIEW_PANEL_OPENED
          if (value === next) {
            if (ephemeral.reviewPanelSource !== nextSource) setEphemeral("reviewPanelSource", nextSource)
            return
          }
          batch(() => {
            setStore("review", "panelOpened", next)
            setEphemeral("reviewPanelSource", nextSource)
          })
        }

        return {
          scroll(tab: string) {
            return scroll.scroll(key(), tab)
          },
          setScroll(tab: string, pos: SessionScroll) {
            scroll.setScroll(key(), tab, pos)
          },
          todoCollapsed: {
            get: () => s().todoCollapsed ?? false,
            set(collapsed: boolean) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, todoCollapsed: collapsed })
              } else {
                setStore("sessionView", session, "todoCollapsed", collapsed)
              }
            },
          },
          terminal: {
            opened: terminalOpened,
            open() {
              setTerminalOpened(true)
            },
            close() {
              setTerminalOpened(false)
            },
            toggle() {
              setTerminalOpened(!terminalOpened())
            },
          },
          reviewPanel: {
            opened: reviewPanelOpened,
            source: reviewPanelSource,
            open(source: ReviewPanelSource = "other") {
              setReviewPanelOpened(true, source)
            },
            close() {
              setReviewPanelOpened(false, "other")
            },
            toggle() {
              setReviewPanelOpened(!reviewPanelOpened(), "other")
            },
          },
          review: {
            mode: reviewMode,
            setMode(mode: ReviewChangeMode) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, reviewMode: mode })
                prune(session)
                return
              }
              if (current.reviewMode === mode) return
              setStore("sessionView", session, "reviewMode", mode)
              prune(session)
            },
            file: reviewFile,
            setFile(file: string) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, { scroll: {}, reviewFile: file })
                prune(session)
                return
              }
              if (current.reviewFile === file) return
              setStore("sessionView", session, "reviewFile", file)
              prune(session)
            },
            open: createMemo(() => s().reviewOpen ?? []),
            setOpen(open: string[]) {
              const session = key()
              const next = Arr.dedupe(open)
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: next,
                })
                return
              }

              if (same(current.reviewOpen, next)) return
              setStore("sessionView", session, "reviewOpen", next)
            },
            openPath(path: string) {
              const session = key()
              const current = store.sessionView[session]
              if (!current) {
                setStore("sessionView", session, {
                  scroll: {},
                  reviewOpen: [path],
                })
                return
              }

              if (!current.reviewOpen) {
                setStore("sessionView", session, "reviewOpen", [path])
                return
              }

              if (current.reviewOpen.includes(path)) return
              setStore("sessionView", session, "reviewOpen", current.reviewOpen.length, path)
            },
            closePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current) return

              const index = current.indexOf(path)
              if (index === -1) return
              setStore(
                "sessionView",
                session,
                "reviewOpen",
                produce((draft) => {
                  if (!draft) return
                  draft.splice(index, 1)
                }),
              )
            },
            togglePath(path: string) {
              const session = key()
              const current = store.sessionView[session]?.reviewOpen
              if (!current || !current.includes(path)) {
                this.openPath(path)
                return
              }

              this.closePath(path)
            },
          },
        }
      },
      tabs(sessionKey: string | Accessor<string>) {
        const key = createSessionKeyReader(sessionKey, ensureKey)
        const path = createMemo(() => sessionPath(key()))
        const tabs = createMemo(() => store.sessionTabs[key()] ?? { all: [] })
        const normalize = (tab: string) => normalizeSessionTab(path(), tab)
        const normalizeAll = (all: string[]) => normalizeSessionTabList(path(), all)
        const apply = (session: string, next: ReturnType<typeof openSessionTab>) => {
          batch(() => {
            setStore("sessionTabs", session, next.tabs)
            setEphemeral("sessionTabPreview", session, next.preview)
          })
        }
        return {
          tabs,
          active: createMemo(() => tabs().active),
          all: createMemo(() => tabs().all.filter((tab) => tab !== "review")),
          preview: createMemo(() => ephemeral.sessionTabPreview[key()]),
          setActive(tab: string | undefined) {
            const session = key()
            const next = tab ? normalize(tab) : tab
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [], active: next })
            } else {
              setStore("sessionTabs", session, "active", next)
            }
          },
          /** Clears the active tab. setActive(undefined) does the same. */
          clearActive() {
            const session = key()
            if (!store.sessionTabs[session]) {
              setStore("sessionTabs", session, { all: [] })
              return
            }
            setStore(
              "sessionTabs",
              session,
              produce((draft) => {
                delete draft.active
              }),
            )
          },
          setAll(all: string[]) {
            const session = key()
            const next = normalizeAll(all).filter((tab) => tab !== "review")
            batch(() => {
              if (!store.sessionTabs[session]) {
                setStore("sessionTabs", session, { all: next })
              } else {
                setStore("sessionTabs", session, "all", next)
              }
              const preview = ephemeral.sessionTabPreview[session]
              if (preview && !next.includes(preview))
                setEphemeral(
                  "sessionTabPreview",
                  produce((draft) => {
                    delete draft[session]
                  }),
                )
            })
          },
          // The tab API keeps its Promise contract; the update itself runs synchronously in this call.
          open(tab: string): Promise<void> {
            return Effect.runPromise(
              Effect.sync(() => {
                const session = key()
                apply(
                  session,
                  openSessionTab(
                    { tabs: store.sessionTabs[session] ?? { all: [] }, preview: ephemeral.sessionTabPreview[session] },
                    normalize(tab),
                  ),
                )
              }),
            )
          },
          previewTab(tab: string) {
            const session = key()
            apply(
              session,
              previewSessionTab(
                { tabs: store.sessionTabs[session] ?? { all: [] }, preview: ephemeral.sessionTabPreview[session] },
                normalize(tab),
              ),
            )
          },
          close(tab: string) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            apply(
              session,
              closeSessionTab({ tabs: current, preview: ephemeral.sessionTabPreview[session] }, normalize(tab)),
            )
          },
          move(tab: string, to: number) {
            const session = key()
            const current = store.sessionTabs[session]
            if (!current) return
            const index = current.all.findIndex((f) => f === tab)
            if (index === -1) return
            setStore(
              "sessionTabs",
              session,
              "all",
              produce((opened) => {
                opened.splice(to, 0, opened.splice(index, 1)[0])
              }),
            )
          },
        }
      },
    }
  },
})

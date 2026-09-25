import {
  createEffect,
  createMemo,
  createResource,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import {
  Clock,
  Data,
  DateTime,
  Duration,
  Effect,
  HashMap,
  HashSet,
  MutableHashMap,
  MutableHashSet,
  Option,
  Schedule,
  Schema,
} from "effect"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useNavigate, useParams } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/core/util/path"
import { Session } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { dismissToast, setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { normalizeProjectInfo } from "@/context/global-sync/utils"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/core/util/binary"
import { playSoundById } from "@/utils/sound"
import { createAim } from "@/utils/aim"
import { createFiberSlot } from "@/utils/fiber-slot"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { listAllSessions } from "@/utils/session"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useDirectoryPicker } from "@/components/directory-picker"
import { ServerConnection, useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  latestRootSession,
  sortedRootSessions,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  LocalWorkspace,
  SortableWorkspace,
  WorkspaceDragOverlay,
  type WorkspaceSidebarContext,
} from "./layout/sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./layout/sidebar-project"
import { SidebarContent } from "./layout/sidebar-shell"

const DeepLinkDetail = Schema.Struct({ urls: Schema.mutable(Schema.Array(Schema.String)) }).annotate({
  identifier: "Layout.DeepLinkDetail",
})
const decodeDeepLinkDetail = Schema.decodeUnknownOption(DeepLinkDetail)

/** A server request of the layout that rejected. `cause` is the original rejection. */
class LayoutRequestError extends Data.TaggedError("App.LayoutRequestError")<{ readonly cause: unknown }> {}

/** Runs one server request as an Effect. A rejection fails with LayoutRequestError. */
const layoutRequest = <A,>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new LayoutRequestError({ cause }) })

/**
 * Runs a layout action in the background. A failure or defect goes to the
 * Effect logger, as an unhandled rejection went to the console before.
 */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}

/** The persisted layout page state. An absent drag key means no drag is active. */
type LayoutPageStore = {
  lastProjectSession: { [directory: string]: { directory: string; id: string; at: number } }
  activeProject?: string
  activeWorkspace?: string
  workspaceOrder: Record<string, string[]>
  workspaceName: Record<string, string>
  workspaceBranchName: Record<string, Record<string, string>>
  workspaceExpanded: Partial<Record<string, boolean>>
  gettingStartedDismissed: boolean
}

/** The in-memory layout UI state. An absent optional key means nothing is hovered, peeked or scrolled to. */
type LayoutUiState = {
  autoselect: boolean
  busyWorkspaces: Partial<Record<string, boolean>>
  hoverProject?: string
  scrollSessionKey?: string
  nav?: HTMLElement
  sortNow: number
  sizing: boolean
  peek?: string
  peeked: boolean
  debugTools: boolean
}

/** The layout reads the global provider catalog, so it names no project directory. */
const globalCatalog = Option.none<string>()

/** A root session has no parent. The session list API takes that as `parentID: null`. */
const rootSessionParent = Option.none<string>()

export default function LegacyLayout(props: ParentProps) {
  const serverSDK = useServerSDK()
  const [store, setStore, , ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"]),
    createStore<LayoutPageStore>({
      lastProjectSession: {},
      workspaceOrder: {},
      workspaceName: {},
      workspaceBranchName: {},
      workspaceExpanded: {},
      gettingStartedDismissed: false,
    }),
  )

  const pageReady = createMemo(() => ready())

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false

  const params = useParams()
  const serverSync = useServerSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const settings = useSettings()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  const providers = useProviders(() => Option.getOrUndefined(globalCatalog))
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  createEffect(() => setV2Toast(false))
  const initialDirectory = decode64(params.dir)
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = serverSync().peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)

  const [state, setState] = createStore<LayoutUiState>({
    autoselect: !initialDirectory,
    busyWorkspaces: {},
    sortNow: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    sizing: false,
    peeked: false,
    debugTools: true,
  })

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return undefined
    return state.version
  }
  const installUpdate = () => void platform.updater?.install()
  const titlebarUpdate: TitlebarUpdate = {
    version: updateVersion,
    installing: () => platform.updater?.state().status === "installing",
    install: installUpdate,
  }

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]
  const navLeave = createFiberSlot()
  const sortNow = () => state.sortNow
  const sizingReset = createFiberSlot()
  const sortNowTicker = createFiberSlot()
  const updateSortNow = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => setState("sortNow", now)))
  // Refresh sortNow on each minute boundary, then every minute.
  sortNowTicker.run(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.sleep(Duration.millis(60_000 - (now % 60_000)))
      yield* Effect.repeat(updateSortNow, Schedule.spaced("60 seconds"))
    }),
  )

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      serverSync().child(directory)
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    aim.reset()
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    const blur = () => reset()
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "blur", blur)
    makeEventListener(document, "visibilitychange", hide)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverState = (value: Option.Option<string>) =>
    Option.match(value, {
      onSome: (directory) => setState("hoverProject", directory),
      onNone: () =>
        setState(
          produce((draft) => {
            delete draft.hoverProject
          }),
        ),
    })
  const setHoverProject = (value: Option.Option<string>) => {
    setHoverState(value)
    if (Option.isSome(value)) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(Option.none()))

  const disarm = () => navLeave.interrupt()

  const reset = () => {
    disarm()
    setHoverProject(Option.none())
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    navLeave.run(Effect.sleep("300 millis").pipe(Effect.andThen(Effect.sync(() => setHoverProject(Option.none())))))
  }

  const peekClose = createFiberSlot()

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return undefined
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return undefined
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      peekClose.interrupt()
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    peekClose.run(
      Effect.sleep("180 millis").pipe(
        Effect.andThen(
          Effect.sync(() =>
            setState(
              produce((draft) => {
                delete draft.peek
              }),
            ),
          ),
        ),
      ),
    )
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(Option.none())
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  const navigateWithSidebarReset = (href: string) => {
    clearSidebarHoverState()
    navigate(href)
    layout.mobileSidebar.hide()
  }

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = MutableHashMap.empty<string, number>()
      const alertedAtBySession = MutableHashMap.empty<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = MutableHashMap.get(toastBySession, sessionKey)
        if (Option.isNone(toastId)) return
        dismissToast(toastId.value)
        MutableHashMap.remove(toastBySession, sessionKey)
        MutableHashMap.remove(alertedAtBySession, sessionKey)
      }

      const unsub = serverSDK().event.listen((e) => {
        if (e.details?.type === "worktree.ready") {
          setBusy(e.name, false)
          WorktreeState.ready(serverSDK().scope, e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          setBusy(e.name, false)
          WorktreeState.failed(
            serverSDK().scope,
            e.name,
            e.details.properties?.message ?? language.t("common.requestFailed"),
          )
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const props = e.details.properties
        if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

        const [store] = serverSync().child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
        const lastAlerted = Option.getOrElse(MutableHashMap.get(alertedAtBySession, sessionKey), () => 0)
        if (now - lastAlerted < cooldownMs) return
        MutableHashMap.set(alertedAtBySession, sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, () => navigate(href))
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, () => navigate(href))
          }
        }

        const currentSession = params.id
        if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
        if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        MutableHashMap.set(toastBySession, sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${currentDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = serverSync().child(currentDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${currentDir()}:${child.id}`)
        }
      })
    })

  useSDKNotificationToasts()

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    const directory = currentDir()
    if (!directory) return undefined
    const key = pathKey(directory)

    const projects = layout.projects.list()

    const sandbox = projects.find((p) => p.sandboxes?.some((item) => pathKey(item) === key))
    if (sandbox) return sandbox

    const direct = projects.find((p) => pathKey(p.worktree) === key)
    if (direct) return direct

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return undefined

    const meta = serverSync().data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return undefined

    return projects.find((p) => p.worktree === root)
  })

  // `await` on a missing ready promise still resumed after the setup; yieldNow keeps that order.
  const waitFor = (promise: Promise<unknown> | undefined) =>
    Option.match(Option.fromNullishOr(promise), {
      onNone: () => Effect.yieldNow,
      onSome: (pending) => Effect.asVoid(Effect.promise(() => pending)),
    })

  const [autoselecting] = createResource(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* waitFor(ready.promise)
        yield* waitFor(layout.ready.promise)
        if (!untrack(() => state.autoselect)) return

        const list = layout.projects.list()
        const last = server.projects.last()

        if (list.length === 0) {
          if (!last) return
          yield* openProjectEffect(last)
          return
        }
        const next = list.find((project) => project.worktree === last) ?? list[0]
        if (!next) return
        yield* openProjectEffect(next.worktree)
      }),
    ),
  )

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return undefined
    if (!branch) return undefined
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = pathKey(directory) === pathKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = pathKey(directory)
      const project = projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      )
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe())
    const dirs = visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = serverSync().child(dir, { bootstrap: true })
      const dirSessions = sortedRootSessions(dirStore, now)
      result.push(...dirSessions)
    }
    return result
  })

  type PrefetchQueue = {
    inflight: MutableHashSet.MutableHashSet<string>
    pending: string[]
    pendingSet: MutableHashSet.MutableHashSet<string>
    running: number
  }

  const prefetchChunk = 200
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = MutableHashMap.empty<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = MutableHashMap.empty<string, MutableHashSet.MutableHashSet<string>>()

  const lruFor = (directory: string) => {
    const existing = MutableHashMap.get(prefetchedByDir, directory)
    if (Option.isSome(existing)) return existing.value
    const created = MutableHashSet.empty<string>()
    MutableHashMap.set(prefetchedByDir, directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      ...(params.id && pathKey(directory) === pathKey(currentDir()) ? { preserve: [params.id] } : {}),
    })
  }

  createEffect(() => {
    const active = HashSet.fromIterable(visibleSessionDirs())
    for (const directory of MutableHashMap.keys(prefetchedByDir)) {
      if (HashSet.has(active, directory)) continue
      MutableHashMap.remove(prefetchedByDir, directory)
    }
  })

  createEffect(() => {
    route()
    serverSDK().url

    prefetchToken.value += 1
    MutableHashMap.clear(prefetchQueues)
  })

  createEffect(() => {
    const visible = HashSet.fromIterable(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (HashSet.has(visible, directory)) continue
      q.pending.length = 0
      MutableHashSet.clear(q.pendingSet)
      if (q.running === 0) MutableHashMap.remove(prefetchQueues, directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = MutableHashMap.get(prefetchQueues, directory)
    if (Option.isSome(existing)) return existing.value

    const created: PrefetchQueue = {
      inflight: MutableHashSet.empty(),
      pending: [],
      pendingSet: MutableHashSet.empty(),
      running: 0,
    }
    MutableHashMap.set(prefetchQueues, directory, created)
    return created
  }

  const prefetchMessages = Effect.fnUntraced(function* (directory: string, sessionID: string, token: number) {
    yield* layoutRequest(() => serverSync().session.prefetch(sessionID, prefetchChunk)).pipe(Effect.ignore)
    if (prefetchToken.value !== token) return
    for (const stale of markPrefetched(directory, sessionID)) serverSync().session.evict(stale)
  })

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    MutableHashSet.remove(q.pendingSet, sessionID)
    MutableHashSet.add(q.inflight, sessionID)
    q.running += 1

    const token = prefetchToken.value

    runDetached(
      prefetchMessages(directory, sessionID, token).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            q.running -= 1
            MutableHashSet.remove(q.inflight, sessionID)
            pumpPrefetch(directory)
          }),
        ),
      ),
    )
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const cached = untrack(() => !serverSync().session.shouldPrefetch(session.id, prefetchChunk))
    if (cached) return

    const q = queueFor(directory)
    if (MutableHashSet.has(q.inflight, session.id)) return
    if (MutableHashSet.has(q.pendingSet, session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = MutableHashSet.has(lru, session.id)
    if (!known && MutableHashSet.size(lru) >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    MutableHashSet.add(q.pendingSet, session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      MutableHashSet.remove(q.pendingSet, dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const index = params.id ? sessions.findIndex((s) => s.id === params.id) : 0
    if (index === -1) return

    if (!params.id) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const sessionIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1

    let targetIndex: number
    if (sessionIndex === -1) {
      targetIndex = offset > 0 ? 0 : sessions.length - 1
    } else {
      targetIndex = (sessionIndex + offset + sessions.length) % sessions.length
    }

    const session = sessions[targetIndex]
    if (!session) return

    prefetchSession(session, "high")
    warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const active = Option.fromNullishOr(currentProject()?.worktree).pipe(
      Option.orElse(() => (currentDir() ? Option.some(projectRoot(currentDir())) : Option.none())),
    )
    const index = Option.match(active, {
      onNone: () => -1,
      onSome: (worktree) => projects.findIndex((project) => project.worktree === worktree),
    })

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    serverSync().child(target.worktree)
    openProject(target.worktree)
  }

  function navigateToProjectIndex(index: number) {
    const projects = layout.projects.list()
    const target = projects[index]
    if (!target) return

    serverSync().child(target.worktree)
    openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const hasUnseen = sessions.some((session) => notification.session.unseenCount(session.id) > 0)
    if (!hasUnseen) return

    const activeIndex = params.id ? sessions.findIndex((s) => s.id === params.id) : -1
    const start = activeIndex === -1 ? (offset > 0 ? -1 : 0) : activeIndex

    for (let i = 1; i <= sessions.length; i++) {
      const index = offset > 0 ? (start + i) % sessions.length : (start - i + sessions.length) % sessions.length
      const session = sessions[index]
      if (!session) continue
      if (notification.session.unseenCount(session.id) === 0) continue

      prefetchSession(session, "high")
      warm(sessions, index)

      navigateToSession(session)
      return
    }
  }

  // The sidebar contract returns a Promise; it rejects with the original update error.
  const archiveSession = (session: Session): Promise<void> =>
    Effect.runPromise(
      Effect.gen(function* () {
        if ((yield* Effect.promise(() => serverSDK().protocol)) !== "v1") return
        const [store, setStore] = serverSync().child(session.directory)
        const sessions = store.session ?? []
        const index = sessions.findIndex((s) => s.id === session.id)
        const nextSession = sessions[index + 1] ?? sessions[index - 1]

        const archived = yield* Clock.currentTimeMillis
        yield* Effect.promise(() =>
          serverSDK().client.session.update({
            sessionID: session.id,
            directory: session.directory,
            time: { archived },
          }),
        )
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, session.id, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
        if (session.id === params.id) {
          if (nextSession) {
            navigate(`/${params.dir}/session/${nextSession.id}`)
          } else {
            navigate(`/${params.dir}/session`)
          }
        }
      }),
    )

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          runDetached(createWorkspace(project))
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    const projectCommands = Array.from({ length: 9 }, (_, index): CommandOption => {
      const number = index + 1
      return {
        id: `project.${number}`,
        category: language.t("command.category.project"),
        title: `Open Project {number}`,
        keybind: `mod+${number}`,
        disabled: layout.projects.list().length <= index,
        hidden: true,
        onSelect: () => navigateToProjectIndex(index),
      }
    })

    const themeCommands = availableThemeEntries().map(
      ([id]): CommandOption => ({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      }),
    )

    const schemeCommands = colorSchemeOrder.map(
      (scheme): CommandOption => ({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      }),
    )

    const languageCommands = language.locales.map(
      (locale): CommandOption => ({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      }),
    )

    return [
      ...commands,
      ...projectCommands,
      ...themeCommands,
      {
        id: "theme.scheme.cycle",
        title: language.t("command.theme.scheme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+s",
        onSelect: () => cycleColorScheme(1),
      },
      ...schemeCommands,
      {
        id: "language.cycle",
        title: language.t("command.language.cycle"),
        category: language.t("command.category.language"),
        onSelect: () => cycleLanguage(1),
      },
      ...languageCommands,
    ]
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-connect-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogConnectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openSettings() {
    const run = ++dialogRun
    const module = settings.general.newLayoutDesigns()
      ? import("@/components/settings-v2")
      : import("@/components/dialog-settings")
    void module.then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogSettings />)
    })
  }

  function projectRoot(directory: string) {
    const key = pathKey(directory)
    const project = layout.projects
      .list()
      .find((item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key))
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = serverSync().data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: DateTime.toEpochMillis(DateTime.nowUnsafe()) })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded === false) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  const navigateToProjectEffect = Effect.fn("Layout.navigateToProject")(function* (directory: string) {
    const root = projectRoot(directory)
    server.projects.touch(root)
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = Effect.fnUntraced(function* (target: string) {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const projectID: Effect.Effect<string, LayoutRequestError> = Option.match(Option.fromNullishOr(project?.id), {
        onSome: (id) => Effect.succeed(id),
        onNone: () =>
          layoutRequest(() => serverSDK().api.project.current({ location: { directory: root } })).pipe(
            Effect.map((value) => value.id),
          ),
      })
      const listed = yield* projectID.pipe(
        Effect.flatMap((id) =>
          layoutRequest(() => serverSDK().api.project.directories({ projectID: id, location: { directory: root } })),
        ),
        Effect.map((items) => items.map((item) => item.directory).filter((item) => pathKey(item) !== pathKey(root))),
        Effect.orElseSucceed((): string[] => []),
      )
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    })
    const openSession = Effect.fnUntraced(function* (target: { directory: string; id: string }) {
      if (!canOpen(target.directory)) return false
      const sync = serverSync().ensureDirSyncContext(target.directory)
      if (sync.session.get(target.id)) {
        setStore("lastProjectSession", root, {
          directory: target.directory,
          id: target.id,
          at: yield* Clock.currentTimeMillis,
        })
        navigateWithSidebarReset(`/${base64Encode(target.directory)}/session/${target.id}`)
        return true
      }
      const resolved = yield* layoutRequest(() => sync.session.sync(target.id)).pipe(
        Effect.map(() => Option.fromNullishOr(sync.session.get(target.id))),
        Effect.orElseSucceed(() => Option.none()),
      )
      const session = Option.filter(resolved, (item) => !!item.directory && canOpen(item.directory))
      if (Option.isNone(session)) return false
      setStore("lastProjectSession", root, {
        directory: session.value.directory,
        id: session.value.id,
        at: yield* Clock.currentTimeMillis,
      })
      navigateWithSidebarReset(`/${base64Encode(session.value.directory)}/session/${session.value.id}`)
      return true
    })

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      yield* refreshDirs(projectSession.directory)
      const opened = yield* openSession(projectSession)
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession(
      dirs.map((item) => serverSync().child(item, { bootstrap: false })[0]),
      yield* Clock.currentTimeMillis,
    )
    if (latest && (yield* openSession(latest))) {
      return
    }

    const listed = yield* Effect.forEach(
      dirs,
      (item) =>
        layoutRequest(() =>
          listAllSessions(serverSDK().api.session, {
            directory: item,
            parentID: Option.getOrNull(rootSessionParent),
            order: "desc",
          }),
        ).pipe(
          Effect.orElseSucceed(() => []),
          Effect.map((session) => ({ path: { directory: item }, session })),
        ),
      { concurrency: "unbounded" },
    )
    const fetched = latestRootSession(listed, yield* Clock.currentTimeMillis)
    if (fetched && (yield* openSession(fetched))) {
      return
    }

    navigateWithSidebarReset(`/${base64Encode(root)}/session`)
  })

  function navigateToProject(directory: string | undefined) {
    if (!directory) return
    runDetached(navigateToProjectEffect(directory))
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    navigateWithSidebarReset(`/${base64Encode(session.directory)}/session/${session.id}`)
  }

  const openProjectEffect = (directory: string) =>
    Effect.sync(() => layout.projects.open(directory)).pipe(Effect.andThen(navigateToProjectEffect(directory)))

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) navigateToProject(directory)
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(slug)), {
          prompt: link.prompt,
        })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const urls = Option.match(decodeDeepLinkDetail(event.detail), {
        onNone: () => [],
        onSome: (detail) => detail.urls,
      })
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      const projectID = project.id
      const sdk = serverSDK()
      runDetached(
        Effect.gen(function* () {
          if ((yield* Effect.promise(() => sdk.protocol)) !== "v1") return
          const response = yield* layoutRequest(() =>
            sdk.client.project.update({ projectID, directory: project.worktree, name }),
          )
          const result = response.data
          if (!result) return
          // const result = await serverSDK().api.project.update({ projectID: project.id, name })
          serverSync().set("project", (items) =>
            items.map((item) => (item.id === result.id ? normalizeProjectInfo(result) : item)),
          )
        }),
      )
      return
    }

    serverSync().project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (list.length === 1) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    const next = list[index + 1] ?? list[index - 1]

    navigateWithSidebarReset(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (conn: ServerConnection.Any, project: LocalProject) => {
    const run = ++dialogRun
    void import("@/components/dialog-edit-project").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function chooseProject() {
    const conn = server.current
    if (!conn) return
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory, false)
        }
        navigateToProject(result[0])
      } else if (result) {
        openProject(result)
      }
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  const deleteWorkspace = Effect.fn("Layout.deleteWorkspace")(function* (
    root: string,
    directory: string,
    leaveDeletedWorkspace = false,
  ) {
    if (directory === root) return

    const current = currentDir()
    const currentKey = pathKey(current)
    const deletedKey = pathKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = yield* layoutRequest(() =>
      serverSDK().client.worktree.remove({ directory: root, worktreeRemoveInput: { directory } }),
    ).pipe(
      Effect.map((x) => x.data),
      Effect.catch((error) =>
        Effect.sync(() => {
          showToast({
            title: language.t("workspace.delete.failed.title"),
            description: errorMessage(error.cause, language.t("common.requestFailed")),
          })
          return false
        }),
      ),
    )

    setBusy(directory, false)

    if (!result) return

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    serverSync().set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = pathKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigateWithSidebarReset(`/${base64Encode(root)}/session`)
    }
  })

  const resetWorkspace = Effect.fn("Layout.resetWorkspace")(function* (root: string, directory: string) {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => dismissToast(progress)

    const sessions = yield* layoutRequest(() =>
      listAllSessions(serverSDK().api.session, { directory, order: "desc" }),
    ).pipe(Effect.orElseSucceed(() => []))

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      serverSDK().scope,
    )
    yield* layoutRequest(() => serverSDK().client.instance.dispose({ directory })).pipe(Effect.ignore)

    const result = yield* layoutRequest(() =>
      serverSDK().client.worktree.reset({ directory: root, worktreeResetInput: { directory } }),
    ).pipe(
      Effect.map((x) => x.data),
      Effect.catch((error) =>
        Effect.sync(() => {
          showToast({
            title: language.t("workspace.reset.failed.title"),
            description: errorMessage(error.cause, language.t("common.requestFailed")),
          })
          return false
        }),
      ),
    )

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    if ((yield* Effect.promise(() => serverSDK().protocol)) === "v1") {
      const archived = yield* Clock.currentTimeMillis
      yield* Effect.forEach(
        sessions.filter((session) => session.time.archived === undefined),
        (session) =>
          layoutRequest(() =>
            serverSDK().client.session.update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived },
            }),
          ).pipe(Effect.ignore),
        { concurrency: "unbounded", discard: true },
      )
    }

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  })

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      runDetached(
        layoutRequest(() => serverSDK().api.vcs.status({ location: { directory: props.directory } })).pipe(
          Effect.match({
            onSuccess: (result) => {
              const files = result.data
              const dirty = files.length > 0
              setData({ status: "ready", dirty })
            },
            onFailure: () => {
              setData({ status: "error", dirty: false })
            },
          }),
        ),
      )
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!params.dir && pathKey(currentDir()) === pathKey(props.directory)
      if (leaveDeletedWorkspace) {
        navigateWithSidebarReset(`/${base64Encode(props.root)}/session`)
      }
      dialog.close()
      runDetached(deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace))
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = Effect.gen(function* () {
      const sessions = yield* layoutRequest(() =>
        listAllSessions(serverSDK().api.session, {
          directory: props.directory,
          order: "desc",
        }),
      ).pipe(Effect.orElseSucceed(() => []))
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    })

    onMount(() => {
      runDetached(
        layoutRequest(() => serverSDK().api.vcs.status({ location: { directory: props.directory } })).pipe(
          Effect.matchEffect({
            onSuccess: (result) =>
              Effect.sync(() => {
                const files = result.data
                const dirty = files.length > 0
                setState({ status: "ready", dirty })
              }).pipe(Effect.andThen(refresh)),
            onFailure: () => Effect.sync(() => setState({ status: "error", dirty: false })),
          }),
        ),
      )
    })

    const handleReset = () => {
      dialog.close()
      runDetached(resetWorkspace(props.root, props.directory))
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = rememberSessionRoute(dir, id, root)
      },
    ),
  )

  createEffect(() => {
    document.documentElement.style.setProperty(
      "--dialog-left-margin",
      `${layout.sidebar.opened() ? layout.sidebar.width() : 48}px`,
    )
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  let loadedSessionDirs = HashSet.empty<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs = HashSet.empty()
          return
        }

        loadedSessionDirs = dirs.reduce((next, directory) => {
          if (HashSet.has(next, directory)) return next
          if (!HashSet.has(loadedSessionDirs, directory)) void serverSync().project.loadSessions(directory)
          return HashSet.add(next, directory)
        }, HashSet.empty<string>())
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(Option.none())
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore(
      produce((draft) => {
        delete draft.activeProject
      }),
    )
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    // Only the active project shows the current directory when it is not a known workspace yet.
    const extra =
      pathKey(active?.worktree ?? "") === pathKey(project.worktree)
        ? Option.filter(
            Option.some(currentDir()),
            (directory) =>
              !!directory &&
              pathKey(directory) !== pathKey(local) &&
              !dirs.some((item) => pathKey(item) === pathKey(directory)),
          )
        : Option.none<string>()

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (Option.isNone(extra)) return ordered
    const pending = WorktreeState.get(serverSDK().scope, extra.value)?.status === "pending"
    if (pending) return [local, extra.value, ...ordered.filter((item) => item !== local)]
    return [...ordered, extra.value]
  }

  const sidebarProject = createMemo(() => {
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore(
      produce((draft) => {
        delete draft.activeWorkspace
      }),
    )
  }

  const createWorkspace = Effect.fn("Layout.createWorkspace")(function* (project: LocalProject) {
    clearSidebarHoverState()
    const response = yield* layoutRequest(() =>
      serverSDK().client.worktree.create({ directory: project.worktree }),
    ).pipe(
      Effect.map((x) => Option.fromNullishOr(x.data)),
      Effect.catch((error) =>
        Effect.sync(() => {
          showToast({
            title: language.t("workspace.create.failed.title"),
            description: errorMessage(error.cause, language.t("common.requestFailed")),
          })
          return Option.none()
        }),
      ),
    )

    if (Option.isNone(response) || !response.value.directory) return
    const created = response.value

    setWorkspaceName(created.directory, created.branch ?? getFilename(created.directory), project.id, created.branch)

    const local = project.worktree
    const key = pathKey(created.directory)
    const root = pathKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(serverSDK().scope, created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = pathKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    serverSync().child(created.directory)
    navigateWithSidebarReset(`/${base64Encode(created.directory)}/session`)
  })

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setHoverState(hoverOpen ? Option.some(worktree) : Option.none())
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    showEditProjectDialog: (proj) => showEditProjectDialog(server.current!, proj),
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    mobile?: boolean
    merged?: boolean
  }) => {
    const project = panelProps.project
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !params.dir && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => serverSync().data.path.home)

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border rounded-tl-[12px] px-3": true,
          "border border-b-0 border-border-weak-base": !merged(),
          "border-l border-t border-border-weaker-base": merged(),
          "bg-background-base": merged() || hover(),
          "bg-background-stronger": !merged() && !hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={panelProps.mobile ? {} : { width: `${panel()}px` }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                    {language.t("command.project.open")}
                  </Button>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div class="shrink-0 pl-1 py-1">
                <div class="group/project flex items-start justify-between gap-2 py-2 pl-2 pr-0">
                  <div class="flex flex-col min-w-0">
                    <InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      onSave={(next) => {
                        renameProject(project, next)
                      }}
                      class="text-14-medium text-text-strong truncate"
                      displayClass="text-14-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item
                          onSelect={() => {
                            showEditProjectDialog(server.current!, project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          data-project={slug()}
                          disabled={!canToggle()}
                          onSelect={() => {
                            toggleProjectWorkspaces(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0 py-4">
                        <Button
                          size="large"
                          class="w-full"
                          onClick={() => {
                            const dir = worktree()
                            if (!dir) return
                            navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                          }}
                        >
                          <IconV2 name="edit" size="small" />
                          {language.t("command.session.new")}
                        </Button>
                      </div>
                      <div class="flex-1 min-h-0">
                        <LocalWorkspace
                          ctx={workspaceSidebarCtx}
                          project={project}
                          sortNow={sortNow}
                          mobile={panelProps.mobile}
                        />
                      </div>
                    </>
                  }
                >
                  <>
                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="plus-small"
                        class="w-full"
                        onClick={() => {
                          runDetached(createWorkspace(project))
                        }}
                      >
                        {language.t("workspace.new")}
                      </Button>
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            if (!panelProps.mobile) scrollContainerRef = el
                          }}
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                        >
                          <SortableProvider ids={workspaces()}>
                            <For each={workspaces()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={workspaceSidebarCtx}
                                  directory={directory}
                                  project={project}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
              </div>
            </>
          )}
        </Show>

        <div
          class="shrink-0 px-3 py-3"
          classList={{
            hidden:
              store.gettingStartedDismissed || !(HashMap.size(providers.all()) > 0 && providers.paid().length === 0),
          }}
        >
          <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
            <div class="p-3 flex flex-col gap-6">
              <div class="flex flex-col gap-2">
                <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line1")}
                </div>
                <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                  {language.t("sidebar.gettingStarted.line2")}
                </div>
              </div>
              <div data-component="getting-started-actions">
                <Button size="large" icon="plus-small" onClick={connectProvider}>
                  {language.t("command.provider.connect")}
                </Button>
                <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                  {language.t("toast.update.action.notYet")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const projects = () => layout.projects.list()
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      aimMove={aim.move}
      projects={projects}
      renderProject={(project) => (
        <SortableProject ctx={projectSidebarCtx} project={project} sortNow={sortNow} mobile={mobile} />
      )}
      handleDragStart={handleDragStart}
      handleDragEnd={handleDragEnd}
      handleDragOver={handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={chooseProject}
      renderProjectOverlay={projectOverlay}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      helpLabel={() => language.t("sidebar.help")}
      onOpenHelp={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
      renderPanel={() =>
        mobile ? <SidebarPanel project={currentProject} mobile /> : <SidebarPanel project={currentProject} merged />
      }
    />
  )

  return (
    <div class="relative bg-background-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
      {autoselecting() ?? ""}
      <Titlebar
        update={titlebarUpdate}
        {...(import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1"
          ? { debugTools: { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) } }
          : {})}
      />
      <Show when={updateVersion() !== undefined}>
        <UpdateAvailableToast version={updateVersion() ?? ""} install={installUpdate} language={language} />
      </Show>
      <div class="flex-1 min-h-0 min-w-0 flex">
        <div class="flex-1 min-h-0 relative">
          <div class="size-full relative overflow-x-hidden">
            <nav
              aria-label={language.t("sidebar.nav.projectsAndSessions")}
              data-component="sidebar-nav-desktop"
              classList={{
                "hidden xl:block": true,
                "absolute inset-y-0 start-0": true,
                "z-10": true,
              }}
              style={{ width: `${side()}px` }}
              ref={(el) => {
                setState("nav", el)
              }}
              onMouseEnter={() => {
                disarm()
              }}
              onMouseLeave={() => {
                aim.reset()
                if (!sidebarHovering()) return

                arm()
              }}
            >
              <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
            </nav>

            <Show when={layout.sidebar.opened()}>
              <div
                class="hidden xl:block absolute inset-y-0 z-30 w-0 overflow-visible"
                style={{ "inset-inline-start": `${side()}px` }}
                onPointerDown={() => setState("sizing", true)}
              >
                <ResizeHandle
                  direction="horizontal"
                  size={layout.sidebar.width()}
                  min={244}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                  onResize={(w) => {
                    setState("sizing", true)
                    sizingReset.run(
                      Effect.sleep("120 millis").pipe(Effect.andThen(Effect.sync(() => setState("sizing", false)))),
                    )
                    layout.sidebar.resize(w)
                  }}
                />
              </div>
            </Show>

            <div
              class="hidden xl:block pointer-events-none absolute top-0 end-0 z-0 border-t border-border-weaker-base"
              style={{ "inset-inline-start": "calc(4rem + 12px)" }}
            />

            <div class="xl:hidden">
              <div
                classList={{
                  "fixed inset-x-0 top-10 bottom-0 z-40 transition-opacity duration-200": true,
                  "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                  "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                }}
              />
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-mobile"
                classList={{
                  "@container fixed top-10 bottom-0 start-0 z-50 w-full max-w-[400px] overflow-hidden border-e border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                  "translate-x-0": layout.mobileSidebar.opened(),
                  "ltr:-translate-x-full rtl:translate-x-full": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {sidebarContent(true)}
              </nav>
            </div>

            <div
              classList={{
                "absolute inset-0": true,
                "xl:inset-y-0 xl:end-0 xl:start-[var(--main-left)]": true,
                "z-20": true,
                "transition-[inset-inline-start] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[inset-inline-start] motion-reduce:transition-none":
                  !state.sizing,
              }}
              style={{
                "--main-left": layout.sidebar.opened() ? `${side()}px` : "4rem",
              }}
            >
              <main
                classList={{
                  "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base bg-background-base xl:border-s xl:rounded-ss-[12px]": true,
                }}
              >
                <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                  {props.children}
                </Show>
              </main>
            </div>

            <div
              classList={{
                "hidden xl:flex absolute inset-y-0 start-16 z-30": true,
                "opacity-100 translate-x-0 pointer-events-auto": state.peeked && !layout.sidebar.opened(),
                "opacity-0 ltr:-translate-x-2 rtl:translate-x-2 pointer-events-none":
                  !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              onMouseMove={disarm}
              onMouseEnter={() => {
                disarm()
                aim.reset()
              }}
              onPointerDown={disarm}
              onMouseLeave={() => {
                arm()
              }}
            >
              <Show when={peekProject()}>
                <SidebarPanel project={peekProject} merged={false} />
              </Show>
            </div>

            <div
              classList={{
                "hidden xl:block pointer-events-none absolute inset-y-0 end-0 z-25 overflow-hidden": true,
                "opacity-100 translate-x-0": state.peeked && !layout.sidebar.opened(),
                "opacity-0 ltr:-translate-x-2 rtl:translate-x-2": !state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !state.peeked || layout.sidebar.opened(),
              }}
              style={{ "inset-inline-start": `calc(4rem + ${panel()}px)` }}
            >
              <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-sidebar-overlay)" }} />
            </div>
          </div>
        </div>
        {import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1" && state.debugTools && <DebugBar />}
      </div>
      <TabsInfoPopup />
      <ToastRegion v2={false} />
    </div>
  )
}

function UpdateAvailableToast(props: {
  version: string
  install: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: "dismiss",
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    dismissToast(toastId)
  })

  return undefined
}

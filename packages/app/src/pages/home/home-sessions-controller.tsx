import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"
import { Data, DateTime, Effect, HashMap, HashSet, MutableHashSet } from "effect"
import { type Accessor, createEffect, createMemo, createRoot, type JSX, startTransition } from "solid-js"
import { produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { archiveHomeSession } from "../home-session-archive"
import type { HomeController } from "./home-controller"
import { sessionDayOf, type SessionDay } from "./home-time"

const HOME_SESSION_LIMIT = 64

/** A Home request that rejected. `cause` is the original rejection. */
class HomeSessionRequestError extends Data.TaggedError("App.HomeSessionRequestError")<{ readonly cause: unknown }> {}

/** Runs one Home request as an Effect. A rejection fails with HomeSessionRequestError. */
const homeRequest = <A,>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new HomeSessionRequestError({ cause }) })

/**
 * Runs a Home action in the background. A failure or defect goes to the
 * Effect logger, as an unhandled rejection went to the console before.
 */
const runDetached = <A, E>(effect: Effect.Effect<A, E>) => {
  Effect.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(cause))))
}
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const projectDirectories = createMemo(() => {
    const project = home.project.selected()
    if (!project) return home.project.list().flatMap(directories)
    return directories(project)
  })
  const homeSessions = () => home.server.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: (): Promise<HomeSessionEvents> => Effect.runPromise(Effect.succeed({ sequence: 0, entries: [] })),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: ({ signal }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const ctx = home.server.focusedContext()
          if (!ctx) return { sessions: [], eventSequence: 0 }
          const cache = homeSessions()
          const eventSequence = cache.eventSequence()
          const index = yield* homeRequest(() =>
            loadHomeSessionIndex(
              (input, options) => ctx.sdk.client.v2.session.list(input, options),
              eventSequence,
              signal,
            ),
          )
          cache.complete(eventSequence)
          return index
        }),
      ),
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      homeSessions().sessions(sessionLoad.data, sessionEventLoad.data),
      HOME_SESSION_LIMIT,
      DateTime.toEpochMillis(DateTime.nowUnsafe()),
    ),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const groups = createMemo(() => groupSessions(records(), language))
  const prefetched = MutableHashSet.empty<string>()

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (MutableHashSet.has(prefetched, key)) return
        MutableHashSet.add(prefetched, key)
        createRoot((dispose) => {
          const textParts = () =>
            (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
              (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) =>
                part.type === "text" && part.text ? [{ id: part.id, text: part.text }] : [],
              ),
            )
          // runFork starts the sync call at once, inside this root, as the direct call did.
          Effect.runFork(
            homeRequest(() => ctx.sync.session.sync(record.session.id)).pipe(
              Effect.andThen(() =>
                Effect.forEach(textParts(), (part) => homeRequest(() => preloadMarkdown(part.text, part.id)), {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ),
              // The prefetch is best effort: any failure only leaves the cache cold.
              Effect.ignoreCause,
              Effect.ensuring(Effect.sync(dispose)),
            ),
          )
        })
      })
  })

  command.register("home.palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: () => {
        const conn = home.server.focused()
        if (!conn) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        runDetached(
          Effect.map(
            Effect.promise(() => import("@/components/dialog-command-palette-v2")),
            ({ DialogHomeCommandPaletteV2 }) => {
              void dialog.show(() => (
                <DialogHomeCommandPaletteV2
                  server={conn}
                  onSelectSession={(entry) => {
                    if (!entry.sessionID || !entry.directory || !entry.server) return
                    const sessionID = entry.sessionID
                    const server = entry.server
                    const directory = entry.project?.worktree ?? entry.directory
                    ctx.projects.open(directory)
                    ctx.projects.touch(directory)
                    void startTransition(() => {
                      const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                      tabs.select(tab)
                    })
                  }}
                />
              ))
            },
          ),
        )
      },
    },
  ])

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isLoading,
      searchRecords: allRecords,
    },
    session: {
      showProjectName: () => !home.project.selected(),
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      create: home.project.openNewSession,
      open: (session: Session, options?: OpenSessionOptions) => {
        const directoryKey = pathKey(session.directory)
        const project =
          home.project
            .list()
            .find(
              (item) =>
                pathKey(item.worktree) === directoryKey ||
                item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
            ) ?? projectForSession(session, home.project.list())
        const conn = home.server.focused()
        if (!conn) return
        const directory = project?.worktree ?? session.directory
        const ctx = home.server.focusedContext()
        if (!ctx) return
        ctx.projects.open(directory)
        if (options?.background) {
          tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          return
        }
        ctx.projects.touch(directory)
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          tabs.select(tab)
        })
      },
      archive: (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        runDetached(
          Effect.gen(function* () {
            if ((yield* homeRequest(() => ctx.sdk.protocol)) !== "v1") return
            yield* archiveHomeSession({
              server: ServerConnection.key(conn),
              session,
              archive: (sessionID) =>
                ctx.sdk.client.session.update({
                  sessionID,
                  directory: session.directory,
                  time: { archived: DateTime.toEpochMillis(DateTime.nowUnsafe()) },
                }),
              remove: () => {
                setStore(
                  produce((draft) => {
                    const match = Binary.search(draft.session, session.id, (item) => item.id)
                    if (match.found) draft.session.splice(match.index, 1)
                  }),
                )
                homeSessions().remove(session.id)
              },
              onError: (cause) =>
                showToast({
                  title: language.t("common.requestFailed"),
                  description: errorMessage(cause, language.t("common.requestFailed")),
                }),
            })
          }),
        )
      },
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
}) {
  const directories = HashSet.fromIterable(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => HashSet.has(directories, pathKey(session.directory)))
  // Keep the last record of a repeated session ID.
  return HashMap.toValues(HashMap.fromIterable(sessions.map((session) => [session.id, session] as const)))
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const dayOf = sessionDayOf(DateTime.nowUnsafe(), DateTime.zoneMakeLocal())
  const days = records.map((record) => dayOf(record.session.time.updated ?? record.session.time.created))
  const sessionsOn = (day: SessionDay) => records.filter((_, index) => days[index] === day)
  const todaySessions = sessionsOn("today")
  const yesterdaySessions = sessionsOn("yesterday")
  const olderSessions = sessionsOn("older")
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")
  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}

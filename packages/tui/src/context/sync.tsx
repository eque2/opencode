import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { Cause, Clock, Data, Effect, Exit, Fiber, HashSet, MutableHashMap, MutableHashSet, Option } from "effect"
import { errorMessage } from "../util/error"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

// IDs that live events touched while a session hydrates; hydration keeps their live copies.
type HydrationTracker = {
  messages: MutableHashSet.MutableHashSet<string>
  parts: MutableHashSet.MutableHashSet<string>
}

/** A failed sync request. `message` is the text that Promise consumers see. */
class SyncRequestError extends Data.TaggedError("TuiSync.RequestError")<{
  readonly message: string
  readonly cause: unknown
}> {}

function request<A>(evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new SyncRequestError({ message: errorMessage(cause), cause }),
  })
}

// The value that made bootstrap fail: the raw rejection of a request, or the defect.
function failureReason(cause: Cause.Cause<SyncRequestError>): unknown {
  const failure = Cause.squash(cause)
  return failure instanceof SyncRequestError ? failure.cause : failure
}

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  init: () => {
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs?: VcsInfo
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = MutableHashSet.empty<string>()
    const syncingSessions = MutableHashMap.empty<string, Promise<void>>()
    const hydratingSessions = MutableHashMap.empty<string, HydrationTracker>()
    const touchMessage = (sessionID: string, messageID: string) => {
      const tracker = MutableHashMap.get(hydratingSessions, sessionID)
      if (Option.isSome(tracker)) MutableHashSet.add(tracker.value.messages, messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      const tracker = MutableHashMap.get(hydratingSessions, sessionID)
      if (Option.isSome(tracker)) MutableHashSet.add(tracker.value.parts, partID)
    }

    function sessionListQuery(): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    const listSessions = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const response = yield* request(() =>
        sdk.client.session.list({ start: now - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() }),
      )
      return (response.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))
    })

    event.subscribe((event, { directory, workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (permission.mode === "auto") {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const index = messages.findIndex((message) => message.id === event.properties.messageID)
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              // The delta names its target field at run time, so the part is
              // written through its record view.
              const part: Record<string, unknown> = draft[result.index]
              const existing = part[event.properties.field]
              part[event.properties.field] = (typeof existing === "string" ? existing : "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    const bootstrapProgram = (fatal: boolean) =>
      Effect.gen(function* () {
        const workspace = project.workspace.current()
        // Both start now; the session list is awaited in the blocking or the background phase.
        const projectSync = yield* Effect.forkDetach(
          request(() => project.sync()),
          { startImmediately: true },
        )
        const sessionList = yield* Effect.forkDetach(Fiber.join(projectSync).pipe(Effect.andThen(listSessions)), {
          startImmediately: true,
        })

        // blocking - include session.list when continuing a session
        const blocking = yield* Effect.all(
          {
            providers: request(() => sdk.client.config.providers({ workspace }, { throwOnError: true })),
            providerList: request(() => sdk.client.provider.list({ workspace }, { throwOnError: true })),
            capabilities: request(() =>
              sdk.client.experimental.capabilities.get({ workspace }, { throwOnError: true }),
            ).pipe(Effect.option),
            consoleState: request(() =>
              sdk.client.experimental.console.get({ workspace }, { throwOnError: true }),
            ).pipe(
              Effect.map((response) => response.data),
              Effect.orElseSucceed(() => emptyConsoleState),
            ),
            agents: request(() => sdk.client.app.agents({ workspace }, { throwOnError: true })),
            config: request(() => sdk.client.config.get({ workspace }, { throwOnError: true })),
            project: Fiber.join(projectSync),
            sessions: args.continue ? Effect.map(Fiber.join(sessionList), Option.some) : Effect.succeedNone,
          },
          { concurrency: "unbounded" },
        )

        batch(() => {
          setStore("provider", reconcile(blocking.providers.data.providers))
          setStore("provider_default", reconcile(blocking.providers.data.default))
          setStore("provider_next", reconcile(blocking.providerList.data))
          setStore(
            "capabilities",
            "experimentalBackgroundSubagents",
            Option.exists(blocking.capabilities, (response) => response.data.backgroundSubagents),
          )
          setStore("console_state", reconcile(blocking.consoleState))
          setStore("agent", reconcile(blocking.agents.data ?? []))
          setStore("config", reconcile(blocking.config.data))
          if (Option.isSome(blocking.sessions)) setStore("session", reconcile(blocking.sessions.value))
        })
        if (store.status !== "complete") setStore("status", "partial")

        // non-blocking - each request settles on its own; a failure is logged
        const background: ReadonlyArray<Effect.Effect<void, SyncRequestError>> = [
          ...(args.continue
            ? []
            : [Fiber.join(sessionList).pipe(Effect.map((sessions) => setStore("session", reconcile(sessions))))]),
          Effect.sync(() => setStore("console_state", reconcile(blocking.consoleState))),
          request(() => sdk.client.command.list({ workspace })).pipe(
            Effect.map((x) => setStore("command", reconcile(x.data ?? []))),
          ),
          request(() => sdk.client.lsp.status({ workspace })).pipe(
            Effect.map((x) => setStore("lsp", reconcile(x.data ?? []))),
          ),
          request(() => sdk.client.mcp.status({ workspace })).pipe(
            Effect.map((x) => setStore("mcp", reconcile(x.data ?? {}))),
          ),
          request(() => sdk.client.experimental.resource.list({ workspace })).pipe(
            Effect.map((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
          ),
          request(() => sdk.client.formatter.status({ workspace })).pipe(
            Effect.map((x) => setStore("formatter", reconcile(x.data ?? []))),
          ),
          request(() => sdk.client.session.status({ workspace })).pipe(
            Effect.map((x) => setStore("session_status", reconcile(x.data ?? {}))),
          ),
          request(() => sdk.client.provider.auth({ workspace })).pipe(
            Effect.map((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
          ),
          request(() => sdk.client.vcs.get({ workspace })).pipe(Effect.map((x) => setStore("vcs", reconcile(x.data)))),
          request(() => project.workspace.sync()),
        ]
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const exits = yield* Effect.forEach(background, (task) => Effect.exit(task), { concurrency: "unbounded" })
            const failures = exits.filter(Exit.isFailure)
            if (failures.length === 0) {
              setStore("status", "complete")
              return
            }
            yield* Effect.forEach(failures, (failure) => Effect.logError("tui background sync failed", failure.cause), {
              discard: true,
            })
          }),
          { startImmediately: true },
        )
      }).pipe(
        // A fatal bootstrap hands the original failure to exit; otherwise the caller gets the typed failure.
        Effect.catchCause((cause) =>
          Effect.logError("tui bootstrap failed", cause).pipe(
            Effect.andThen(fatal ? Effect.sync(() => exit(failureReason(cause))) : Effect.failCause(cause)),
          ),
        ),
      )

    function bootstrap(input: { fatal?: boolean } = {}) {
      return Effect.runPromise(bootstrapProgram(input.fatal ?? true))
    }

    onMount(() => {
      void bootstrap()
    })

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        refresh() {
          return Effect.runPromise(listSessions.pipe(Effect.map((list) => setStore("session", reconcile(list)))))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        sync(sessionID: string) {
          if (MutableHashSet.has(fullSyncedSessions, sessionID)) return Effect.runPromise(Effect.void)
          const syncing = MutableHashMap.get(syncingSessions, sessionID)
          if (Option.isSome(syncing)) return syncing.value
          const tracker: HydrationTracker = { messages: MutableHashSet.empty(), parts: MutableHashSet.empty() }
          MutableHashMap.set(hydratingSessions, sessionID, tracker)
          const hydrate = Effect.gen(function* () {
            const { session, messages, todo, diff } = yield* Effect.all(
              {
                session: request(() => sdk.client.session.get({ sessionID }, { throwOnError: true })),
                messages: request(() => sdk.client.session.messages({ sessionID, limit: 100 })),
                todo: request(() => sdk.client.session.todo({ sessionID })),
                diff: request(() => sdk.client.session.diff({ sessionID })),
              },
              { concurrency: "unbounded" },
            )
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data
                if (!match.found) draft.session.splice(match.index, 0, session.data)
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const hydrated = (messages.data ?? []).flatMap((message) => {
                  if (!MutableHashSet.has(tracker.messages, message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                const infos = [
                  ...hydrated,
                  ...currentMessages.filter(
                    (message) =>
                      MutableHashSet.has(tracker.messages, message.id) &&
                      !hydrated.some((item) => item.id === message.id),
                  ),
                ].toSorted(compareMessage)
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = HashSet.fromIterable(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!HashSet.has(visibleIDs, message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const hydratedParts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (MutableHashSet.has(tracker.parts, part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  draft.part[message.info.id] = [
                    ...hydratedParts,
                    ...currentParts.filter(
                      (part) =>
                        MutableHashSet.has(tracker.parts, part.id) &&
                        !hydratedParts.some((item) => item.id === part.id),
                    ),
                  ]
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            MutableHashSet.add(fullSyncedSessions, sessionID)
          })
          const task = Effect.runPromise(
            hydrate.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  MutableHashMap.remove(syncingSessions, sessionID)
                  MutableHashMap.remove(hydratingSessions, sessionID)
                }),
              ),
            ),
          )
          MutableHashMap.set(syncingSessions, sessionID, task)
          return task
        },
      },
      bootstrap,
    }
    return result
  },
})

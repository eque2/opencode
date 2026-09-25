import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  ReferenceInfo,
  Session,
} from "@opencode-ai/sdk/v2/client"
import type {
  AgentListInput,
  AgentListOutput,
  CatalogApi,
  CommandInfo,
  CommandListInput,
  CommandListOutput,
  ProjectCurrentInput,
  ProjectCurrentOutput,
  ProjectListOutput,
  ReferenceListInput,
  ReferenceListOutput,
  SessionApi,
} from "@opencode-ai/client/promise"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { Array as Arr, Cause, Data, Effect, Exit, HashSet, MutableHashMap, Option, Predicate } from "effect"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import {
  cmp,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProjectInfo,
  normalizeProviderList,
} from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { normalizeSessionInfo } from "@/utils/session"
import type { ServerProtocol } from "@/utils/server-protocol"
import type { ServerApi } from "@/utils/server"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

/** A server request that failed while bootstrapping; `cause` is the value the request rejected with. */
class BootstrapRequestError extends Data.TaggedError("BootstrapRequestError")<{ readonly cause: unknown }> {}

/** Runs one Promise-returning request and maps its rejection to a BootstrapRequestError. */
const request = <A>(run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: () => run(), catch: (cause) => new BootstrapRequestError({ cause }) })

/** Gives a request program back to a Promise API. The Promise rejects with the raw request error, as before. */
const runRequest = <A>(program: Effect.Effect<A, BootstrapRequestError>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.mapError((error) => error.cause)))

/**
 * Runs a request program under the transient-error retry policy of @opencode-ai/core.
 * That policy reads the raw rejection, and each attempt runs the whole program again.
 */
const retried = <A>(program: Effect.Effect<A, BootstrapRequestError>) => request(() => retry(() => runRequest(program)))

/** Whether the server speaks the legacy v1 protocol. An absent protocol counts as not v1. */
const isLegacyProtocol = (
  protocol: Promise<ServerProtocol> | undefined,
): Effect.Effect<boolean, BootstrapRequestError> =>
  Option.match(Option.fromNullishOr(protocol), {
    onNone: () => Effect.succeed(false),
    onSome: (pending) => request(() => pending).pipe(Effect.map((value) => value === "v1")),
  })

/** The legacy client, when the server speaks v1 and the caller supplied one. */
const legacyClient = (
  protocol: Promise<ServerProtocol> | undefined,
  legacy: OpencodeClient | undefined,
): Effect.Effect<Option.Option<OpencodeClient>, BootstrapRequestError> =>
  isLegacyProtocol(protocol).pipe(Effect.map((v1) => (v1 ? Option.fromNullishOr(legacy) : Option.none())))

/** Completes on the next animation frame. Interrupting it cancels the frame request. */
const nextFrame = Effect.callback<void>((resume) => {
  const handle = requestAnimationFrame(() => resume(Effect.void))
  return Effect.sync(() => cancelAnimationFrame(handle))
})

/** Waits for the task after the next frame, so the browser can paint first, or for 50 ms, whichever ends first. */
const waitForPaint = Effect.suspend(() =>
  typeof requestAnimationFrame === "function"
    ? Effect.race(Effect.sleep("50 millis"), nextFrame.pipe(Effect.andThen(Effect.sleep("0 millis"))))
    : Effect.sleep("50 millis"),
)

/** Runs every task at once and waits for all of them, as Promise.allSettled did. Yields the failure causes in task order. */
const settle = <E>(tasks: Iterable<Effect.Effect<unknown, E>>) =>
  Effect.forEach(tasks, (task) => Effect.exit(task), { concurrency: "unbounded" }).pipe(
    Effect.map(Arr.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))),
  )

/** Runs every task at once, waits for all of them, then fails with the first failure in task order. */
const awaitAll = <E>(tasks: Iterable<Effect.Effect<unknown, E>>) =>
  settle(tasks).pipe(
    Effect.flatMap((causes) =>
      Option.match(Arr.head(causes), { onNone: () => Effect.void, onSome: (cause) => Effect.failCause(cause) }),
    ),
  )

/** The value the old Promise chain rejected with: the request's own error, or the defect of a thrown bug. */
const rejection = (cause: Cause.Cause<BootstrapRequestError>): unknown =>
  Option.match(Cause.findErrorOption(cause), { onNone: () => Cause.squash(cause), onSome: (error) => error.cause })

const providerRev = MutableHashMap.empty<ScopedKey, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  MutableHashMap.remove(providerRev, ScopedKey.from(scope, directory))
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: OpencodeClient, protocol?: Promise<ServerProtocol>) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: () =>
      runRequest(
        Effect.gen(function* () {
          if (!(yield* isLegacyProtocol(protocol))) return {}
          return yield* retried(request(() => sdk.global.config.get()).pipe(Effect.map((x) => x.data!)))
        }),
      ),
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
  readonly current: (input?: ProjectCurrentInput) => Promise<ProjectCurrentOutput>
}

type McpApi = ServerApi["mcp"]
type PermissionApi = ServerApi["permission"]
type QuestionApi = ServerApi["question"]
type VcsApi = ServerApi["vcs"]

export const loadProjectsQuery = (scope: ServerScope, api: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      runRequest(
        retried(
          request(() => api.list()).pipe(
            Effect.map((projects) =>
              projects
                .filter((p) => !!p?.id)
                .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
                .map(normalizeProjectInfo)
                .slice()
                .sort((a, b) => cmp(a.id, b.id)),
            ),
          ),
        ),
      ),
  })

export function bootstrapGlobal(input: {
  serverSDK: OpencodeClient
  serverAPI: CatalogApi & { readonly project: ProjectApi }
  protocol?: Promise<ServerProtocol>
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}): Promise<void> {
  return Effect.runPromise(
    settle([
      request(() => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK, input.protocol))),
      request(() =>
        input.queryClient.fetchQuery(
          loadProvidersQueryFor(input.scope, Option.none(), input.serverAPI, input.serverSDK, input.protocol),
        ),
      ),
      request(() =>
        input.queryClient.fetchQuery(loadPathQueryFor(input.scope, Option.none(), input.serverSDK, input.protocol)),
      ),
      request(() => input.queryClient.fetchQuery(loadProjectsQuery(input.scope, input.serverAPI.project))).pipe(
        Effect.map((data) => input.setGlobalStore("project", data)),
      ),
    ]).pipe(Effect.asVoid),
  )
}

function groupBySession<T extends { id: string; sessionID: string }>(input: ReadonlyArray<T>) {
  return Arr.groupBy(
    input.filter((item) => !!item?.id && !!item.sessionID),
    (item) => item.sessionID,
  )
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

/** Fetches the sessions the store does not hold yet. Every fetched session lands in the store, even when another fails. */
function warmSessions(input: {
  ids: ReadonlyArray<string>
  store: Store<State>
  setStore: SetStoreFunction<State>
  api: SessionApi
}) {
  const known = HashSet.fromIterable(input.store.session.map((item) => item.id))
  const ids = Arr.dedupe(input.ids).filter((id) => !!id && !HashSet.has(known, id))
  return awaitAll(
    ids.map((sessionID) =>
      retried(request(() => input.api.get({ sessionID }))).pipe(
        Effect.map((session) => mergeSession(input.setStore, normalizeSessionInfo(session))),
      ),
    ),
  )
}

/**
 * Builds the provider catalog query for one directory, or for the whole server when `directory` is none.
 * The query key keeps `null` in the directory slot for the server-wide catalog, which server-sync invalidates.
 */
export const loadProvidersQueryFor = (
  scope: ServerScope,
  directory: Option.Option<string>,
  sdk: CatalogApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, Option.getOrNull(directory), "providers"],
    queryFn: () =>
      runRequest(
        retried(
          Effect.gen(function* () {
            const client = yield* legacyClient(protocol, legacy)
            if (Option.isSome(client)) {
              const legacyApi = client.value
              const result = yield* request(() => legacyApi.provider.list())
              return normalizeProviderList(result.data!)
            }
            const location = Option.getOrUndefined(
              directory.pipe(
                Option.filter((value) => value.length > 0),
                Option.map((value) => ({ location: { directory: value } })),
              ),
            )
            const [providers, models, defaultModel] = yield* Effect.all(
              [
                request(() => sdk.provider.list(location)),
                request(() => sdk.model.list(location)),
                request(() => sdk.model.default(location)),
              ],
              { concurrency: "unbounded" },
            )
            return normalizeProviderList(providers.data, models.data, defaultModel.data)
          }),
        ),
      ),
  })

/** Nullable form of {@link loadProvidersQueryFor} for callers that hold `directory | null`. */
export const loadProvidersQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: CatalogApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) => loadProvidersQueryFor(scope, Option.fromNullishOr(directory), sdk, legacy, protocol)

type AgentListApi = {
  readonly list: (input?: AgentListInput) => Promise<AgentListOutput>
}

type CommandListApi = {
  readonly list: (input?: CommandListInput) => Promise<CommandListOutput>
}

type ReferenceListApi = {
  readonly list: (input?: ReferenceListInput) => Promise<ReferenceListOutput>
}

export const loadAgentsQuery = (
  scope: ServerScope,
  directory: string,
  sdk: AgentListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () =>
      runRequest(
        retried(
          Effect.gen(function* () {
            const client = yield* legacyClient(protocol, legacy)
            if (Option.isSome(client)) {
              const legacyApi = client.value
              const result = yield* request(() => legacyApi.app.agents())
              return normalizeAgentList(result.data ?? [])
            }
            const result = yield* request(() => sdk.list({ location: { directory } }))
            return normalizeAgentList(result.data)
          }),
        ),
      ),
  })

/** Loads the commands of a directory: from the legacy endpoint on a v1 server, else from the current one. */
const commandsProgram = (
  directory: string,
  api: CommandListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
): Effect.Effect<CommandInfo[], BootstrapRequestError> =>
  retried(
    Effect.gen(function* () {
      const client = yield* legacyClient(protocol, legacy)
      if (Option.isSome(client)) {
        const legacyApi = client.value
        const result = yield* request(() => legacyApi.command.list())
        return (result.data ?? []).map((command) => {
          const [providerID, id] = command.model?.split("/") ?? []
          return {
            name: command.name,
            template: command.template,
            description: command.description,
            agent: command.agent,
            ...(providerID && id ? { model: { providerID, id } } : {}),
            subtask: command.subtask,
            // source: command.source === "skill" ? undefined : command.source,
          }
        })
      }
      const result = yield* request(() => api.list({ location: { directory } }))
      return result.data
    }),
  )

export const loadCommands = (
  directory: string,
  api: CommandListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
): Promise<CommandInfo[]> => runRequest(commandsProgram(directory, api, legacy, protocol))

/**
 * Builds the path query for one directory, or for the whole server when `directory` is none.
 * The query key keeps `null` in the directory slot for the server-wide path.
 */
export const loadPathQueryFor = (
  scope: ServerScope,
  directory: Option.Option<string>,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions<Path>({
    queryKey: [scope, Option.getOrNull(directory), "path"],
    queryFn: () =>
      runRequest(
        Effect.gen(function* () {
          if (!(yield* isLegacyProtocol(protocol)))
            return { state: "", config: "", worktree: "", directory: Option.getOrElse(directory, () => ""), home: "" }
          return yield* retried(
            request(() => sdk.path.get({ directory: Option.getOrUndefined(directory) })).pipe(
              Effect.map((result) => result.data!),
            ),
          )
        }),
      ),
  })

/** Nullable form of {@link loadPathQueryFor} for callers that hold `directory | null`. */
export const loadPathQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) => loadPathQueryFor(scope, Option.fromNullishOr(directory), sdk, protocol)

export const loadReferencesQuery = (
  scope: ServerScope,
  directory: string,
  api: ReferenceListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () =>
      runRequest(
        retried(
          Effect.gen(function* () {
            const client = yield* legacyClient(protocol, legacy)
            if (Option.isSome(client)) {
              const legacyApi = client.value
              const result = yield* request(() => legacyApi.v2.reference.list())
              return result.data?.data ?? []
            }
            const result = yield* request(() => api.list({ location: { directory } }))
            return result.data
          }),
        ).pipe(Effect.orElseSucceed(() => [])),
      ),
    placeholderData: [],
  })

type BootstrapDirectoryInput = {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: OpencodeClient
  api: CatalogApi & {
    readonly agent: AgentListApi
    readonly command: CommandListApi
    readonly mcp: McpApi
    readonly permission: PermissionApi
    readonly project: ProjectApi
    readonly question: QuestionApi
    readonly reference: ReferenceListApi
    readonly session: SessionApi
    readonly vcs: VcsApi
  }
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
  protocol?: Promise<ServerProtocol>
}

/**
 * Loads everything a directory needs after the first paint. Every task runs, and a failure does not stop the others.
 * The first failure in task order is logged and shown. The status becomes complete only when every task succeeds.
 */
function refreshDirectory(
  input: BootstrapDirectoryInput,
  seeded: { loading: boolean; project: string | undefined; path: Option.Option<Path> },
) {
  const sessions = Effect.suspend(() => {
    const pending = input.loadSessions(input.directory)
    return Predicate.isPromise(pending) ? request(() => pending) : Effect.void
  })

  const agents = request(() =>
    input.queryClient.ensureQueryData(
      loadAgentsQuery(input.scope, input.directory, input.api.agent, input.sdk, input.protocol),
    ),
  ).pipe(Effect.map((data) => input.setStore("agent", data)))

  const legacyConfig = retried(
    Effect.gen(function* () {
      if (!(yield* isLegacyProtocol(input.protocol))) return
      const result = yield* request(() => input.sdk.config.get())
      input.setStore("config", reconcile(result.data!, { merge: false }))
    }),
  )

  const sessionStatus = retried(
    Effect.gen(function* () {
      if (!(yield* isLegacyProtocol(input.protocol))) return
      const result = yield* request(() => input.sdk.session.status())
      const session = input.session
      if (!session) {
        input.setStore("session_status", result.data!)
        return
      }
      const statuses = result.data ?? {}
      session.set(
        "session_status",
        produce((draft) => {
          for (const sessionID of Object.keys(draft)) {
            if (statuses[sessionID]) continue
            if (session.get(sessionID)?.directory === input.directory) delete draft[sessionID]
          }
        }),
      )
      for (const [sessionID, status] of Object.entries(statuses)) {
        session.set("session_status", sessionID, reconcile(status))
      }
      yield* Effect.forEach(
        Object.keys(statuses),
        (sessionID) => Effect.ignore(request(() => session.resolve(sessionID))),
        { concurrency: "unbounded", discard: true },
      )
    }),
  )

  const currentProject = retried(
    request(() => input.api.project.current({ location: { directory: input.directory } })),
  ).pipe(Effect.map((project) => input.setStore("project", project.id)))

  const pathProject = request(() =>
    input.queryClient.ensureQueryData(loadPathQuery(input.scope, input.directory, input.sdk, input.protocol)),
  ).pipe(
    Effect.map((data) => {
      const next = projectID(data.directory ?? input.directory, input.global.project)
      if (next) input.setStore("project", next)
    }),
  )

  const vcs = retried(
    Effect.gen(function* () {
      if (!(yield* isLegacyProtocol(input.protocol))) return
      const result = yield* request(() => input.sdk.vcs.get())
      const next = { branch: result.data?.branch, default_branch: result.data?.default_branch }
      input.setStore("vcs", next)
      if (next) input.vcsCache.setStore("value", next)
    }),
  )

  const commands = commandsProgram(input.directory, input.api.command, input.sdk, input.protocol).pipe(
    Effect.map((command) => input.setStore("command", command)),
  )

  const references = request(() =>
    input.queryClient.fetchQuery(
      loadReferencesQuery(input.scope, input.directory, input.api.reference, input.sdk, input.protocol),
    ),
  )

  const warm = (ids: ReadonlyArray<string>) => {
    const session = input.session
    return session
      ? awaitAll(ids.map((sessionID) => request(() => session.resolve(sessionID))))
      : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session })
  }

  const listPermissions = Effect.gen(function* () {
    if (yield* isLegacyProtocol(input.protocol)) {
      const result = yield* request(() => input.sdk.permission.list())
      return result.data ?? []
    }
    const result = yield* request(() => input.api.permission.request.list({ location: { directory: input.directory } }))
    return result.data.map(normalizePermissionRequest)
  })

  const permissionRequests = retried(
    Effect.gen(function* () {
      const permissions = yield* listPermissions
      const ids = permissions.map((permission) => permission.sessionID)
      const grouped = groupBySession(permissions.filter((permission) => !!permission.id && !!permission.sessionID))
      yield* warm(ids)
      batch(() => {
        const current = input.session?.data.permission ?? input.store.permission
        for (const sessionID of Object.keys(current)) {
          if (grouped[sessionID]) continue
          if (input.session?.get(sessionID)?.directory !== input.directory) continue
          if (input.session) input.session.set("permission", sessionID, [])
          if (!input.session) input.setStore("permission", sessionID, [])
        }
        for (const [sessionID, permissions] of Object.entries(grouped)) {
          const value = reconcile(
            permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
            { key: "id" },
          )
          if (input.session) input.session.set("permission", sessionID, value)
          if (!input.session) input.setStore("permission", sessionID, value)
        }
      })
    }),
  )

  const listQuestions = Effect.gen(function* () {
    if (yield* isLegacyProtocol(input.protocol)) {
      const result = yield* request(() => input.sdk.question.list())
      return result.data ?? []
    }
    const result = yield* request(() => input.api.question.request.list({ location: { directory: input.directory } }))
    return result.data
  })

  const questionRequests = retried(
    Effect.gen(function* () {
      const questions = yield* listQuestions
      const ids = questions.map((question) => question.sessionID)
      const grouped = groupBySession(questions.filter((question) => !!question.id && !!question.sessionID))
      yield* warm(ids)
      batch(() => {
        const current = input.session?.data.question ?? input.store.question
        for (const sessionID of Object.keys(current)) {
          if (grouped[sessionID]) continue
          if (input.session?.get(sessionID)?.directory !== input.directory) continue
          if (input.session) input.session.set("question", sessionID, [])
          if (!input.session) input.setStore("question", sessionID, [])
        }
        for (const [sessionID, questions] of Object.entries(grouped)) {
          const value = reconcile(
            questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
            { key: "id" },
          )
          if (input.session) input.session.set("question", sessionID, value)
          if (!input.session) input.setStore("question", sessionID, value)
        }
      })
    }),
  )

  const mcpStatus = request(() =>
    input.queryClient.fetchQuery(loadMcpQuery(input.scope, input.directory, input.api.mcp, input.sdk, input.protocol)),
  )

  const mcpResources = request(() =>
    input.queryClient.fetchQuery(
      loadMcpResourcesQuery(input.scope, input.directory, input.api.mcp, input.sdk, input.protocol),
    ),
  )

  const providers = request(() =>
    input.queryClient.fetchQuery(
      loadProvidersQuery(input.scope, input.directory, input.api, input.sdk, input.protocol),
    ),
  ).pipe(
    Effect.catchTag("BootstrapRequestError", (error) =>
      Effect.sync(() =>
        showToast({
          variant: "error",
          title: input.translate("toast.project.reloadFailed.title", { project: getFilename(input.directory) }),
          description: formatServerError(error.cause, input.translate),
        }),
      ),
    ),
  )

  const tasks: ReadonlyArray<Effect.Effect<unknown, BootstrapRequestError>> = [
    sessions,
    agents,
    legacyConfig,
    sessionStatus,
    ...(seeded.project ? [] : [currentProject]),
    ...(Option.isSome(seeded.path) ? [] : [pathProject]),
    vcs,
    ...(input.mcp ? [commands] : []),
    references,
    permissionRequests,
    questionRequests,
    sessions,
    ...(input.mcp ? [mcpStatus, mcpResources] : []),
    providers,
  ]

  return Effect.gen(function* () {
    yield* waitForPaint
    const failure = Arr.head(yield* settle(tasks))
    if (Option.isSome(failure)) {
      const reason = rejection(failure.value)
      yield* Effect.logError("Failed to finish bootstrap instance", reason)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project: getFilename(input.directory) }),
        description: formatServerError(reason, input.translate),
      })
    }
    if (seeded.loading && Option.isNone(failure)) input.setStore("status", "complete")
  })
}

export function bootstrapDirectory(input: BootstrapDirectoryInput): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const loading = input.store.status !== "complete"
      const seededProject = projectID(input.directory, input.global.project)
      const seededPath = Option.liftPredicate(input.global.path, (path) => path.directory === input.directory)
      if (seededProject) input.setStore("project", seededProject)
      if (Option.isSome(seededPath)) input.setStore("path", seededPath.value)
      if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
        input.setStore("config", reconcile(input.global.config, { merge: false }))
      }
      if (loading) input.setStore("status", "partial")

      const revKey = ScopedKey.from(input.scope, input.directory)
      const rev = Option.getOrElse(MutableHashMap.get(providerRev, revKey), () => 0) + 1
      MutableHashMap.set(providerRev, revKey, rev)
      yield* Effect.forkDetach(refreshDirectory(input, { loading, project: seededProject, path: seededPath }), {
        startImmediately: true,
      })
    }),
  )
}

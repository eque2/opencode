import { Binary } from "@opencode-ai/core/util/binary"
import { retry } from "@opencode-ai/core/util/retry"
import type { OpenCodeEvent, SessionApi, SessionMessageInfo } from "@opencode-ai/client/promise"
import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import {
  Clock,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  HashSet,
  MutableHashMap,
  MutableHashSet,
  Option,
  Predicate,
  Result,
} from "effect"
import { batch } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { message as cleanMessage } from "@/utils/diffs"
import { sessionNotFoundError } from "@/utils/server-errors"
import { rootSession, SessionParentCycleError } from "@/utils/session-route"
import { normalizeSessionInfo } from "@/utils/session"
import { compareMessages, messageKey, normalizeSessionMessages } from "@/utils/session-message"
import { dropSessionCaches, pickSessionCacheEvictions, SESSION_CACHE_LIMIT } from "./global-sync/session-cache"
import { createV2SessionReducer, type V2SessionReduction } from "./server-session-v2-reducer"
import type { ServerApi } from "@/utils/server"

type MessageApi = ServerApi["message"]

// The legacy session calls this module makes. OpencodeClient satisfies it, and so does a stand-in object.
export type ServerSessionClient = {
  readonly session: {
    readonly get: (input: { sessionID: string }) => Promise<{ readonly data?: Session }>
    readonly messages: (input: { sessionID: string; limit: number; before?: string }) => Promise<{
      readonly data?: ReadonlyArray<{ readonly info: Message; readonly parts: Part[] }>
      readonly response: { readonly headers: Pick<Headers, "get"> }
    }>
    readonly message: (input: {
      sessionID: string
      messageID: string
    }) => Promise<{ readonly data?: { readonly info: Message; readonly parts: Part[] } }>
    readonly todo: (input: { sessionID: string }) => Promise<{ readonly data?: Todo[] }>
  }
}

class MessageNotFoundError extends Data.TaggedError("App.MessageNotFoundError")<{ readonly message: string }> {}

class AssistantParentError extends Data.TaggedError("App.AssistantParentError")<{ readonly message: string }> {}

// Wraps the value a server call or a Promise helper rejected with, so the public Promise API can reject with it again.
class ServerSessionRequestError extends Data.TaggedError("App.ServerSessionRequestError")<{
  readonly cause: unknown
}> {}

type ServerSessionError =
  | ServerSessionRequestError
  | MessageNotFoundError
  | AssistantParentError
  | SessionParentCycleError

/** A session and the root of its parent chain. */
export type SessionLineage = { readonly session: Session; readonly root: Session }

const attempt = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => new ServerSessionRequestError({ cause }) })

// Callers of the Promise API see the original rejection, as they did before the loaders ran as Effects.
const rejection = (error: ServerSessionError): unknown =>
  error._tag === "App.ServerSessionRequestError" ? error.cause : error

const run = <A>(effect: Effect.Effect<A, ServerSessionError>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError(rejection)))

// A server 404 (the SDK error carries the response status in its cause) means the message was deleted.
const isMissingMessage = (error: ServerSessionError) =>
  error._tag === "App.ServerSessionRequestError" &&
  error.cause instanceof Error &&
  typeof error.cause.cause === "object" &&
  Predicate.hasProperty(error.cause.cause, "status") &&
  error.cause.cause.status === 404

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const SKIP_PARTS: HashSet.HashSet<string> = HashSet.make("patch", "step-start", "step-finish")
const initialMessagePageSize = 20
const historyMessagePageSize = 200
const sessionInfoLimit = 2_048

type IDSet = MutableHashSet.MutableHashSet<string>
type IDIndex = MutableHashMap.MutableHashMap<string, IDSet>

const idsOf = (ids: Option.Option<IDSet>): Iterable<string> => Option.getOrElse(ids, (): Iterable<string> => [])

const hasID = (ids: Option.Option<IDSet>, id: string) => Option.exists(ids, (set) => MutableHashSet.has(set, id))

const removeID = (ids: Option.Option<IDSet>, id: string) => {
  if (Option.isSome(ids)) MutableHashSet.remove(ids.value, id)
}

// Adds `id` to the set held under `key`, and creates that set on first use.
const addToIndex = (index: IDIndex, key: string, id: string) => {
  const ids = MutableHashMap.get(index, key)
  if (Option.isSome(ids)) {
    MutableHashSet.add(ids.value, id)
    return
  }
  MutableHashMap.set(index, key, MutableHashSet.make(id))
}

// Adds every id in `ids` to the set held under `key`, and creates that set on first use.
const mergeIntoIndex = (index: IDIndex, key: string, ids: Iterable<string>) => {
  const target = Option.getOrElse(MutableHashMap.get(index, key), () => MutableHashSet.empty<string>())
  for (const id of ids) MutableHashSet.add(target, id)
  MutableHashMap.set(index, key, target)
}

// Removes `id` from the set held under `key`, and drops that set when it becomes empty.
const removeFromIndex = (index: IDIndex, key: string, id: string) => {
  const ids = MutableHashMap.get(index, key)
  if (Option.isNone(ids)) return
  MutableHashSet.remove(ids.value, id)
  if (MutableHashSet.size(ids.value) === 0) MutableHashMap.remove(index, key)
}

function needsOlderTurnRoot(source: readonly SessionMessageInfo[]) {
  const boundary = source.find(
    (message) =>
      message.type === "user" ||
      message.type === "shell" ||
      message.type === "assistant" ||
      (message.type === "synthetic" && message.description?.trim()),
  )
  return boundary?.type === "assistant"
}

type OptimisticItem = {
  message: Message
  parts: Part[]
  confirmedParts?: Part[]
  confirmedMessage?: boolean
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  source?: SessionMessageInfo[]
  sourceMode?: "latest" | "older"
  projectSource?: boolean
  cursor: Option.Option<string>
  complete: boolean
}

function legacyMessageSource(items: { info: Message; parts: Part[] }[]): SessionMessageInfo[] {
  return items
    .slice()
    .sort((a, b) => compareMessages(a.info, b.info))
    .map((item) => {
      if (item.info.role === "user") {
        return {
          id: item.info.id,
          type: "user" as const,
          text: item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
          time: item.info.time,
        }
      }
      return {
        id: item.info.id,
        type: "assistant" as const,
        agent: item.info.agent ?? item.info.mode,
        model: { id: item.info.modelID, providerID: item.info.providerID, variant: item.info.variant },
        content: [],
        time: item.info.time,
      }
    })
}

// Most markers describe the current HTTP attempt; deltaParts persists non-durable stream state across retries.
type MessageLoadState = {
  touchedMessages: IDSet
  removedMessages: IDSet
  retainedMessages: IDSet
  touchedParts: IDIndex
  deltaParts: IDIndex
  carriedDeltaParts: IDIndex
  removedParts: IDIndex
  optimisticParts: IDIndex
  orphanParents: IDSet
  clearedMessageParts: IDSet
  touchedSource: IDSet
}

type MessageLoadBaseline = Pick<
  MessageLoadState,
  "touchedMessages" | "retainedMessages" | "touchedParts" | "clearedMessageParts"
>

function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, observed: [] as { messageID: string; parts: Part[] }[] }
  const session = [...page.session]
  const part = MutableHashMap.fromIterable(page.part.map((item) => [item.id, item.part] as const))
  const observed: { messageID: string; parts: Part[] }[] = []
  for (const item of items) {
    const result = Binary.search(session, messageKey(item.message), messageKey)
    const found = result.found
    if (!found) session.splice(result.index, 0, item.message)
    const current = Option.getOrElse(MutableHashMap.get(part, item.message.id), (): Part[] => [])
    const confirmed = found ? item.parts.filter((part) => current.some((value) => value.id === part.id)) : []
    if (found) observed.push({ messageID: item.message.id, parts: confirmed })
    MutableHashMap.set(
      part,
      item.message.id,
      merge(
        found ? current : merge(item.confirmedParts ?? [], current),
        item.parts.filter((part) => !confirmed.includes(part)),
      ),
    )
  }
  return {
    ...page,
    session,
    part: [...part].sort((a, b) => cmp(a[0], b[0])).map(([id, parts]) => ({ id, part: parts })),
    observed,
  }
}

// Runs `task` once per key: later callers wait on the same result. The task runs in a detached fiber, so an
// interrupted caller never cancels it. `settled` runs after the key is released and before the waiters resume.
function share<A, E>(
  map: MutableHashMap.MutableHashMap<string, Deferred.Deferred<A, E>>,
  key: string,
  task: Effect.Effect<A, E>,
  settled?: () => void,
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    const pending = MutableHashMap.get(map, key)
    if (Option.isSome(pending)) return Deferred.await(pending.value)
    const deferred = Deferred.makeUnsafe<A, E>()
    MutableHashMap.set(map, key, deferred)
    return task.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Option.exists(MutableHashMap.get(map, key), (value) => value === deferred))
            MutableHashMap.remove(map, key)
          settled?.()
          Deferred.doneUnsafe(deferred, exit)
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
      Effect.andThen(Deferred.await(deferred)),
    )
  })
}

function merge<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const items = MutableHashMap.fromIterable(a.map((item) => [item.id, item] as const))
  for (const item of b) MutableHashMap.set(items, item.id, item)
  return [...MutableHashMap.values(items)].sort((x, y) => cmp(x.id, y.id))
}

function reconcileFetched<T extends { id: string }>(
  fetched: T[],
  current: readonly T[],
  options: {
    touched?: Iterable<string>
    retained?: Iterable<string>
    removed?: Iterable<string>
    preserveUnfetched?: boolean | ((item: T) => boolean)
    compare?: (a: T, b: T) => number
  } = {},
) {
  const result = MutableHashMap.fromIterable(fetched.map((item) => [item.id, item] as const))
  const live = MutableHashMap.fromIterable(current.map((item) => [item.id, item] as const))
  if (options.preserveUnfetched) {
    for (const item of current) {
      if (
        !MutableHashMap.has(result, item.id) &&
        (options.preserveUnfetched === true || options.preserveUnfetched(item))
      )
        MutableHashMap.set(result, item.id, item)
    }
  }
  for (const id of options.retained ?? []) {
    if (MutableHashMap.has(result, id)) continue
    const item = MutableHashMap.get(live, id)
    if (Option.isSome(item)) MutableHashMap.set(result, id, item.value)
  }
  // Events observed while the request is pending are the freshest client state for those identities.
  for (const id of options.touched ?? []) {
    const item = MutableHashMap.get(live, id)
    if (Option.isSome(item)) MutableHashMap.set(result, id, item.value)
    if (Option.isNone(item)) MutableHashMap.remove(result, id)
  }
  for (const id of options.removed ?? []) MutableHashMap.remove(result, id)
  const items = [...MutableHashMap.values(result)]
  return options.compare ? items.sort(options.compare) : items
}

type ServerSessionOptions = { retry?: typeof retry; protocol?: Promise<"v1" | "v2"> }

// Only the session API has `get`; the options object never does.
const isSessionApi = (value: SessionApi | ServerSessionOptions): value is SessionApi => "get" in value

const isServerSessionOptions = (value: SessionApi | ServerSessionOptions): value is ServerSessionOptions =>
  !("get" in value)

// The text a delta extends: the part's field when it holds a string.
const textField = (part: Part | undefined, field: string): Option.Option<string> => {
  if (!part) return Option.none()
  // Every Part variant is a plain object type, so it widens to a string-keyed record without an assertion.
  const fields: Readonly<Record<string, unknown>> = part
  const value = fields[field]
  return Predicate.isString(value) ? Option.some(value) : Option.none()
}

export function createServerSession(
  client: ServerSessionClient,
  sessionApiOrOptions?: SessionApi | ServerSessionOptions,
  messageApi?: MessageApi,
  currentOptions?: ServerSessionOptions,
) {
  // With a message API the second argument is the session API; without one it holds the options.
  const second = Option.fromNullishOr(sessionApiOrOptions)
  const sessionApi = messageApi ? Option.filter(second, isSessionApi) : Option.none<SessionApi>()
  const options = messageApi ? Option.fromNullishOr(currentOptions) : Option.filter(second, isServerSessionOptions)
  const [data, setData] = createStore({
    info: {} as Record<string, Session | undefined>,
    session_status: {} as Record<string, SessionStatus>,
    session_diff: {} as Record<string, FileDiffInfo[]>,
    todo: {} as Record<string, Todo[]>,
    permission: {} as Record<string, PermissionRequest[]>,
    question: {} as Record<string, QuestionRequest[]>,
    message: {} as Record<string, Message[]>,
    session_message: {} as Record<string, SessionMessageInfo[]>,
    part: {} as Record<string, Part[]>,
    part_text_accum_delta: {} as Record<string, string>,
    session_working(id: string) {
      return (this.session_status[id]?.type ?? "idle") !== "idle"
    },
  })
  const retryRequest = Option.match(options, { onNone: () => retry, onSome: (value) => value.retry ?? retry })
  const protocol = Option.flatMap(options, (value) => Option.fromNullishOr(value.protocol))
  // A client without a protocol promise speaks the current protocol.
  const protocolIs = (expected: "v1" | "v2") =>
    Option.match(protocol, {
      onNone: () => Effect.succeed(false),
      onSome: (value) =>
        Effect.map(
          Effect.promise(() => value),
          (current) => current === expected,
        ),
    })
  const requests = MutableHashMap.empty<string, Deferred.Deferred<Session, ServerSessionError>>()
  const inflight = MutableHashMap.empty<string, Deferred.Deferred<void, ServerSessionError>>()
  const inflightTodo = MutableHashMap.empty<string, Deferred.Deferred<void, ServerSessionError>>()
  const optimistic = MutableHashMap.empty<string, MutableHashMap.MutableHashMap<string, OptimisticItem>>()
  const v2 = createV2SessionReducer()
  const messageLoads = MutableHashMap.empty<string, MessageLoadState>()
  const pendingParts = MutableHashMap.empty<string, IDIndex>()
  const orphanParts: IDIndex = MutableHashMap.empty()
  const removedMessages: IDIndex = MutableHashMap.empty()
  const deltaBases = MutableHashMap.empty<string, { base: string; sessionID: string }>()
  const deleteMessageParts = (
    cache: { part: Record<string, Part[] | undefined>; part_text_accum_delta: Record<string, string | undefined> },
    messageID: string,
  ) => {
    for (const part of cache.part[messageID] ?? []) {
      delete cache.part_text_accum_delta[part.id]
      MutableHashMap.remove(deltaBases, part.id)
    }
    delete cache.part[messageID]
  }
  const seen = MutableHashSet.empty<string>()
  const infoSeen: IDSet = MutableHashSet.empty()
  const pinned = MutableHashMap.empty<string, number>()
  const generations = MutableHashMap.empty<string, object>()
  const generation = (sessionID: string) => {
    const current = MutableHashMap.get(generations, sessionID)
    if (Option.isSome(current)) return current.value
    const created = {}
    MutableHashMap.set(generations, sessionID, created)
    return created
  }
  const isGeneration = (sessionID: string, active: object) =>
    Option.exists(MutableHashMap.get(generations, sessionID), (current) => current === active)
  const isLoad = (sessionID: string, load: MessageLoadState) =>
    Option.exists(MutableHashMap.get(messageLoads, sessionID), (current) => current === load)
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number | undefined>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    at: {} as Record<string, number | undefined>,
  })

  const indexLegacyMessage = (message: Message) => {
    const current = data.session_message[message.sessionID] ?? []
    if (current.some((item) => item.id === message.id)) return
    setData(
      "session_message",
      message.sessionID,
      reconcile([...current, ...legacyMessageSource([{ info: message, parts: [] }])]),
    )
  }

  const remember = (session: Session) => {
    setData("info", session.id, reconcile(session))
    MutableHashSet.remove(infoSeen, session.id)
    MutableHashSet.add(infoSeen, session.id)
    if (MutableHashSet.size(infoSeen) > sessionInfoLimit) {
      const preserve = MutableHashSet.fromIterable([
        ...MutableHashMap.keys(pinned),
        ...MutableHashMap.keys(requests),
        ...MutableHashMap.keys(inflight),
        ...MutableHashMap.keys(inflightTodo),
        ...MutableHashMap.keys(messageLoads),
        ...MutableHashMap.keys(optimistic),
        ...Object.entries(data.permission)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.question)
          .filter(([, items]) => items.length > 0)
          .map(([sessionID]) => sessionID),
        ...Object.entries(data.session_status)
          .filter(([, status]) => status.type !== "idle")
          .map(([sessionID]) => sessionID),
      ])
      for (const sessionID of preserve) {
        let current = data.info[sessionID]
        while (current) {
          MutableHashSet.add(preserve, current.id)
          if (!current.parentID) break
          current = data.info[current.parentID]
        }
      }
      const stale: string[] = []
      for (const sessionID of infoSeen) {
        if (MutableHashSet.size(infoSeen) - stale.length <= sessionInfoLimit) break
        if (!MutableHashSet.has(preserve, sessionID)) stale.push(sessionID)
      }
      stale.forEach((sessionID) => MutableHashSet.remove(infoSeen, sessionID))
      stale.forEach((sessionID) => MutableHashMap.remove(generations, sessionID))
      setData(
        "info",
        produce((draft) => stale.forEach((sessionID) => delete draft[sessionID])),
      )
    }
    return session
  }

  const fetchSession = (sessionID: string): Effect.Effect<Session, ServerSessionError> => {
    if (Option.isSome(sessionApi)) {
      const api = sessionApi.value
      return attempt(() => api.get({ sessionID })).pipe(Effect.map(normalizeSessionInfo))
    }
    return attempt(() => client.session.get({ sessionID })).pipe(
      Effect.flatMap((result) =>
        result.data
          ? Effect.succeed(result.data)
          : Effect.fail(new ServerSessionRequestError({ cause: sessionNotFoundError(sessionID) })),
      ),
    )
  }

  const resolveSession = (sessionID: string, options?: { force?: boolean }) =>
    Effect.suspend(() => {
      const cached = data.info[sessionID]
      if (cached && !options?.force) return Effect.succeed(cached)
      const pending = MutableHashMap.get(requests, sessionID)
      if (Option.isSome(pending)) return Deferred.await(pending.value)
      const active = generation(sessionID)
      const task = fetchSession(sessionID).pipe(
        Effect.map((result) => (isGeneration(sessionID, active) ? remember(result) : result)),
      )
      return share(requests, sessionID, task, () => {
        if (
          isGeneration(sessionID, active) &&
          !data.info[sessionID] &&
          !MutableHashMap.has(requests, sessionID) &&
          !MutableHashMap.has(messageLoads, sessionID) &&
          !MutableHashMap.has(inflight, sessionID) &&
          !MutableHashMap.has(inflightTodo, sessionID)
        )
          MutableHashMap.remove(generations, sessionID)
      })
    })

  const resolve = (sessionID: string, options?: { force?: boolean }) => run(resolveSession(sessionID, options))

  // Reads the lineage from cached session info only. None means that a session of the chain is not cached.
  const findLineage = (sessionID: string): Result.Result<Option.Option<SessionLineage>, SessionParentCycleError> => {
    const session = data.info[sessionID]
    if (!session) return Result.succeed(Option.none())
    const visited = MutableHashSet.make(session.id)
    let root = session
    while (root.parentID) {
      if (MutableHashSet.has(visited, root.parentID))
        return Result.fail(new SessionParentCycleError({ message: `Session parent cycle: ${root.parentID}` }))
      MutableHashSet.add(visited, root.parentID)
      const parent = data.info[root.parentID]
      if (!parent) return Result.succeed(Option.none())
      root = parent
    }
    return Result.succeed(Option.some({ session, root }))
  }

  const clearOptimistic = (sessionID: string, messageID?: string) => {
    if (!messageID) {
      MutableHashMap.remove(optimistic, sessionID)
      return
    }
    const items = MutableHashMap.get(optimistic, sessionID)
    if (Option.isNone(items)) return
    MutableHashMap.remove(items.value, messageID)
    if (MutableHashMap.size(items.value) === 0) MutableHashMap.remove(optimistic, sessionID)
  }

  const optimisticItem = (sessionID: string, messageID: string) =>
    Option.flatMap(MutableHashMap.get(optimistic, sessionID), (items) => MutableHashMap.get(items, messageID))

  const setOptimisticItem = (sessionID: string, messageID: string, item: OptimisticItem) => {
    const items = MutableHashMap.get(optimistic, sessionID)
    if (Option.isSome(items)) MutableHashMap.set(items.value, messageID, item)
  }

  const clearOptimisticPart = (sessionID: string, messageID: string, partID: string) => {
    const item = optimisticItem(sessionID, messageID)
    if (Option.isNone(item)) return
    const parts = item.value.parts.filter((part) => part.id !== partID)
    const confirmedParts = item.value.confirmedParts?.filter((part) => part.id !== partID)
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    setOptimisticItem(sessionID, messageID, { ...item.value, parts, confirmedParts, confirmedMessage: true })
  }

  const confirmOptimisticPart = (sessionID: string, messageID: string, part: Part) => {
    const item = optimisticItem(sessionID, messageID)
    if (Option.isNone(item)) return
    const parts = item.value.parts.filter((value) => value.id !== part.id)
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    setOptimisticItem(sessionID, messageID, {
      ...item.value,
      parts,
      confirmedParts: merge(item.value.confirmedParts ?? [], [part]),
      confirmedMessage: true,
    })
  }

  const confirmOptimistic = (sessionID: string, messageID: string, confirmedParts: Part[]) => {
    const item = optimisticItem(sessionID, messageID)
    if (Option.isNone(item)) return
    const confirmed = MutableHashSet.fromIterable(confirmedParts.map((part) => part.id))
    const parts = item.value.parts.filter((part) => !MutableHashSet.has(confirmed, part.id))
    if (parts.length === 0) {
      clearOptimistic(sessionID, messageID)
      return
    }
    setOptimisticItem(sessionID, messageID, {
      ...item.value,
      parts,
      confirmedParts: merge(item.value.confirmedParts ?? [], confirmedParts),
      confirmedMessage: true,
    })
  }

  const trackPartChange = (sessionID: string, messageID: string, partID: string) => {
    const load = MutableHashMap.get(messageLoads, sessionID)
    if (Option.isNone(load)) return
    // A part event keeps an existing parent when the fetched page omits it without overriding fetched metadata.
    const messages = data.message[sessionID]
    if (messages?.some((message) => message.id === messageID))
      MutableHashSet.add(load.value.retainedMessages, messageID)
    addToIndex(load.value.touchedParts, messageID, partID)
  }

  const resetMessageLoad = (sessionID: string, load: MessageLoadState, baseline?: MessageLoadBaseline) => {
    MutableHashSet.clear(load.touchedMessages)
    MutableHashSet.clear(load.retainedMessages)
    MutableHashMap.clear(load.touchedParts)
    MutableHashMap.clear(load.carriedDeltaParts)
    MutableHashSet.clear(load.clearedMessageParts)
    for (const messageID of load.removedMessages) {
      MutableHashSet.add(load.touchedMessages, messageID)
      MutableHashSet.add(load.clearedMessageParts, messageID)
    }
    for (const [messageID, parts] of load.deltaParts) {
      MutableHashMap.set(load.touchedParts, messageID, MutableHashSet.fromIterable(parts))
      MutableHashMap.set(load.carriedDeltaParts, messageID, MutableHashSet.fromIterable(parts))
      const messages = data.message[sessionID]
      if (messages?.some((message) => message.id === messageID)) MutableHashSet.add(load.retainedMessages, messageID)
    }
    for (const [messageID, parts] of load.removedParts) {
      mergeIntoIndex(load.touchedParts, messageID, parts)
      const messages = data.message[sessionID]
      if (messages?.some((message) => message.id === messageID)) MutableHashSet.add(load.retainedMessages, messageID)
    }
    for (const [messageID, parts] of load.optimisticParts) {
      MutableHashSet.remove(load.removedMessages, messageID)
      MutableHashSet.add(load.clearedMessageParts, messageID)
      MutableHashSet.add(load.touchedMessages, messageID)
      mergeIntoIndex(load.touchedParts, messageID, parts)
    }
    if (!baseline) return
    for (const messageID of baseline.touchedMessages) MutableHashSet.add(load.touchedMessages, messageID)
    for (const messageID of baseline.retainedMessages) MutableHashSet.add(load.retainedMessages, messageID)
    for (const messageID of baseline.clearedMessageParts) MutableHashSet.add(load.clearedMessageParts, messageID)
    for (const [messageID, parts] of baseline.touchedParts) mergeIntoIndex(load.touchedParts, messageID, parts)
  }

  const messageLoadBaseline = (load: MessageLoadState, exclude: string): MessageLoadBaseline => ({
    touchedMessages: MutableHashSet.fromIterable(
      [...load.touchedMessages].filter((messageID) => messageID !== exclude),
    ),
    retainedMessages: MutableHashSet.fromIterable(
      [...load.retainedMessages].filter((messageID) => messageID !== exclude),
    ),
    touchedParts: MutableHashMap.fromIterable(
      [...load.touchedParts]
        .filter(([messageID]) => messageID !== exclude)
        .map(([messageID, parts]) => [messageID, MutableHashSet.fromIterable(parts)] as const),
    ),
    clearedMessageParts: MutableHashSet.fromIterable(
      [...load.clearedMessageParts].filter((messageID) => messageID !== exclude),
    ),
  })

  const evict = (sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    const evicted = MutableHashSet.fromIterable(sessionIDs)
    for (const [partID, item] of deltaBases) {
      if (MutableHashSet.has(evicted, item.sessionID)) MutableHashMap.remove(deltaBases, partID)
    }
    sessionIDs.forEach((sessionID) => {
      MutableHashMap.remove(generations, sessionID)
      clearOptimistic(sessionID)
      MutableHashMap.remove(requests, sessionID)
      MutableHashMap.remove(inflight, sessionID)
      MutableHashMap.remove(inflightTodo, sessionID)
      MutableHashMap.remove(messageLoads, sessionID)
      v2.clear(sessionID)
      MutableHashMap.remove(pendingParts, sessionID)
      MutableHashMap.remove(orphanParts, sessionID)
      MutableHashMap.remove(removedMessages, sessionID)
    })
    setData(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          delete draft.limit[sessionID]
          delete draft.cursor[sessionID]
          delete draft.complete[sessionID]
          delete draft.loading[sessionID]
          delete draft.at[sessionID]
        }
      }),
    )
  }

  // Duplicates are harmless: callers only test membership.
  const protectedSessions = () => [
    ...MutableHashMap.keys(pinned),
    ...MutableHashMap.keys(requests),
    ...MutableHashMap.keys(inflight),
    ...MutableHashMap.keys(inflightTodo),
    ...MutableHashMap.keys(messageLoads),
    ...MutableHashMap.keys(optimistic),
    ...Object.entries(data.permission)
      .filter(([, items]) => items.length > 0)
      .map(([sessionID]) => sessionID),
    ...Object.entries(data.question)
      .filter(([, items]) => items.length > 0)
      .map(([sessionID]) => sessionID),
    ...Object.entries(data.session_status)
      .filter(([, status]) => status.type !== "idle")
      .map(([sessionID]) => sessionID),
  ]

  const touch = (sessionID: string) =>
    evict(
      pickSessionCacheEvictions({ seen, keep: sessionID, limit: SESSION_CACHE_LIMIT, preserve: protectedSessions() }),
    )

  const fetchMessages = Effect.fnUntraced(function* (
    sessionID: string,
    limit: number,
    before: string | undefined,
    onAttempt: () => void,
  ) {
    if (messageApi && !(yield* protocolIs("v1"))) {
      const request = (cursor?: string) =>
        attempt(() =>
          retryRequest(() => {
            onAttempt()
            return messageApi.list(cursor ? { sessionID, limit, cursor } : { sessionID, limit, order: "desc" })
          }),
        )
      const first = yield* request(before)
      let response = first
      let pages = [first]
      while (response.cursor.next && needsOlderTurnRoot(pages.flatMap((page) => page.data).toReversed())) {
        response = yield* request(response.cursor.next)
        pages = [...pages, response]
        if (!response.data.length) break
      }
      const source = pages.flatMap((page) => page.data).toReversed()
      const normalized = normalizeSessionMessages(sessionID, source)
      return {
        session: normalized.messages.sort(compareMessages),
        part: [...normalized.parts]
          .map(([id, part]) => ({ id, part: part.sort((a, b) => cmp(a.id, b.id)) }))
          .sort((a, b) => cmp(a.id, b.id)),
        source,
        sourceMode: before ? ("older" as const) : ("latest" as const),
        projectSource: true,
        cursor: Option.fromNullishOr(response.cursor.next),
        complete: response.data.length === 0,
      }
    }
    const response = yield* attempt(() =>
      retryRequest(() => {
        onAttempt()
        return client.session.messages({ sessionID, limit, before })
      }),
    )
    const items = (response.data ?? []).filter((item) => !!item?.info?.id)
    return {
      session: items.map((item) => cleanMessage(item.info)).sort(compareMessages),
      part: items.map((item) => ({
        id: item.info.id,
        part: item.parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id)),
      })),
      source: legacyMessageSource(items),
      sourceMode: before ? ("older" as const) : ("latest" as const),
      cursor: Option.fromNullishOr(response.response.headers.get("x-next-cursor")),
      complete: !response.response.headers.get("x-next-cursor"),
    }
  })

  const fetchMessage = Effect.fnUntraced(function* (sessionID: string, messageID: string, onAttempt: () => void) {
    if (Option.isSome(sessionApi) && !(yield* protocolIs("v1"))) {
      const api = sessionApi.value
      const response = yield* attempt(() =>
        retryRequest(() => {
          onAttempt()
          return api.message({ sessionID, messageID })
        }),
      )
      const normalized = normalizeSessionMessages(sessionID, [response])
      const message = normalized.messages[0]
      if (!message) return yield* new MessageNotFoundError({ message: `Message not found: ${messageID}` })
      return { message, parts: Option.getOrElse(MutableHashMap.get(normalized.parts, messageID), (): Part[] => []) }
    }
    const response = yield* attempt(() =>
      retryRequest(() => {
        onAttempt()
        return client.session.message({ sessionID, messageID })
      }),
    )
    if (!response.data?.info?.id) return yield* new MessageNotFoundError({ message: `Message not found: ${messageID}` })
    return {
      message: cleanMessage(response.data.info),
      parts: response.data.parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id)),
    }
  })

  const replaceMessages = (sessionID: string, messages: Message[]) => {
    const messageIDs = MutableHashSet.fromIterable(messages.map((message) => message.id))
    const dropped = (data.message[sessionID] ?? []).filter((message) => !MutableHashSet.has(messageIDs, message.id))
    setData("message", sessionID, reconcile(messages, { key: "id" }))
    setData(
      produce((draft) => {
        for (const message of dropped) deleteMessageParts(draft, message.id)
      }),
    )
    return messageIDs
  }

  const replaceParts = (
    sessionID: string,
    items: MessagePage["part"],
    messageIDs: IDSet,
    load: Option.Option<MessageLoadState>,
  ) => {
    for (const item of items) {
      if (!MutableHashSet.has(messageIDs, item.id)) continue
      const cleared = Option.exists(load, (value) => MutableHashSet.has(value.clearedMessageParts, item.id))
      const fetched = cleared ? [] : item.part.filter((part) => !HashSet.has(SKIP_PARTS, part.type))
      const fetchedIDs = MutableHashSet.fromIterable(fetched.map((part) => part.id))
      const pending = Option.flatMap(MutableHashMap.get(pendingParts, sessionID), (index) =>
        MutableHashMap.get(index, item.id),
      )
      const loadTouched = Option.flatMap(load, (value) => MutableHashMap.get(value.touchedParts, item.id))
      const carried = Option.flatMap(load, (value) => MutableHashMap.get(value.carriedDeltaParts, item.id))
      const touched = MutableHashSet.fromIterable([...idsOf(loadTouched), ...idsOf(pending)])
      for (const part of fetched) {
        const accumulated = data.part_text_accum_delta[part.id]
        const base = Option.map(MutableHashMap.get(deltaBases, part.id), (value) => value.base)
        const preserveDelta =
          Option.isSome(base) &&
          accumulated !== undefined &&
          "text" in part &&
          typeof part.text === "string" &&
          part.text.startsWith(base.value) &&
          accumulated.startsWith(part.text) &&
          accumulated !== part.text
        if (preserveDelta) MutableHashSet.add(touched, part.id)
        if (hasID(carried, part.id) && !preserveDelta) MutableHashSet.remove(touched, part.id)
      }
      for (const partID of idsOf(carried)) {
        if (!MutableHashSet.has(fetchedIDs, partID)) MutableHashSet.remove(touched, partID)
      }
      const parts = reconcileFetched(fetched, data.part[item.id] ?? [], { touched })
      if (!parts.length) {
        removeID(MutableHashMap.get(orphanParts, sessionID), item.id)
        setData(produce((draft) => deleteMessageParts(draft, item.id)))
        continue
      }
      const partIDs = MutableHashSet.fromIterable(parts.map((part) => part.id))
      setData(
        "part_text_accum_delta",
        produce((draft) => {
          for (const part of data.part[item.id] ?? []) {
            if (!MutableHashSet.has(partIDs, part.id) || !MutableHashSet.has(touched, part.id)) {
              delete draft[part.id]
              MutableHashMap.remove(deltaBases, part.id)
            }
          }
        }),
      )
      setData("part", item.id, reconcile(parts, { key: "id" }))
      removeID(MutableHashMap.get(orphanParts, sessionID), item.id)
    }
  }

  const applyMessagePage = (
    sessionID: string,
    page: MessagePage,
    load: Option.Option<MessageLoadState>,
    preserveUnfetched: boolean | ((message: Message) => boolean),
    cleanupOrphans: boolean,
  ) => {
    const touchedSource = Option.map(load, (value) => value.touchedSource)
    const source = Option.map(Option.fromNullishOr(page.source), (fetched) => {
      const incoming = MutableHashSet.fromIterable(fetched.map((message) => message.id))
      const existing = data.session_message[sessionID] ?? []
      const current = existing.filter((message) => !MutableHashSet.has(incoming, message.id))
      const live = MutableHashMap.fromIterable(existing.map((message) => [message.id, message] as const))
      return (page.sourceMode === "older" ? [...fetched, ...current] : [...current, ...fetched]).map((message) =>
        hasID(touchedSource, message.id)
          ? Option.getOrElse(MutableHashMap.get(live, message.id), () => message)
          : message,
      )
    })
    const projected =
      page.projectSource && Option.isSome(source)
        ? (() => {
            const normalized = normalizeSessionMessages(sessionID, source.value)
            return {
              ...page,
              session: normalized.messages.sort(compareMessages),
              part: [...normalized.parts]
                .map(([id, part]) => ({ id, part: part.sort((a, b) => cmp(a.id, b.id)) }))
                .sort((a, b) => cmp(a.id, b.id)),
            }
          })()
        : page
    const optimisticItems = Option.match(MutableHashMap.get(optimistic, sessionID), {
      onNone: (): OptimisticItem[] => [],
      onSome: (items) => [...MutableHashMap.values(items)],
    })
    const merged = mergeOptimisticPage(projected, optimisticItems)
    const cleared = Option.map(load, (value) => value.clearedMessageParts)
    merged.observed.forEach((item) => {
      if (!hasID(cleared, item.messageID)) confirmOptimistic(sessionID, item.messageID, item.parts)
    })
    const messages = reconcileFetched(merged.session, data.message[sessionID] ?? [], {
      // Duplicate ids are harmless: reconcileFetched applies each touched id idempotently.
      touched: [
        ...idsOf(Option.map(load, (value) => value.touchedMessages)),
        ...idsOf(MutableHashMap.get(removedMessages, sessionID)),
      ],
      retained: idsOf(Option.map(load, (value) => value.retainedMessages)),
      removed: idsOf(Option.map(load, (value) => value.removedMessages)),
      preserveUnfetched,
      compare: compareMessages,
    })
    batch(() => {
      if (Option.isSome(source)) setData("session_message", sessionID, reconcile(source.value))
      const messageIDs = replaceMessages(sessionID, messages)
      replaceParts(sessionID, merged.part, messageIDs, load)
      const orphans = MutableHashMap.get(orphanParts, sessionID)
      if (cleanupOrphans && page.complete && Option.isSome(orphans)) {
        for (const messageID of orphans.value) {
          if (!MutableHashSet.has(messageIDs, messageID))
            setData(produce((draft) => deleteMessageParts(draft, messageID)))
        }
        MutableHashMap.remove(orphanParts, sessionID)
      }
      setMeta("limit", sessionID, messages.length)
      setMeta("cursor", sessionID, Option.getOrUndefined(merged.cursor))
      setMeta("complete", sessionID, merged.complete)
      setMeta("at", sessionID, DateTime.toEpochMillis(DateTime.nowUnsafe()))
    })
  }

  // Fetches one page and its missing user parents, then applies it. Succeeds with whether the page was applied.
  const loadPage = Effect.fnUntraced(function* (
    sessionID: string,
    limit: number,
    before: string | undefined,
    mode: "replace" | "prepend" | undefined,
    active: object,
    load: MessageLoadState,
  ) {
    const page = yield* fetchMessages(sessionID, limit, before, () => resetMessageLoad(sessionID, load))
    const first = page.session.reduce(
      (oldest, message) =>
        Option.isNone(oldest) || compareMessages(message, oldest.value) < 0 ? Option.some(message) : oldest,
      Option.none<Message>(),
    )
    if (!isGeneration(sessionID, active)) return false

    let parents: ReadonlyArray<{ message: Message; parts: Part[] }> = []
    if (mode !== "prepend") {
      const users = MutableHashSet.fromIterable([
        ...page.session.filter((message) => message.role === "user").map((message) => message.id),
        ...(data.message[sessionID] ?? [])
          .filter((message) => {
            if (message.role !== "user") return false
            const item = optimisticItem(sessionID, message.id)
            return (
              MutableHashSet.has(load.touchedMessages, message.id) &&
              (Option.isNone(item) || item.value.confirmedMessage === true)
            )
          })
          .map((message) => message.id),
      ])
      const parentIDs = MutableHashSet.fromIterable(
        page.session.flatMap((message) =>
          message.role === "assistant" && !MutableHashSet.has(users, message.parentID) ? [message.parentID] : [],
        ),
      )
      for (const parentID of parentIDs) {
        if (!isGeneration(sessionID, active)) break
        const parent = yield* fetchMessage(sessionID, parentID, () =>
          resetMessageLoad(sessionID, load, messageLoadBaseline(load, parentID)),
        ).pipe(
          Effect.map(Option.some),
          Effect.catchIf(isMissingMessage, () =>
            Effect.sync(() => {
              MutableHashSet.add(load.removedMessages, parentID)
              return Option.none()
            }),
          ),
        )
        if (Option.isNone(parent)) continue
        if (parent.value.message.role !== "user")
          return yield* new AssistantParentError({ message: `Assistant parent is not a user message: ${parentID}` })
        parents = [...parents, parent.value]
      }
    }
    if (!isGeneration(sessionID, active)) return false
    const result =
      mode === "prepend"
        ? page
        : {
            ...page,
            session: merge(
              page.session,
              parents.map((parent) => parent.message),
            ).sort(compareMessages),
            part: merge(
              page.part,
              parents.map((parent) => ({ id: parent.message.id, part: parent.parts })),
            ),
          }
    const preserveUnfetched =
      mode === "prepend" ||
      (!result.complete &&
        Option.match(first, {
          onNone: () => true,
          onSome: (oldest) => (message: Message) => compareMessages(message, oldest) < 0,
        }))
    applyMessagePage(
      sessionID,
      result,
      isLoad(sessionID, load) ? Option.some(load) : Option.none(),
      preserveUnfetched,
      mode !== "prepend",
    )
    return true
  })

  // Runs after every load: a failed or superseded load drops the orphan parts it accepted.
  const finishLoad = (sessionID: string, active: object, load: MessageLoadState, applied: boolean) => {
    if (!applied && isGeneration(sessionID, active) && isLoad(sessionID, load)) {
      for (const messageID of load.orphanParents) {
        if (!hasID(MutableHashMap.get(orphanParts, sessionID), messageID)) continue
        setData(produce((draft) => deleteMessageParts(draft, messageID)))
        removeID(MutableHashMap.get(orphanParts, sessionID), messageID)
      }
      const orphans = MutableHashMap.get(orphanParts, sessionID)
      if (Option.isSome(orphans) && MutableHashSet.size(orphans.value) === 0)
        MutableHashMap.remove(orphanParts, sessionID)
    }
    if (isLoad(sessionID, load)) MutableHashMap.remove(messageLoads, sessionID)
    if (isGeneration(sessionID, active)) setMeta("loading", sessionID, false)
  }

  const loadMessages = Effect.fnUntraced(function* (
    sessionID: string,
    limit: number,
    before?: string,
    mode?: "replace" | "prepend",
  ) {
    if (meta.loading[sessionID]) return
    const active = generation(sessionID)
    const load: MessageLoadState = {
      touchedMessages: MutableHashSet.empty(),
      removedMessages: MutableHashSet.empty(),
      retainedMessages: MutableHashSet.empty(),
      touchedParts: MutableHashMap.empty(),
      deltaParts: MutableHashMap.empty(),
      carriedDeltaParts: MutableHashMap.empty(),
      removedParts: MutableHashMap.empty(),
      optimisticParts: MutableHashMap.empty(),
      orphanParents: MutableHashSet.empty(),
      clearedMessageParts: MutableHashSet.empty(),
      touchedSource: MutableHashSet.empty(),
    }
    MutableHashMap.set(messageLoads, sessionID, load)
    setMeta("loading", sessionID, true)
    yield* loadPage(sessionID, limit, before, mode, active, load).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => finishLoad(sessionID, active, load, Exit.isSuccess(exit) && exit.value)),
      ),
    )
  })

  const syncSession = (sessionID: string, options?: { force?: boolean; messageLimit?: number }) =>
    share(
      inflight,
      sessionID,
      Effect.gen(function* () {
        const cached = data.message[sessionID] !== undefined && meta.limit[sessionID] !== undefined
        if (cached && data.info[sessionID] && !options?.force) return
        // Both requests run to completion even when the other one fails, as Promise.all did.
        const resolving = yield* Effect.forkDetach(resolveSession(sessionID, options), { startImmediately: true })
        const loading = yield* Effect.forkDetach(
          cached && !options?.force
            ? Effect.void
            : loadMessages(sessionID, options?.messageLimit ?? meta.limit[sessionID] ?? initialMessagePageSize),
          { startImmediately: true },
        )
        yield* Effect.all([Fiber.join(resolving), Fiber.join(loading)], { concurrency: "unbounded", discard: true })
      }),
    )

  const sync = (sessionID: string, options?: { force?: boolean; messageLimit?: number }) => {
    touch(sessionID)
    return run(syncSession(sessionID, options))
  }

  const prefetchSession = Effect.fnUntraced(function* (sessionID: string, limit: number) {
    const pending = MutableHashMap.get(inflight, sessionID)
    if (Option.isSome(pending)) yield* Deferred.await(pending.value)
    const now = yield* Clock.currentTimeMillis
    if (
      now - (meta.at[sessionID] ?? 0) <= 15_000 &&
      (meta.complete[sessionID] || (data.message[sessionID]?.length ?? 0) >= limit)
    )
      return
    yield* share(inflight, sessionID, loadMessages(sessionID, limit))
  })

  const prefetch = (sessionID: string, limit: number) => {
    touch(sessionID)
    return run(prefetchSession(sessionID, limit))
  }

  const eventSessionID = (event: { type: string; properties?: unknown }) => {
    const properties = event.properties
    if (!properties || typeof properties !== "object") return undefined
    if ("sessionID" in properties && typeof properties.sessionID === "string") return properties.sessionID
    if (
      "info" in properties &&
      properties.info &&
      typeof properties.info === "object" &&
      "sessionID" in properties.info &&
      typeof properties.info.sessionID === "string"
    )
      return properties.info.sessionID
    if (
      "part" in properties &&
      properties.part &&
      typeof properties.part === "object" &&
      "sessionID" in properties.part &&
      typeof properties.part.sessionID === "string"
    )
      return properties.part.sessionID
    return undefined
  }

  const projectV2 = (reduction: V2SessionReduction) => {
    const load = MutableHashMap.get(messageLoads, reduction.sessionID)
    if (Option.isSome(load))
      reduction.touched.forEach((messageID) => MutableHashSet.add(load.value.touchedSource, messageID))
    setData("session_message", reduction.sessionID, reconcile(reduction.messages))
    if (reduction.touched.length === 0) return

    const touched = MutableHashSet.fromIterable(reduction.touched)
    // The latest user or synthetic turn root; a shell message ends the turn.
    let parentID: Option.Option<string> = Option.none()
    for (const message of reduction.messages) {
      if (message.type === "user" || (message.type === "synthetic" && message.description?.trim()))
        parentID = Option.some(message.id)
      if (message.type === "shell") {
        if (MutableHashSet.has(touched, message.id)) MutableHashSet.add(touched, `${message.id}:assistant`)
        parentID = Option.none()
      }
      if (
        (message.type === "assistant" || message.type === "compaction") &&
        MutableHashSet.has(touched, message.id) &&
        Option.isSome(parentID)
      )
        MutableHashSet.add(touched, parentID.value)
    }

    const normalized = normalizeSessionMessages(reduction.sessionID, reduction.messages)
    batch(() => {
      for (const message of normalized.messages) {
        if (!MutableHashSet.has(touched, message.id)) continue
        observeSession(reduction.sessionID)
        applyMessageUpdated(message)
      }
      for (const messageID of touched) {
        const next = Option.getOrElse(MutableHashMap.get(normalized.parts, messageID), (): Part[] => [])
        const nextIDs = MutableHashSet.fromIterable(next.map((part) => part.id))
        for (const part of next) {
          observeSession(reduction.sessionID)
          applyPartUpdated(part)
        }
        for (const part of data.part[messageID] ?? []) {
          if (MutableHashSet.has(nextIDs, part.id)) continue
          observeSession(reduction.sessionID)
          applyPartRemoved(reduction.sessionID, messageID, part.id)
        }
      }
    })
  }

  const hydrateV2Message = (sessionID: string, messageID: string) => {
    if (Option.isNone(sessionApi)) return
    const api = sessionApi.value
    // Hydration is best effort: a failed request or projection leaves the reduced state as it is.
    Effect.runFork(
      attempt(() => api.message({ sessionID, messageID })).pipe(
        Effect.map((message) => {
          const current = data.session_message[sessionID] ?? []
          const messages = [...current.filter((item) => item.id !== message.id), message].sort(compareMessages)
          projectV2({ sessionID, messages, touched: [message.id] })
        }),
        Effect.ignoreCause,
      ),
    )
  }

  // Refreshes session info in the background; a failed refresh keeps the cached info.
  const refreshSession = (sessionID: string, options?: { force?: boolean }) =>
    Effect.runFork(resolveSession(sessionID, options).pipe(Effect.ignoreCause))

  const applyV2 = (event: OpenCodeEvent) => {
    if (!("data" in event) || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    const reduction = v2.reduce(data.session_message[sessionID] ?? [], event)
    if (reduction) {
      projectV2(reduction)
      if (reduction.missing) hydrateV2Message(sessionID, reduction.missing)
    }

    const info = data.info[sessionID]
    if (event.type === "session.renamed" && info)
      remember({ ...info, title: event.data.title, time: { ...info.time, updated: event.created } })
    if (event.type === "session.moved" && info)
      remember({
        ...info,
        projectID: event.data.projectID ?? info.projectID,
        workspaceID: event.data.location.workspaceID,
        directory: event.data.location.directory,
        path: event.data.subpath,
        time: { ...info.time, updated: event.created },
      })
    if (event.type === "session.usage.updated" && info)
      remember({ ...info, cost: event.data.cost, tokens: event.data.tokens })
    // if (event.type === "session.archived") {
    //   if (info) remember({ ...info, time: { ...info.time, archived: event.created, updated: event.created } })
    //   evict([sessionID])
    // }
    if (event.type === "session.execution.started") setData("session_status", sessionID, { type: "busy" })
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    )
      setData("session_status", sessionID, { type: "idle" })
    if (event.type === "session.retry.scheduled")
      setData("session_status", sessionID, {
        type: "retry",
        attempt: event.data.attempt,
        message: event.data.error.message,
        next: event.data.at,
      })
    if (event.type === "session.forked") refreshSession(sessionID, { force: true })
    if (
      event.type === "session.revert.staged" ||
      event.type === "session.revert.cleared" ||
      event.type === "session.revert.committed"
    )
      refreshSession(sessionID, { force: true })
  }

  // A session event keeps its session in the cache, and loads the session info when the event arrives first.
  const observeSession = (sessionID: string) => {
    touch(sessionID)
    if (!data.info[sessionID]) refreshSession(sessionID)
  }

  const applyMessageUpdated = (message: Message) => {
    const info = cleanMessage(message)
    indexLegacyMessage(info)
    const load = MutableHashMap.get(messageLoads, info.sessionID)
    if (Option.isSome(load)) {
      MutableHashSet.add(load.value.touchedMessages, info.id)
      MutableHashSet.remove(load.value.removedMessages, info.id)
    }
    const item = optimisticItem(info.sessionID, info.id)
    if (Option.isSome(item)) {
      if (item.value.parts.length === 0) clearOptimistic(info.sessionID, info.id)
      if (item.value.parts.length > 0)
        setOptimisticItem(info.sessionID, info.id, { ...item.value, confirmedMessage: true })
    }
    removeFromIndex(orphanParts, info.sessionID, info.id)
    removeFromIndex(removedMessages, info.sessionID, info.id)
    const messages = data.message[info.sessionID]
    if (!messages) {
      setData("message", info.sessionID, [info])
      return
    }
    const result = Binary.search(messages, messageKey(info), messageKey)
    if (result.found) setData("message", info.sessionID, result.index, reconcile(info))
    if (!result.found)
      setData("message", info.sessionID, (value = []) => {
        const next = value.slice()
        next.splice(result.index, 0, info)
        return next
      })
  }

  const applyPartUpdated = (part: Part) => {
    if (HashSet.has(SKIP_PARTS, part.type)) return
    const messages = data.message[part.sessionID]
    const load = MutableHashMap.get(messageLoads, part.sessionID)
    const missing = !messages?.some((message) => message.id === part.messageID)
    // Outside a page load, accepting a part without its ordered parent event would create an unbounded orphan.
    if (
      missing &&
      (Option.isNone(load) ||
        MutableHashSet.has(load.value.clearedMessageParts, part.messageID) ||
        hasID(MutableHashMap.get(removedMessages, part.sessionID), part.messageID))
    )
      return
    if (missing) {
      addToIndex(orphanParts, part.sessionID, part.messageID)
      if (Option.isSome(load)) MutableHashSet.add(load.value.orphanParents, part.messageID)
    }
    if (Option.isSome(load)) {
      removeFromIndex(load.value.deltaParts, part.messageID, part.id)
      removeFromIndex(load.value.carriedDeltaParts, part.messageID, part.id)
      removeFromIndex(load.value.removedParts, part.messageID, part.id)
      removeFromIndex(load.value.optimisticParts, part.messageID, part.id)
    }
    const pending = MutableHashMap.get(pendingParts, part.sessionID)
    if (Option.isSome(pending)) {
      removeFromIndex(pending.value, part.messageID, part.id)
      if (MutableHashMap.size(pending.value) === 0) MutableHashMap.remove(pendingParts, part.sessionID)
    }
    MutableHashMap.remove(deltaBases, part.id)
    trackPartChange(part.sessionID, part.messageID, part.id)
    confirmOptimisticPart(part.sessionID, part.messageID, part)
    setData(
      "part_text_accum_delta",
      produce((draft) => void delete draft[part.id]),
    )
    const parts = data.part[part.messageID]
    if (!parts) {
      setData("part", part.messageID, [part])
      return
    }
    const result = Binary.search(parts, part.id, (item) => item.id)
    if (result.found) setData("part", part.messageID, result.index, reconcile(part))
    if (!result.found)
      setData("part", part.messageID, (value = []) => {
        const next = value.slice()
        next.splice(result.index, 0, part)
        return next
      })
  }

  const applyPartRemoved = (sessionID: string, messageID: string, partID: string) => {
    // Part removal is event-only on the server, so its tombstone lasts until a later update or eviction.
    const pending = Option.getOrElse(MutableHashMap.get(pendingParts, sessionID), (): IDIndex => MutableHashMap.empty())
    addToIndex(pending, messageID, partID)
    MutableHashMap.set(pendingParts, sessionID, pending)
    const load = MutableHashMap.get(messageLoads, sessionID)
    if (Option.isSome(load)) {
      removeFromIndex(load.value.deltaParts, messageID, partID)
      removeFromIndex(load.value.carriedDeltaParts, messageID, partID)
      addToIndex(load.value.removedParts, messageID, partID)
      removeFromIndex(load.value.optimisticParts, messageID, partID)
    }
    trackPartChange(sessionID, messageID, partID)
    clearOptimisticPart(sessionID, messageID, partID)
    setData(
      produce((draft) => {
        delete draft.part_text_accum_delta[partID]
        MutableHashMap.remove(deltaBases, partID)
        const parts = draft.part[messageID]
        if (!parts) return
        const result = Binary.search(parts, partID, (part) => part.id)
        const next = result.found ? parts.toSpliced(result.index, 1) : parts
        if (next.length === 0) {
          delete draft.part[messageID]
          return
        }
        if (result.found) draft.part[messageID] = next
      }),
    )
  }

  const apply = (event: Event) => {
    const eventID = eventSessionID(event)
    if (eventID) {
      if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted")
        touch(eventID)
      else observeSession(eventID)
    }
    switch (event.type) {
      case "session.created":
        remember(event.properties.info)
        return
      case "session.updated": {
        const info = event.properties.info
        remember(info)
        if (info.time.archived) evict([info.id])
        return
      }
      case "session.deleted": {
        const sessionID = event.properties.info?.id ?? event.properties.sessionID
        if (!sessionID) return
        MutableHashSet.remove(infoSeen, sessionID)
        setData(
          "info",
          produce((draft) => void delete draft[sessionID]),
        )
        evict([sessionID])
        return
      }
      case "todo.updated":
        setData("todo", event.properties.sessionID, reconcile(event.properties.todos, { key: "id" }))
        return
      case "session.status":
        setData("session_status", event.properties.sessionID, reconcile(event.properties.status))
        return
      case "message.updated":
        applyMessageUpdated(event.properties.info)
        return
      case "message.removed": {
        const props = event.properties
        setData("session_message", props.sessionID, (messages) =>
          messages?.filter((message) => message.id !== props.messageID),
        )
        const load = MutableHashMap.get(messageLoads, props.sessionID)
        if (Option.isSome(load)) {
          MutableHashSet.add(load.value.touchedMessages, props.messageID)
          MutableHashSet.add(load.value.removedMessages, props.messageID)
          MutableHashSet.add(load.value.clearedMessageParts, props.messageID)
          MutableHashMap.remove(load.value.deltaParts, props.messageID)
          MutableHashMap.remove(load.value.carriedDeltaParts, props.messageID)
          MutableHashMap.remove(load.value.removedParts, props.messageID)
          MutableHashMap.remove(load.value.optimisticParts, props.messageID)
        }
        const pending = MutableHashMap.get(pendingParts, props.sessionID)
        if (Option.isSome(pending)) {
          MutableHashMap.remove(pending.value, props.messageID)
          if (MutableHashMap.size(pending.value) === 0) MutableHashMap.remove(pendingParts, props.sessionID)
        }
        addToIndex(removedMessages, props.sessionID, props.messageID)
        clearOptimistic(props.sessionID, props.messageID)
        setData(
          produce((draft) => {
            const messages = draft.message[props.sessionID]
            if (messages) {
              const index = messages.findIndex((message) => message.id === props.messageID)
              if (index >= 0) draft.message[props.sessionID] = messages.toSpliced(index, 1)
            }
            deleteMessageParts(draft, props.messageID)
          }),
        )
        return
      }
      case "message.part.updated":
        applyPartUpdated(event.properties.part)
        return
      case "message.part.removed":
        applyPartRemoved(event.properties.sessionID, event.properties.messageID, event.properties.partID)
        return
      case "message.part.delta": {
        const props = event.properties
        const parts = data.part[props.messageID]
        if (!parts) return
        const result = Binary.search(parts, props.partID, (part) => part.id)
        if (!result.found) return
        trackPartChange(props.sessionID, props.messageID, props.partID)
        const load = MutableHashMap.get(messageLoads, props.sessionID)
        if (Option.isSome(load)) {
          addToIndex(load.value.deltaParts, props.messageID, props.partID)
          removeFromIndex(load.value.carriedDeltaParts, props.messageID, props.partID)
        }
        const current = textField(parts[result.index], props.field)
        if (!MutableHashMap.has(deltaBases, props.partID) && Option.isSome(current))
          MutableHashMap.set(deltaBases, props.partID, { base: current.value, sessionID: props.sessionID })
        setData(
          "part_text_accum_delta",
          props.partID,
          (value) => (value ?? Option.getOrElse(current, () => "")) + props.delta,
        )
        setData(
          "part",
          props.messageID,
          produce((draft) => {
            if (!draft) return
            const part = draft[result.index]
            Object.assign(part, {
              [props.field]: Option.getOrElse(textField(part, props.field), () => "") + props.delta,
            })
          }),
        )
        return
      }
      case "permission.asked": {
        const permission: PermissionRequest = event.properties
        const permissions = data.permission[permission.sessionID]
        if (!permissions) {
          setData("permission", permission.sessionID, [permission])
          return
        }
        const result = Binary.search(permissions, permission.id, (item) => item.id)
        if (result.found) setData("permission", permission.sessionID, result.index, reconcile(permission))
        if (!result.found)
          setData(
            "permission",
            permission.sessionID,
            produce((draft) => void draft.splice(result.index, 0, permission)),
          )
        return
      }
      case "permission.replied": {
        const props = event.properties
        setData(
          "permission",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
        return
      }
      case "question.asked": {
        const question: QuestionRequest = event.properties
        const questions = data.question[question.sessionID]
        if (!questions) {
          setData("question", question.sessionID, [question])
          return
        }
        const result = Binary.search(questions, question.id, (item) => item.id)
        if (result.found) setData("question", question.sessionID, result.index, reconcile(question))
        if (!result.found)
          setData(
            "question",
            question.sessionID,
            produce((draft) => void draft.splice(result.index, 0, question)),
          )
        return
      }
      case "question.replied":
      case "question.rejected": {
        const props = event.properties
        setData(
          "question",
          props.sessionID,
          produce((draft) => {
            if (!draft) return
            const result = Binary.search(draft, props.requestID, (item) => item.id)
            if (result.found) draft.splice(result.index, 1)
          }),
        )
      }
    }
  }

  return {
    data,
    set: setData,
    get: (sessionID: string) => data.info[sessionID],
    peek: (sessionID: string) => data.info[sessionID],
    remember,
    resolve,
    lineage: {
      find: findLineage,
      // The sync form for a Solid memo. A parent cycle throws SessionParentCycleError to the ErrorBoundary.
      peek: (sessionID: string): SessionLineage | undefined =>
        Option.getOrUndefined(Result.getOrThrow(findLineage(sessionID))),
      resolve: (sessionID: string) =>
        run(
          Effect.gen(function* () {
            const session = yield* resolveSession(sessionID)
            const root = yield* rootSession(session, (parentID) => resolveSession(parentID))
            return { session, root }
          }),
        ),
    },
    sync,
    prefetch,
    shouldPrefetch(sessionID: string, limit: number) {
      if (data.message[sessionID] === undefined) return true
      if (DateTime.toEpochMillis(DateTime.nowUnsafe()) - (meta.at[sessionID] ?? 0) > 15_000) return true
      if (meta.complete[sessionID]) return false
      return (meta.limit[sessionID] ?? 0) <= limit
    },
    fresh(sessionID: string, ttl: number) {
      return DateTime.toEpochMillis(DateTime.nowUnsafe()) - (meta.at[sessionID] ?? 0) <= ttl
    },
    optimistic: {
      add(input: { sessionID: string; message: Message; parts: Part[] }) {
        const parts = input.parts
          .filter((part) => !!part?.id && !HashSet.has(SKIP_PARTS, part.type))
          .sort((a, b) => cmp(a.id, b.id))
        const load = MutableHashMap.get(messageLoads, input.sessionID)
        if (Option.isSome(load)) {
          if (MutableHashSet.has(load.value.clearedMessageParts, input.message.id))
            mergeIntoIndex(
              load.value.touchedParts,
              input.message.id,
              parts.map((part) => part.id),
            )
          MutableHashSet.remove(load.value.removedMessages, input.message.id)
          MutableHashMap.set(
            load.value.optimisticParts,
            input.message.id,
            MutableHashSet.fromIterable(parts.map((part) => part.id)),
          )
        }
        const items = MutableHashMap.get(optimistic, input.sessionID)
        removeFromIndex(removedMessages, input.sessionID, input.message.id)
        const item: OptimisticItem = { ...input, parts, confirmedParts: [] }
        if (Option.isSome(items)) MutableHashMap.set(items.value, input.message.id, item)
        if (Option.isNone(items))
          MutableHashMap.set(optimistic, input.sessionID, MutableHashMap.make([input.message.id, item]))
        setData("message", input.sessionID, (messages = []) => merge(messages, [input.message]).sort(compareMessages))
        setData(
          "part_text_accum_delta",
          produce((draft) => {
            for (const part of [...(data.part[input.message.id] ?? []), ...parts]) {
              delete draft[part.id]
              MutableHashMap.remove(deltaBases, part.id)
            }
          }),
        )
        setData("part", input.message.id, parts)
      },
      remove(input: { sessionID: string; messageID: string }) {
        const found = optimisticItem(input.sessionID, input.messageID)
        if (Option.isNone(found)) return
        const item = found.value
        const load = MutableHashMap.get(messageLoads, input.sessionID)
        if (Option.isSome(load)) MutableHashMap.remove(load.value.optimisticParts, input.messageID)
        clearOptimistic(input.sessionID, input.messageID)
        if (item.confirmedMessage) {
          const partIDs = MutableHashSet.fromIterable(item.parts.map((part) => part.id))
          setData(
            produce((draft) => {
              for (const part of item.parts) {
                delete draft.part_text_accum_delta[part.id]
                MutableHashMap.remove(deltaBases, part.id)
              }
              const parts = draft.part[input.messageID]
              if (!parts) return
              draft.part[input.messageID] = parts.filter((part) => !MutableHashSet.has(partIDs, part.id))
              if (draft.part[input.messageID]?.length === 0) delete draft.part[input.messageID]
            }),
          )
          return
        }
        setData("message", input.sessionID, (messages) => messages?.filter((message) => message.id !== input.messageID))
        setData(produce((draft) => deleteMessageParts(draft, input.messageID)))
      },
    },
    todo(sessionID: string, request?: { force?: boolean }) {
      touch(sessionID)
      return run(
        Effect.gen(function* () {
          if (data.todo[sessionID] !== undefined && !request?.force) return
          if (yield* protocolIs("v2")) {
            setData("todo", sessionID, [])
            return
          }
          yield* share(
            inflightTodo,
            sessionID,
            Effect.suspend(() => {
              const active = generation(sessionID)
              return attempt(() => retryRequest(() => client.session.todo({ sessionID }))).pipe(
                Effect.map((result) => {
                  if (!isGeneration(sessionID, active)) return
                  setData("todo", sessionID, reconcile(result.data ?? [], { key: "id" }))
                }),
              )
            }),
          )
        }),
      )
    },
    history: {
      more: (sessionID: string) =>
        data.message[sessionID] !== undefined &&
        meta.limit[sessionID] !== undefined &&
        !meta.complete[sessionID] &&
        !!meta.cursor[sessionID],
      loading: (sessionID: string) => meta.loading[sessionID] ?? false,
      loadMore(sessionID: string, count = historyMessagePageSize) {
        touch(sessionID)
        return run(
          Effect.suspend(() =>
            meta.loading[sessionID] || meta.complete[sessionID] || !meta.cursor[sessionID]
              ? Effect.void
              : loadMessages(sessionID, count, meta.cursor[sessionID], "prepend"),
          ),
        )
      },
    },
    evict(sessionID: string) {
      if (protectedSessions().includes(sessionID)) return
      MutableHashSet.remove(seen, sessionID)
      evict([sessionID])
    },
    pin(sessionID: string) {
      MutableHashMap.set(pinned, sessionID, Option.getOrElse(MutableHashMap.get(pinned, sessionID), () => 0) + 1)
      touch(sessionID)
    },
    unpin(sessionID: string) {
      const count = Option.getOrElse(MutableHashMap.get(pinned, sessionID), () => 0)
      if (count <= 1) MutableHashMap.remove(pinned, sessionID)
      if (count > 1) MutableHashMap.set(pinned, sessionID, count - 1)
    },
    apply,
    applyV2,
  }
}

export type ServerSession = ReturnType<typeof createServerSession>

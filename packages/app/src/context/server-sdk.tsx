import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { type Accessor, batch, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { createApiForServer, createSdkForServer, type ServerApi } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"
import { detectServerProtocol, type ServerProtocol } from "@/utils/server-protocol"
import { createCompatibleApi, type CompatibleApi } from "@/utils/server-compat"
import { createFiberSlot } from "@/utils/fiber-slot"
import { Cause, Data, DateTime, Effect, Option, Predicate, Result, Stream } from "effect"

/** Raised when the ServerSDK context has no server to talk to. The message is the translated text. */
class NoServerAvailableError extends Data.TaggedError("NoServerAvailableError")<{ readonly message: string }> {}

/** The event stream request, or the stream itself, failed. */
class EventStreamError extends Data.TaggedError("App.EventStreamError")<{ readonly cause: unknown }> {}

const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

const isAbortError = (error: unknown) =>
  Predicate.isObjectOrArray(error) && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
export type ServerEvent = Event & { current?: OpenCodeEvent }
type QueuedServerEvent = { directory: string; payload: ServerEvent }
// A V1 global stream event wraps its payload; a V2 event is an OpenCodeEvent.
type StreamEvent = GlobalEvent | OpenCodeEvent
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"]
type CurrentDelta = Extract<
  OpenCodeEvent,
  { type: "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "session.compaction.delta" }
>

export function adaptServerEvent(event: OpenCodeEvent): ServerEvent {
  if (event.type === "permission.v2.asked") {
    return {
      id: event.id,
      type: "permission.asked",
      properties: {
        id: event.data.id,
        sessionID: event.data.sessionID,
        permission: event.data.action,
        patterns: event.data.resources,
        always: event.data.save ?? [],
        metadata: event.data.metadata ?? {},
        ...(event.data.source?.type === "tool"
          ? { tool: { messageID: event.data.source.messageID, callID: event.data.source.callID } }
          : {}),
      },
      current: event,
    } as ServerEvent
  }
  if (event.type === "permission.v2.replied")
    return { id: event.id, type: "permission.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.asked")
    return { id: event.id, type: "question.asked", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.replied")
    return { id: event.id, type: "question.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.rejected")
    return { id: event.id, type: "question.rejected", properties: event.data, current: event } as ServerEvent
  return { id: event.id, type: event.type, properties: event.data, current: event } as ServerEvent
}

const coalescedKey = (event: QueuedServerEvent) => {
  if (event.payload.type === "lsp.updated") return `lsp.updated:${event.directory}`
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return `message.part.updated:${event.directory}:${part.messageID}:${part.id}`
  }
  return undefined
}

export function enqueueServerEvent(queue: QueuedServerEvent[], event: QueuedServerEvent) {
  const key = coalescedKey(event)
  const previous = queue[queue.length - 1]
  if (key && previous && coalescedKey(previous) === key) {
    queue[queue.length - 1] = event
    return false
  }
  queue.push(event)
  return true
}

export function coalesceServerEvents(events: QueuedServerEvent[]) {
  const output: QueuedServerEvent[] = []
  events.forEach((event) => {
    const current = currentDelta(event.payload.current)
    if (Option.isSome(current)) {
      const previous = output[output.length - 1]
      const prior = currentDelta(previous?.payload.current)
      if (
        previous &&
        Option.isSome(prior) &&
        previous.directory === event.directory &&
        currentDeltaKey(prior.value) === currentDeltaKey(current.value)
      ) {
        // A current delta payload is the adapted form of its event, so the merged event adapts the same way.
        const merged = withDeltaFragment(
          current.value,
          currentDeltaFragment(prior.value) + currentDeltaFragment(current.value),
        )
        output[output.length - 1] = { directory: event.directory, payload: adaptServerEvent(merged) }
        return
      }
      output.push(event)
      return
    }
    if (event.payload.type !== "message.part.delta") {
      output.push(event)
      return
    }
    const props = event.payload.properties
    const previous = output[output.length - 1]
    if (
      !previous ||
      previous.payload.type !== "message.part.delta" ||
      previous.directory !== event.directory ||
      previous.payload.properties.messageID !== props.messageID ||
      previous.payload.properties.partID !== props.partID ||
      previous.payload.properties.field !== props.field
    ) {
      output.push({
        directory: event.directory,
        payload: { ...event.payload, properties: { ...props } },
      })
      return
    }
    output[output.length - 1] = {
      directory: event.directory,
      payload: {
        ...event.payload,
        properties: { ...props, delta: previous.payload.properties.delta + props.delta },
      },
    }
  })
  return output
}

function currentDelta(event: OpenCodeEvent | undefined): Option.Option<CurrentDelta> {
  if (
    event?.type === "session.text.delta" ||
    event?.type === "session.reasoning.delta" ||
    event?.type === "session.tool.input.delta" ||
    event?.type === "session.compaction.delta"
  )
    return Option.some(event)
  return Option.none()
}

// The same delta event with its text fragment replaced; a compaction delta keeps its fragment in `text`.
function withDeltaFragment(event: CurrentDelta, fragment: string): CurrentDelta {
  if (event.type === "session.compaction.delta") return { ...event, data: { ...event.data, text: fragment } }
  if (event.type === "session.text.delta") return { ...event, data: { ...event.data, delta: fragment } }
  if (event.type === "session.reasoning.delta") return { ...event, data: { ...event.data, delta: fragment } }
  return { ...event, data: { ...event.data, delta: fragment } }
}

function currentDeltaKey(event: CurrentDelta) {
  if (event.type === "session.tool.input.delta")
    return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.callID}`
  if (event.type === "session.compaction.delta") return `${event.type}:${event.data.sessionID}`
  return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.ordinal}`
}

function currentDeltaFragment(event: CurrentDelta) {
  return event.type === "session.compaction.delta" ? event.data.text : event.data.delta
}

export function resumeStreamAfterPageShow(event: Pick<PageTransitionEvent, "persisted">, start: () => unknown) {
  if (!event.persisted) return
  start()
}

type ServerEventEmitter = ReturnType<typeof createGlobalEmitter<{ [key: string]: ServerEvent }>>
type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  protocol: Promise<ServerProtocol>
  protocolKind: Accessor<ServerProtocol | undefined>
  url: string
  client: ReturnType<typeof createSdkForServer>
  api: CompatibleApi
  currentApi: ServerApi
  event: {
    on: ServerEventEmitter["on"]
    listen: ServerEventEmitter["listen"]
    start: () => Promise<void> | undefined
  }
  createClient: (
    opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">,
  ) => ReturnType<typeof createSdkForServer>
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope): ServerSDKBase {
  const platform = usePlatform()
  const abort = new AbortController()

  // The event stream uses the platform fetch only for a plain-HTTP server that is not on this machine.
  const eventFetch = Option.fromNullishOr(platform.fetch).pipe(
    Option.filter(() =>
      Result.try(() => new URL(server.http.url)).pipe(
        Result.getSuccess,
        Option.exists((url) => url.protocol === "http:" && !LOOPBACK_HOSTS.includes(url.hostname)),
      ),
    ),
  )
  const eventFetchInput = Option.match(eventFetch, { onNone: () => ({}), onSome: (fetch) => ({ fetch }) })

  const eventApi = createApiForServer({ server: server.http, ...eventFetchInput })
  const eventSdk = createSdkForServer({
    signal: abort.signal,
    ...eventFetchInput,
    server: server.http,
  })
  const protocol = Effect.runPromise(detectServerProtocol(server.http, platform.fetch ?? globalThis.fetch))
  const [protocolKind] = createResource(
    () => protocol,
    (value) => value,
  )
  const emitter = createGlobalEmitter<{
    [key: string]: ServerEvent
  }>()

  type Queued = QueuedServerEvent
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8
  const RECONNECT_DELAY_MS = 250

  let queue: Queued[] = []
  let buffer: Queued[] = []
  // At most one flush waits in the slot; `flushPending` stays true from schedule until that flush runs.
  const flushTimer = createFiberSlot()
  let flushPending = false
  let last = 0

  const emitQueued = () => {
    flushPending = false
    if (queue.length === 0) return

    const events = queue
    queue = buffer
    buffer = events
    queue.length = 0

    last = nowMillis()
    const output = coalesceServerEvents(events)
    batch(() => {
      output.forEach((event) => emitter.emit(event.directory, event.payload))
    })

    buffer.length = 0
  }

  const flush = () => {
    flushTimer.interrupt()
    emitQueued()
  }

  const schedule = () => {
    if (flushPending) return
    flushPending = true
    const delay = Math.max(0, FLUSH_FRAME_MS - (nowMillis() - last))
    flushTimer.run(Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(emitQueued))))
  }

  const enqueueStreamEvent = (event: StreamEvent) => {
    if ("payload" in event) {
      const payload = event.payload
      if (payload.type === "sync") return
      if (enqueueServerEvent(queue, { directory: event.directory ?? "global", payload })) schedule()
      return
    }
    const payload = adaptServerEvent(event)
    if (enqueueServerEvent(queue, { directory: event.location?.directory ?? "global", payload })) schedule()
  }

  let streamErrorLogged = false
  let attempt: Option.Option<AbortController> = Option.none()
  let run: Option.Option<Promise<void>> = Option.none()
  let runs = 0
  let latestRun = 0
  let started = false
  let generation = 0

  // Reads one event stream until it ends or fails.
  const readEvents = (signal: AbortSignal) =>
    Effect.gen(function* () {
      const kind = yield* Effect.promise(() => protocol)
      const events: AsyncIterable<StreamEvent> =
        kind === "v1"
          ? (yield* Effect.tryPromise({
              try: () => eventSdk.global.event({ signal }),
              catch: (cause) => new EventStreamError({ cause }),
            })).stream
          : eventApi.event.subscribe({ signal })
      let yielded = nowMillis()
      yield* Stream.fromAsyncIterable(events, (cause) => new EventStreamError({ cause })).pipe(
        Stream.runForEach((event) => {
          streamErrorLogged = false
          enqueueStreamEvent(event)
          if (nowMillis() - yielded < STREAM_YIELD_MS) return Effect.void
          yielded = nowMillis()
          // In a browser this yield is a macrotask, so the page can render between bursts of events.
          return Effect.yieldNow
        }),
      )
    })

  // Logs the first failure of a run of failures; a closed or aborted stream is not a failure.
  const reportStreamFailure = (cause: Cause.Cause<EventStreamError>, signal: AbortSignal) => {
    const failure = Cause.squash(cause)
    const error = failure instanceof EventStreamError ? failure.cause : failure
    if (isStreamClosed(error, signal) || streamErrorLogged) return Effect.void
    streamErrorLogged = true
    return Effect.logError("[global-sdk] event stream failed", {
      url: server.http.url,
      fetch: Option.isSome(eventFetch) ? "platform" : "webview",
      error,
    })
  }

  const connect = Effect.suspend(() => {
    const controller = new AbortController()
    attempt = Option.some(controller)
    const onAbort = () => controller.abort()
    abort.signal.addEventListener("abort", onAbort)
    return readEvents(controller.signal).pipe(
      Effect.catchCause((cause) => reportStreamFailure(cause, controller.signal)),
      Effect.ensuring(
        Effect.sync(() => {
          abort.signal.removeEventListener("abort", onAbort)
          attempt = Option.none()
        }),
      ),
    )
  })

  const streamLoop = (active: number) =>
    Effect.gen(function* () {
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started && generation === active) {
        yield* connect
        if (abort.signal.aborted || !started || generation !== active) return
        yield* Effect.sleep(RECONNECT_DELAY_MS)
      }
    })

  const start = () => {
    if (started) return Option.getOrUndefined(run)
    started = true
    const active = ++generation
    const previous = run
    const id = ++runs
    latestRun = id
    const current = Effect.runPromise(
      Effect.gen(function* () {
        if (Option.isSome(previous)) yield* Effect.promise(() => previous.value)
        yield* streamLoop(active)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // Only the latest run clears the handle and flushes what is left.
            if (latestRun !== id) return
            run = Option.none()
            flush()
          }),
        ),
      ),
    )
    run = Option.some(current)
    return current
  }

  const stop = () => {
    started = false
    generation++
    if (Option.isSome(attempt)) attempt.value.abort()
  }

  onMount(() => {
    makeEventListener(window, "pagehide", stop)
    makeEventListener(window, "pageshow", (event) => resumeStreamAfterPageShow(event, start))
  })

  onCleanup(() => {
    stop()
    abort.abort()
    flush()
  })

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })
  const currentApi: ServerApi = createApiForServer({ server: server.http, fetch: platform.fetch })
  const legacy = (directory?: string) =>
    createSdkForServer({
      server: server.http,
      fetch: platform.fetch,
      throwOnError: true,
      directory,
    })
  const api = createCompatibleApi({ protocol, current: currentApi, legacy })

  return {
    server,
    scope,
    protocol,
    protocolKind,
    url: server.http.url,
    client: sdk,
    api,
    currentApi,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      // The memo must return a ServerSDK synchronously, so a missing server is thrown for the error boundary.
      const conn = Option.getOrThrowWith(
        Option.fromNullishOr(props.server?.() ?? server.current),
        () => new NoServerAvailableError({ message: language.t("error.serverSDK.noServerAvailable") }),
      )
      return global.ensureServerCtx(conn).sdk
    })
  },
})

export function useServerProtocol() {
  const serverSDK = useServerSDK()
  return createMemo(() => serverSDK().protocolKind())
}

type SDKEventMap = {
  [key in Event["type"]]: Extract<ServerEvent, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    scope: serverSDK.scope,
    protocol: serverSDK.protocol,
    directory,
    client,
    api: createCompatibleApi({
      protocol: serverSDK.protocol,
      current: serverSDK.currentApi,
      legacy: (next) => serverSDK.createClient({ directory: next ?? directory, throwOnError: true }),
      directory,
    }),
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}

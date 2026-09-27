import WebSocket from "ws"
import { Clock, DateTime, Deferred, Effect, MutableHashMap, Option, Schema } from "effect"
import { ProviderError } from "@/provider/error"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { OpenAIWebSocket } from "./ws"

export const TITLE_HEADER = "x-opencode-title"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
}

interface PoolEntry {
  socket: Option.Option<WebSocket>
  connectedAt: Option.Option<number>
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
}

class ConnectionLimitError extends Schema.TaggedError<ConnectionLimitError>()(
  "OpenAIWebSocketPool.ConnectionLimitError",
  { message: Schema.String },
) {}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// Socket callbacks run outside any fiber, so they read the wall clock directly.
const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = MutableHashMap.empty<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? 5
  // eslint-disable-next-line effect/no-set-timeout-use-schedule -- (a) the prune timer must be unref'd so an idle pool never keeps the process alive; Effect.sleep timers cannot be unref'd
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  const fetchEffect = Effect.fn("OpenAIWebSocketPool.fetch")(function* (input: RequestInfo | URL, init?: RequestInit) {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalHeaders(init)
    // A rejected HTTP request reaches the AI SDK unchanged: Effect.promise keeps the rejection as a
    // defect, and runPromise rejects with that same value.
    const http = Effect.promise(() => httpFetch(input, httpInit))

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) return yield* http

    const body = typeof init.body === "string" ? decodeJson(init.body).pipe(Option.filter(isRecord)) : Option.none()
    if (Option.isNone(body) || !body.value.stream) return yield* http
    if (internalHeaders[TITLE_HEADER] === "true") return yield* http

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) return yield* http
    const key = `${sessionID}:conversation`

    const now = yield* Clock.currentTimeMillis
    const entry = MutableHashMap.get(pool, key).pipe(
      Option.getOrElse(
        (): PoolEntry => ({
          socket: Option.none(),
          connectedAt: Option.none(),
          lastUsedAt: now,
          busy: false,
          fallback: false,
          streamFailures: 0,
        }),
      ),
    )
    MutableHashMap.set(pool, key, entry)

    if (entry.fallback) return yield* http
    if (entry.busy) return yield* http

    entry.busy = true
    entry.lastUsedAt = now
    const signal = init.signal ? { signal: init.signal } : {}

    return yield* Effect.gen(function* () {
      const socket = yield* connect(
        entry,
        options?.url ?? url,
        OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
        connectTimeout,
        maxConnectionAge,
        signal,
      )
      entry.socket = Option.some(socket)
      const firstEvent = yield* Deferred.make<boolean | OpenAIWebSocket.WrappedError, Error>()
      const response = yield* Effect.try({
        try: () =>
          OpenAIWebSocket.streamResponsesWebSocket({
            socket,
            body: body.value,
            idleTimeout,
            ...signal,
            onFirstEvent: (error) => Deferred.doneUnsafe(firstEvent, Effect.succeed(error ?? true)),
            onTerminal: (event) => {
              entry.busy = false
              entry.lastUsedAt = nowMillis()
              entry.streamFailures = 0
              if (event.type !== "response.completed" && event.type !== "response.done") {
                invalidate(entry)
              }
            },
            onConnectionInvalid: (_error, closeCode) => {
              entry.busy = false
              entry.lastUsedAt = nowMillis()
              if (closeCode === OpenAIWebSocket.MESSAGE_TOO_BIG_CLOSE_CODE) entry.fallback = true
              else if (!entry.fallback) recordStreamFailure(entry)
              invalidate(entry)
              Deferred.doneUnsafe(firstEvent, Effect.succeed(false))
            },
            onAbort: (error) => {
              entry.busy = false
              entry.lastUsedAt = nowMillis()
              entry.streamFailures = 0
              invalidate(entry)
              Deferred.doneUnsafe(firstEvent, Effect.fail(error))
            },
            onRetryableTerminal: (event) =>
              Option.match(connectionLimitError(event), {
                onNone: () => Effect.succeed(Option.none<OpenAIWebSocket.ResponsesSocket>()),
                onSome: (error) => Effect.fail(error),
              }),
          }),
        catch: (cause) => new ProviderError.ResponseStreamError(errorMessage(cause), { cause }),
      })
      const first = yield* Deferred.await(firstEvent)
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      if (!entry.fallback) return response
      return yield* http
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          entry.busy = false
          entry.lastUsedAt = yield* Clock.currentTimeMillis
          if (OpenAIWebSocket.isAbortError(error)) {
            entry.streamFailures = 0
            invalidate(entry)
            return yield* Effect.fail(error)
          }

          recordStreamFailure(entry)
          invalidate(entry)
          if (entry.fallback) return yield* http
          return failedResponse(new ProviderError.ResponseStreamError(error.message, { cause: error }))
        }),
      ),
    )
  })

  // The AI SDK calls this with the fetch signature and inspects its rejections.
  function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return Effect.runPromise(fetchEffect(input, init))
  }

  function recordStreamFailure(entry: PoolEntry) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > streamRetries) entry.fallback = true
  }

  function prune() {
    const now = nowMillis()
    const stale = Array.from(pool).filter(
      ([, entry]) => !entry.busy && !entry.fallback && now - entry.lastUsedAt >= idleTimeout,
    )
    for (const [key, entry] of stale) {
      invalidate(entry)
      MutableHashMap.remove(pool, key)
    }
  }

  function close() {
    // eslint-disable-next-line effect/no-set-timeout-use-schedule -- (a) stops the unref'd Node prune timer created above
    clearInterval(pruneTimer)
    for (const entry of MutableHashMap.values(pool)) invalidate(entry)
    MutableHashMap.clear(pool)
  }

  function remove(sessionID: string) {
    const key = `${sessionID}:conversation`
    const entry = MutableHashMap.get(pool, key)
    if (Option.isNone(entry)) return
    invalidate(entry.value)
    MutableHashMap.remove(pool, key)
  }

  return Object.assign(websocketFetch, { close, remove })
}

function connectionLimitError(event: Record<string, unknown>) {
  if (event.type !== "error" || !isRecord(event.error) || event.error.code !== CONNECTION_LIMIT_REACHED_CODE) {
    return Option.none()
  }
  return Option.some(
    new ConnectionLimitError({
      message: typeof event.error.message === "string" ? event.error.message : CONNECTION_LIMIT_REACHED_CODE,
    }),
  )
}

function failedResponse(error: ProviderError.ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

const connect = Effect.fn("OpenAIWebSocketPool.connect")(function* (
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal: { signal?: AbortSignal },
) {
  const now = yield* Clock.currentTimeMillis
  const reusable = entry.socket.pipe(
    Option.filter((socket) => socket.readyState === WebSocket.OPEN),
    Option.filter(() => Option.exists(entry.connectedAt, (connectedAt) => now - connectedAt < maxConnectionAge)),
  )
  if (Option.isSome(reusable)) return reusable.value

  invalidate(entry)
  const next = yield* OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    ...signal,
  })
  entry.connectedAt = Option.some(yield* Clock.currentTimeMillis)
  return next
})

function invalidate(entry: PoolEntry) {
  if (Option.isSome(entry.socket)) {
    entry.socket.value.on("error", () => {})
    entry.socket.value.terminate()
    entry.socket = Option.none()
  }
  entry.connectedAt = Option.none()
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return { ...init, headers: init.headers.filter((item) => item[0].toLowerCase() !== TITLE_HEADER) }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => key.toLowerCase() !== TITLE_HEADER)),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"

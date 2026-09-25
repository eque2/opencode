import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { authTokenFromCredentials, createSdkForServer } from "./server"
import { ClientError, OpenCode } from "@opencode-ai/client"
import { DateTime, Effect, MutableHashMap, Option, Schema } from "effect"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type ServerHealth = { healthy: boolean; version?: string }

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
// state is per check. A check marks only its own state as done, so it never touches a newer entry.
type CachedHealth = {
  readonly state: { at: number; done: boolean }
  readonly fetch: typeof globalThis.fetch
  readonly promise: Promise<ServerHealth>
}
const healthCache = MutableHashMap.empty<string, CachedHealth>()

const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe())

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

const unhealthy: ServerHealth = { healthy: false }

// Both health endpoints answer with this shape. The version is optional on the current endpoint.
const HealthResponse = Schema.Struct({ healthy: Schema.Boolean, version: Schema.optional(Schema.String) }).annotate({
  identifier: "ServerHealth.Response",
})
const decodeHealth = Schema.decodeUnknownOption(HealthResponse)

// Aborts after timeoutMs. It uses AbortSignal.timeout, and falls back to a controller that a
// child fiber aborts when the platform has no AbortSignal.timeout. The child fiber stops with
// the health check, as the old clearTimeout did.
const timeoutSignal = (timeoutMs: number) =>
  Effect.try(() => AbortSignal.timeout(timeoutMs)).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const controller = new AbortController()
        yield* Effect.sleep(timeoutMs).pipe(Effect.andThen(Effect.sync(() => controller.abort())), Effect.forkChild)
        return controller.signal
      }),
    ),
  )

// Completes when the signal aborts.
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    const onAbort = () => resume(Effect.void)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

// Sleeps for ms. It succeeds with false when the signal aborts first.
const wait = (ms: number, signal: AbortSignal) =>
  Effect.raceFirst(Effect.sleep(ms).pipe(Effect.as(true)), aborted(signal).pipe(Effect.as(false)))

function retryable(error: unknown, signal: AbortSignal) {
  if (signal.aborted) return false
  if (error instanceof ClientError) return error.reason === "Transport"
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

const checkServerHealthEffect = (
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
) =>
  Effect.gen(function* () {
    const signal = opts?.signal ?? (yield* timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs))
    const retryCount = opts?.retryCount ?? defaultRetryCount
    const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs

    const retry = (count: number, error: unknown): Effect.Effect<ServerHealth> => {
      if (count >= retryCount || !retryable(error, signal)) return Effect.succeed(unhealthy)
      return wait(retryDelayMs * (count + 1), signal).pipe(
        Effect.flatMap((slept) => (slept ? attempt(count + 1) : Effect.succeed(unhealthy))),
        // A retry that throws reads as unhealthy, as the old promise chain caught it.
        Effect.catchDefect(() => Effect.succeed(unhealthy)),
      )
    }

    const attempt = (count: number): Effect.Effect<ServerHealth> =>
      Effect.gen(function* () {
        const client = OpenCode.make({
          baseUrl: server.url,
          fetch,
          ...(server.password
            ? {
                headers: {
                  Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
                },
              }
            : {}),
        })
        // A failed request or an invalid body falls back to the V1 endpoint.
        const current = yield* Effect.tryPromise(() => client.health.get({ signal })).pipe(
          Effect.map((response) => decodeHealth(response)),
          Effect.orElseSucceed(() => Option.none<ServerHealth>()),
        )
        if (Option.isSome(current)) return current.value
        if (signal.aborted) return unhealthy

        const sdk = createSdkForServer({ server, fetch, signal })
        return yield* Effect.tryPromise({ try: () => sdk.global.health(), catch: (error) => error }).pipe(
          Effect.flatMap((response) =>
            response.error
              ? Effect.fail(response.error)
              : Effect.succeed(Option.getOrElse(decodeHealth(response.data), () => unhealthy)),
          ),
          Effect.catch((error) => retry(count, error)),
        )
      })

    return yield* attempt(0)
  })

export function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  return Effect.runPromise(checkServerHealthEffect(server, fetch, opts))
}

const pollMs = 10_000

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase): Promise<ServerHealth> => {
    const key = cacheKey(http)
    const now = nowMillis()
    const hit = MutableHashMap.get(healthCache, key).pipe(
      Option.filter((entry) => entry.fetch === fetcher && (!entry.state.done || now - entry.state.at < cacheMs)),
    )
    if (Option.isSome(hit)) return hit.value.promise
    const state = { at: now, done: false }
    const promise = Effect.runPromise(
      checkServerHealthEffect(http, fetcher).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            state.done = true
            state.at = nowMillis()
          }),
        ),
      ),
    )
    MutableHashMap.set(healthCache, key, { state, fetch: fetcher, promise })
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          const key = ServerConnection.key(conn)
          const result = await checkServerHealth(conn.http)
          results[key] = result
          if (!dead) setStatus(key, result)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}

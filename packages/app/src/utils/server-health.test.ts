import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ServerConnection } from "@/context/server"
import { checkServerHealth } from "./server-health"

const server: ServerConnection.HttpBase = {
  url: "http://localhost:4096",
}

// A stand-in fetch. It also carries Bun's preconnect helper, so it is a full typeof fetch.
const mockFetch = (run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

function abortFromInput(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.signal) return init.signal
  if (input instanceof Request) return input.signal
  return undefined
}

describe("checkServerHealth", () => {
  test("returns healthy response with version", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let request: URL | undefined
        const fetch = mockFetch((input) =>
          Effect.runPromise(
            Effect.sync(() => {
              request = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
              return Response.json({ healthy: true, version: "1.2.3" })
            }),
          ),
        )

        const result = yield* Effect.promise(() => checkServerHealth(server, fetch))

        expect(result).toEqual({ healthy: true, version: "1.2.3" })
        expect(request?.pathname).toBe("/api/health")
      }),
    ))

  test("falls back to the V1 health endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let paths: string[] = []
        const fetch = mockFetch((input) =>
          Effect.runPromise(
            Effect.sync(() => {
              const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
              paths = [...paths, url.pathname]
              if (url.pathname === "/api/health") return new Response("", { status: 404 })
              return Response.json({ healthy: true, version: "1.18.4" })
            }),
          ),
        )

        expect(yield* Effect.promise(() => checkServerHealth(server, fetch))).toEqual({
          healthy: true,
          version: "1.18.4",
        })
        expect(paths).toEqual(["/api/health", "/global/health"])
      }),
    ))

  test("falls back when the current health response is malformed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let paths: string[] = []
        const fetch = mockFetch((input) =>
          Effect.runPromise(
            Effect.sync(() => {
              const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input)
              paths = [...paths, url.pathname]
              if (url.pathname === "/api/health") return Response.json({})
              return Response.json({ healthy: true, version: "1.18.4" })
            }),
          ),
        )

        expect(yield* Effect.promise(() => checkServerHealth(server, fetch))).toEqual({
          healthy: true,
          version: "1.18.4",
        })
        expect(paths).toEqual(["/api/health", "/global/health"])
      }),
    ))

  test("allows slow servers thirty seconds by default", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
        let timeoutMs = 0
        Object.defineProperty(AbortSignal, "timeout", {
          configurable: true,
          value: (ms: number) => {
            timeoutMs = ms
            return new AbortController().signal
          },
        })

        const fetch = mockFetch(() =>
          Effect.runPromise(Effect.sync(() => Response.json({ healthy: true, version: "1.2.3" }))),
        )

        yield* Effect.promise(() => checkServerHealth(server, fetch)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
              if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
            }),
          ),
        )

        expect(timeoutMs).toBe(30_000)
      }),
    ))

  test("returns unhealthy when request fails", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // A fetch that rejects, as a network failure does.
        const fetch = mockFetch(() => Effect.runPromise(Effect.die(new Error("network"))))

        const result = yield* Effect.promise(() => checkServerHealth(server, fetch))

        expect(result).toEqual({ healthy: false })
      }),
    ))

  test("uses timeout fallback when AbortSignal.timeout is unavailable", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
        Object.defineProperty(AbortSignal, "timeout", {
          configurable: true,
          // eslint-disable-next-line effect/no-undefined-use-option -- Object.defineProperty must shadow the platform AbortSignal.timeout with undefined; the test models a runtime without that API, and the static can be inherited, so deleting it does not remove it
          value: undefined,
        })

        let aborted = false
        // A fetch that never answers and rejects when its signal aborts.
        const fetch = mockFetch((input, init) =>
          Effect.runPromise(
            Effect.callback<Response, DOMException>((resume) => {
              const signal = abortFromInput(input, init)
              signal?.addEventListener(
                "abort",
                () => {
                  aborted = true
                  resume(Effect.fail(new DOMException("Aborted", "AbortError")))
                },
                { once: true },
              )
            }),
          ),
        )

        const result = yield* Effect.promise(() =>
          checkServerHealth(server, fetch, {
            timeoutMs: 10,
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
              if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
            }),
          ),
        )

        expect(aborted).toBe(true)
        expect(result).toEqual({ healthy: false })
      }),
    ))

  test("uses provided abort signal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let signal: AbortSignal | undefined
        const fetch = mockFetch((input, init) =>
          Effect.runPromise(
            Effect.sync(() => {
              signal = abortFromInput(input, init)
              return Response.json({ healthy: true, version: "1.2.3" })
            }),
          ),
        )

        const abort = new AbortController()
        yield* Effect.promise(() =>
          checkServerHealth(server, fetch, {
            signal: abort.signal,
          }),
        )

        expect(signal).toBe(abort.signal)
      }),
    ))

  test("retries transient failures and eventually succeeds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let count = 0
        const fetch = mockFetch(() =>
          Effect.runPromise(
            Effect.suspend(() => {
              count += 1
              if (count < 3) return Effect.die(new TypeError("network"))
              return Effect.succeed(Response.json({ healthy: true, version: "1.2.3" }))
            }),
          ),
        )

        const result = yield* Effect.promise(() =>
          checkServerHealth(server, fetch, {
            retryCount: 2,
            retryDelayMs: 1,
          }),
        )

        expect(count).toBe(3)
        expect(result).toEqual({ healthy: true, version: "1.2.3" })
      }),
    ))

  test("returns unhealthy when retries are exhausted", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let count = 0
        const fetch = mockFetch(() =>
          Effect.runPromise(
            Effect.suspend(() => {
              count += 1
              return Effect.die(new TypeError("network"))
            }),
          ),
        )

        const result = yield* Effect.promise(() =>
          checkServerHealth(server, fetch, {
            retryCount: 2,
            retryDelayMs: 1,
          }),
        )

        expect(count).toBe(6)
        expect(result).toEqual({ healthy: false })
      }),
    ))
})

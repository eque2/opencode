import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { detectServerProtocol } from "./server-protocol"

const server = { url: "http://localhost:4096" }
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
// The stand-in fetch settles like the real one, so each answer is a resolved Promise.
const json = (value: unknown, status = 200) =>
  Effect.runPromise(
    Effect.succeed(new Response(encodeJson(value), { status, headers: { "content-type": "application/json" } })),
  )
const mockFetch = (run: (input: string | URL | Request) => Promise<Response>) =>
  Object.assign(run, { preconnect: globalThis.fetch.preconnect })

describe("detectServerProtocol", () => {
  test("prefers the legacy health endpoint when both API generations exist", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetcher = mockFetch((input) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname
          if (path === "/global/health") return json({ healthy: true, version: "1.18.4" })
          return json({ healthy: true, version: "2.0.0", pid: 123 })
        })

        expect(yield* detectServerProtocol(server, fetcher)).toBe("v1")
      }),
    ))

  test("recognizes V2 health by its process identifier", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetcher = mockFetch((input) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname
          if (path === "/global/health") return json({}, 404)
          return json({ healthy: true, version: "2.0.0", pid: 123 })
        })

        expect(yield* detectServerProtocol(server, fetcher)).toBe("v2")
      }),
    ))

  test("recognizes the transitional V1 API health response", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetcher = mockFetch((input) => {
          const path = new URL(input instanceof Request ? input.url : input).pathname
          if (path === "/global/health") return json({}, 404)
          return json({ healthy: true })
        })

        expect(yield* detectServerProtocol(server, fetcher)).toBe("v1")
      }),
    ))
})

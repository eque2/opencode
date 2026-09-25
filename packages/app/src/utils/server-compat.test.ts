import { describe, expect, test } from "bun:test"
import { Chunk, Effect } from "effect"
import { createApiForServer, createSdkForServer } from "./server"
import { createCompatibleApi } from "./server-compat"

/** A 204 response. The Response constructor takes null for an absent body. */
const noContent = () =>
  // eslint-disable-next-line effect/no-null-use-option -- the Fetch Response constructor requires a null body for status 204; any other body throws a TypeError
  new Response(null, { status: 204 })

function setup(
  protocol: "v1" | "v2" | Promise<"v1" | "v2">,
  responses?: { vcs?: { branch: string; default_branch: string } },
) {
  let recorded = Chunk.empty<Request>()
  const fetcher = Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      Effect.runPromise(
        Effect.sync(() => {
          const request = new Request(input, init)
          recorded = Chunk.append(recorded, request)
          if (request.method === "PATCH") {
            return Response.json({
              id: "ses_1",
              slug: "ses_1",
              projectID: "project",
              directory: "/repo",
              title: "Session",
              version: "1",
              time: { created: 1, updated: 1 },
            })
          }
          if (request.method === "POST" && request.url.endsWith("/prompt_async")) return noContent()
          if (request.method === "POST" && request.url.endsWith("/prompt")) {
            return Response.json({
              admittedSeq: 1,
              id: "msg_1",
              sessionID: "ses_1",
              timeCreated: 1,
              type: "user",
              data: { text: "hello" },
              delivery: "steer",
            })
          }
          if (request.method === "GET" && new URL(request.url).pathname === "/vcs")
            return Response.json(responses?.vcs ?? {})
          if (request.method === "GET") return Response.json([])
          return noContent()
        }),
      ),
    { preconnect: globalThis.fetch.preconnect },
  )
  const server = { url: "http://localhost:4096" }
  const api = createCompatibleApi({
    protocol: typeof protocol === "string" ? Effect.runPromise(Effect.succeed(protocol)) : protocol,
    current: createApiForServer({ server, fetch: fetcher }),
    legacy: (directory) => createSdkForServer({ server, fetch: fetcher, directory, throwOnError: true }),
    directory: "/repo",
  })
  return { api, sent: () => Chunk.toReadonlyArray(recorded) }
}

describe("createCompatibleApi", () => {
  /*
  test("routes V1 archive through the legacy session update", async () => {
    const { api, requests } = setup("v1")
    await api.session.archive({ sessionID: "ses_1", directory: "/repo" })

    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/session/ses_1")
    expect(requests[0]!.headers.get("x-opencode-directory")).toBe("%2Frepo")
    expect(requests[0]!.method).toBe("PATCH")
    expect(await requests[0]!.json()).toMatchObject({ time: { archived: expect.any(Number) } })
  })
  */

  test("converts current prompts to the V1 prompt contract", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")
        yield* Effect.promise(() =>
          api.session.prompt({
            sessionID: "ses_1",
            id: "msg_1",
            text: "hello @src/index.ts",
            agent: "build",
            model: { providerID: "provider", modelID: "model" },
            files: [
              {
                uri: "file:///repo/src/index.ts",
                name: "index.ts",
                mention: { text: "@src/index.ts", start: 6, end: 19 },
              },
              { uri: "data:text/plain;base64,aGVsbG8=", name: "notes.txt" },
            ],
          }),
        )

        const requests = sent()
        expect(new URL(requests[0].url).pathname).toBe("/session/ses_1/prompt_async")
        const body = yield* Effect.promise(() => requests[0].json())
        expect(body).toMatchObject({
          messageID: "msg_1",
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
          parts: [
            { type: "text", text: "hello @src/index.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: "file:///repo/src/index.ts",
              filename: "index.ts",
              source: {
                type: "file",
                text: { value: "@src/index.ts", start: 6, end: 19 },
                path: "file:///repo/src/index.ts",
              },
            },
            {
              type: "file",
              mime: "text/plain",
              url: "data:text/plain;base64,aGVsbG8=",
              filename: "notes.txt",
            },
          ],
        })
        expect(body.parts[2]).not.toHaveProperty("source")
      }),
    ))

  test("preserves original parts for V1 optimistic reconciliation", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")
        yield* Effect.promise(() =>
          api.session.prompt({
            sessionID: "ses_1",
            id: "msg_1",
            text: "look",
            files: [{ uri: "data:image/png;base64,AAAA", name: "image.png" }],
            legacyParts: [
              { id: "prt_text", type: "text", text: "look" },
              {
                id: "prt_image",
                type: "file",
                mime: "image/png",
                url: "data:image/png;base64,AAAA",
                filename: "image.png",
              },
            ],
          }),
        )

        const requests = sent()
        const body = yield* Effect.promise(() => requests[0].json())
        expect(body.parts).toEqual([
          { id: "prt_text", type: "text", text: "look" },
          {
            id: "prt_image",
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,AAAA",
            filename: "image.png",
          },
        ])
      }),
    ))

  test("resolves protocol detection once across implementation methods", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let detections = 0
        const resolved = Effect.runPromise(Effect.succeed<"v1" | "v2">("v2"))
        const protocol = new Proxy(resolved, {
          get(target, property) {
            if (property !== "then") return Reflect.get(target, property, target)
            detections++
            return target.then.bind(target)
          },
        })
        const { api } = setup(protocol)

        yield* Effect.promise(() => api.session.list())
        yield* Effect.promise(() => api.session.list())

        expect(detections).toBe(1)
      }),
    ))

  /*
  test("keeps V2 session actions on the current API", async () => {
    const { api, requests } = setup("v2")
    await api.session.archive({ sessionID: "ses_1" })

    expect(new URL(requests[0]!.url).pathname).toBe("/api/session/ses_1/archive")
    expect(requests[0]!.method).toBe("POST")
  })
  */

  test("uses the global V1 session search endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")
        yield* Effect.promise(() =>
          api.session.list({
            // eslint-disable-next-line effect/no-null-use-option -- @opencode-ai/client session.list reads parentID null as the root-session filter; no other field selects roots.
            parentID: null,
            search: "session",
            limit: 50,
          }),
        )

        const requests = sent()
        expect(new URL(requests[0].url).pathname).toBe("/experimental/session")
      }),
    ))

  /*
  test("projects the V1 default branch", async () => {
    const { api } = setup("v1", { vcs: { branch: "feature", default_branch: "dev" } })

    expect(await api.vcs.get({ location: { directory: "/repo" } })).toMatchObject({
      data: { branch: "feature", defaultBranch: "dev" },
    })
  })
  */

  test("translates current file searches to the V1 dirs parameter", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")
        yield* Effect.promise(() =>
          api.file.find({ location: { directory: "/repo" }, query: "src", type: "file", limit: 20 }),
        )

        const requests = sent()
        const url = new URL(requests[0].url)
        expect(url.pathname).toBe("/find/file")
        expect(url.searchParams.get("dirs")).toBe("false")
        expect(url.searchParams.get("limit")).toBe("20")
      }),
    ))

  test("routes V1 permission replies through the requested directory", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")
        yield* Effect.promise(() =>
          api.permission.reply({
            sessionID: "ses_1",
            requestID: "permission_1",
            reply: "once",
            location: { directory: "/other" },
          }),
        )

        const requests = sent()
        expect(new URL(requests[0].url).pathname).toBe("/session/ses_1/permissions/permission_1")
        expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/other")
      }),
    ))

  test("disposes the V1 instance after connecting a provider", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")

        yield* Effect.promise(() =>
          api.integration.connect.key({
            integrationID: "openrouter",
            key: "secret",
            location: { directory: "/repo" },
          }),
        )

        const requests = sent()
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
          "/auth/openrouter",
          "/instance/dispose",
          "/instance/dispose",
        ])
        expect(requests[1].headers.get("x-opencode-directory")).toBe("%2Frepo")
        expect(requests[2].headers.get("x-opencode-directory")).toBeNull()
      }),
    ))

  test("disposes the V1 instance after completing provider OAuth", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { api, sent } = setup("v1")

        yield* Effect.promise(() =>
          api.integration.oauth.complete({
            integrationID: "openrouter",
            attemptID: "openrouter:0",
            code: "code",
            location: { directory: "/repo" },
          }),
        )

        const requests = sent()
        expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
          "/provider/openrouter/oauth/callback",
          "/instance/dispose",
          "/instance/dispose",
        ])
        expect(requests[1].headers.get("x-opencode-directory")).toBe("%2Frepo")
        expect(requests[2].headers.get("x-opencode-directory")).toBeNull()
      }),
    ))
})

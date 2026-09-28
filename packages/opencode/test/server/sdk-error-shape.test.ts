/**
 * Regression tests for the SDK error shape — the v2 SDK's `throwOnError: true`
 * path used to throw raw values (empty strings or POJOs from JSON-decoded
 * error bodies). The TUI catches those and `e.message`/`e.stack` are
 * undefined, so users see `[object Object]` or a blank crash.
 *
 * Both cases must throw a real `Error` instance with a non-empty `.message`
 * extracted from the response body, plus `.status` and `.body` attached.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { Schema } from "effect"

// The SDK attaches the HTTP status and the decoded error body as the Error cause.
const ErrorCause = Schema.Struct({ status: Schema.Number, body: Schema.Unknown })
const decodeCause = Schema.decodeUnknownSync(ErrorCause)
const decodeBodyMessage = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ message: Schema.String }) }))

function expectError(caught: unknown): Error {
  expect(caught).toBeInstanceOf(Error)
  if (caught instanceof Error) return caught
  throw new Error("the SDK did not throw an Error")
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function client(directory: string) {
  return createOpencodeClient({
    baseUrl: "http://test",
    directory,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        Server.Default().app.fetch(input instanceof Request ? input : new Request(input, init)),
      { preconnect: globalThis.fetch.preconnect },
    ) satisfies typeof globalThis.fetch,
  })
}

describe("v2 SDK error shape", () => {
  test("404 with NamedError body throws a real Error carrying the server message", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path)

    let caught: unknown
    try {
      await sdk.session.get({ sessionID: "ses_no_such" }, { throwOnError: true })
    } catch (e) {
      caught = e
    }

    const err = expectError(caught)
    const cause = decodeCause(err.cause)
    expect(err.message).toContain("Session not found")
    expect(cause.status).toBe(404)
    expect(cause.body).toMatchObject({
      name: "NotFoundError",
      data: { message: expect.stringContaining("Session not found") },
    })
  })

  test("400 schema rejection: SDK extracts the field-level reason from the NamedError body", async () => {
    // Canary for the #26631 wire shape. Asserts the contract end-to-end:
    // server emits {name:"BadRequest", data:{message, kind}}, SDK's
    // wrapClientError extracts .data.message into Error.message. If either
    // side regresses (#26457 reverted because both layers were missing),
    // this test fails before users see (empty response body).
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const sdk = client(tmp.path)

    let caught: unknown
    try {
      await sdk.sync.history.list({ body: { aggregate: -1 } }, { throwOnError: true })
    } catch (e) {
      caught = e
    }

    const err = expectError(caught)
    const cause = decodeCause(err.cause)
    expect(cause.status).toBe(400)
    expect(cause.body).toMatchObject({
      name: "BadRequest",
      data: { kind: expect.stringMatching(/^(Body|Payload)$/) },
    })
    const message = decodeBodyMessage(cause.body).data.message
    expect(typeof message).toBe("string")
    expect(message.length).toBeGreaterThan(0)
    // Whatever the server put in data.message must be what the user sees.
    expect(err.message).toBe(message)
  })
})

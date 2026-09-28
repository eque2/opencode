import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Option, Redacted } from "effect"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
}

function setEnv(key: keyof typeof original, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  setEnv("OPENCODE_SERVER_PASSWORD", original.OPENCODE_SERVER_PASSWORD)
  setEnv("OPENCODE_SERVER_USERNAME", original.OPENCODE_SERVER_USERNAME)
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", async () => {
    setEnv("OPENCODE_SERVER_PASSWORD", undefined)
    setEnv("OPENCODE_SERVER_USERNAME", "alice")

    expect(await Effect.runPromise(ServerAuth.header())).toBeUndefined()
    expect(await Effect.runPromise(ServerAuth.headers())).toBeUndefined()
  })

  test("defaults to the opencode username", async () => {
    setEnv("OPENCODE_SERVER_PASSWORD", "secret")
    setEnv("OPENCODE_SERVER_USERNAME", undefined)

    expect(await Effect.runPromise(ServerAuth.headers())).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", async () => {
    setEnv("OPENCODE_SERVER_PASSWORD", "secret")
    setEnv("OPENCODE_SERVER_USERNAME", "alice")

    expect(await Effect.runPromise(ServerAuth.headers())).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", async () => {
    setEnv("OPENCODE_SERVER_PASSWORD", "secret")
    setEnv("OPENCODE_SERVER_USERNAME", "alice")

    expect(await Effect.runPromise(ServerAuth.headers({ password: "cli-secret", username: "bob" }))).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })
})

// ATDD red phase for _bmad-output/goals/datadog-log-sink.goal/spec/story.md.
// Each leaf maps to exactly one AC. Remove `test.skip` (and any `@ts-expect-error`) when its AC lands.
import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { ConfigProvider, Effect, Layer, Logger, ManagedRuntime, References, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Datadog } from "../../src/observability/datadog"
import { fileLogger } from "../../src/observability/logging"
import { ConfigV1 } from "../../src/v1/config/config"

type Received = { at: number; encoding: string | null; body: Array<Record<string, any>> }

// Replies with the queued statuses in order, then 202.
function intake(statuses: Array<{ status: number; headers?: Record<string, string> }> = []) {
  const requests: Array<Received> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const raw = new Uint8Array(await request.arrayBuffer())
      const encoding = request.headers.get("content-encoding")
      const text = new TextDecoder().decode(encoding === "gzip" ? Bun.gunzipSync(raw) : raw)
      requests.push({ at: Date.now(), encoding, body: JSON.parse(text) })
      const next = statuses.shift() ?? { status: 202 }
      return new Response(null, next)
    },
  })
  return { requests, server, url: server.url.href }
}

const settings = (env: Record<string, string>) =>
  Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))), Effect.runPromise)

const required = (value: Datadog.Settings | undefined) => {
  if (!value) throw new Error("expected Datadog settings")
  return value
}

const ship = (config: Datadog.Settings, program: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const logger = yield* Datadog.logger(config)
    yield* program.pipe(Effect.provide(Logger.layer([logger])))
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)

const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await Bun.sleep(25)
}

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-datadog-atdd-"))
  return { dir, [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }) }
}

test.skip("AC-1 a global config file configures the sink and env overrides it", async () => {
  await using temp = await tempDir()
  await Bun.write(
    path.join(temp.dir, "opencode.jsonc"),
    `{ // JSONC comments are allowed\n "observability": { "datadog": { "categories": "llm", "content": "hash" } } }`,
  )
  const resolve = async (env: Record<string, string>): Promise<Datadog.Settings | undefined> =>
    Effect.runPromise(
      // @ts-expect-error AC-1 red phase: Datadog.provider lands in stage 3.
      Datadog.provider({ env, configDir: temp.dir }).pipe(
        Effect.flatMap((provider: ConfigProvider.ConfigProvider) =>
          Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider))),
        ),
      ),
    )
  const fromFile = required(await resolve({ DD_API_KEY: "key" }))
  expect(fromFile.categories).toBe("llm")
  const overridden = required(await resolve({ DD_API_KEY: "key", OPENCODE_DATADOG_CATEGORIES: "tool" }))
  expect(overridden.categories).toBe("tool")
  expect(overridden.content).toBe("hash")
})

test.skip("AC-2 an apiKey in a config file never enables the sink", async () => {
  await using temp = await tempDir()
  await Bun.write(
    path.join(temp.dir, "opencode.json"),
    JSON.stringify({ observability: { datadog: { apiKey: "from-file" } } }),
  )
  const resolved = await Effect.runPromise(
    // @ts-expect-error AC-2 red phase: Datadog.provider lands in stage 3.
    Datadog.provider({ env: {}, configDir: temp.dir }).pipe(
      Effect.flatMap((provider: ConfigProvider.ConfigProvider) =>
        Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider))),
      ),
    ),
  )
  expect(resolved).toBeUndefined()
  const decoded = Schema.decodeUnknownExit(ConfigV1.Info)(
    { observability: { datadog: { apiKey: "from-file" } } },
    { onExcessProperty: "error" },
  )
  expect(decoded._tag).toBe("Failure")
})

test.skip("AC-3 LogPolicy content full ships content only inside its scope", async () => {
  const target = intake()
  await using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  await ship(
    config,
    Effect.gen(function* () {
      yield* Effect.logInfo("scoped", { prompt: "visible prompt" }).pipe(
        Effect.annotateLogs({ category: "llm.request" }),
        // @ts-expect-error AC-3 red phase: Datadog.LogPolicy lands in stage 3.
        Effect.provideService(Datadog.LogPolicy, { content: "full" }),
      )
      yield* Effect.logInfo("outside", { prompt: "hidden prompt" }).pipe(
        Effect.annotateLogs({ category: "llm.request" }),
      )
    }),
  )
  const [scoped, outside] = target.requests[0].body
  expect(scoped.prompt).toBe("visible prompt")
  expect(outside.prompt).toMatch(/^\[OMITTED/)
})

test.skip("AC-4 a Debug record reaches Datadog but not an Info file log", async () => {
  await using temp = await tempDir()
  const file = path.join(temp.dir, "opencode.log")
  const target = intake()
  await using _ = target.server
  const config = required(
    await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_LOG_LEVEL: "Debug" }),
  )
  await Effect.gen(function* () {
    const datadog = yield* Datadog.logger(config)
    yield* Effect.logDebug("debug only").pipe(
      Effect.annotateLogs({ category: "llm.request" }),
      Effect.provide(
        // @ts-expect-error AC-4 red phase: fileLogger gains a level argument in stage 3.
        Logger.layer([fileLogger(file, "run-a", "Info"), datadog]).pipe(
          Layer.provide(NodeFileSystem.layer),
          Layer.orDie,
        ),
      ),
    )
  }).pipe(
    Effect.provideService(References.MinimumLogLevel, "Debug"),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
    Effect.runPromise,
  )
  const text = await Bun.file(file)
    .text()
    .catch(() => "")
  expect(text).not.toContain("debug only")
  expect(target.requests[0].body[0].message).toBe("debug only")
})

test.skip("AC-5 a 429 with Retry-After 1 delays the next attempt by at least one second", async () => {
  const target = intake([{ status: 429, headers: { "Retry-After": "1" } }])
  await using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  await ship(config, Effect.logInfo("rate limited").pipe(Effect.annotateLogs({ category: "llm.request" })))
  expect(target.requests[1].at - target.requests[0].at).toBeGreaterThanOrEqual(950)
}, 20_000)

test.skip("AC-6 after retries fail the sink sends nothing for 60 seconds", async () => {
  const target = intake(Array.from({ length: 50 }, () => ({ status: 503 })))
  await using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "50 millis",
    }),
  )
  await ship(
    config,
    Effect.gen(function* () {
      yield* Effect.logInfo("first").pipe(Effect.annotateLogs({ category: "llm.request" }))
      yield* Effect.promise(() => until(() => target.requests.length >= 4))
      yield* Effect.sleep("300 millis")
      const failed = target.requests.length
      yield* Effect.logInfo("second").pipe(Effect.annotateLogs({ category: "llm.request" }))
      yield* Effect.sleep("500 millis")
      expect(target.requests.length).toBe(failed)
    }),
  )
}, 20_000)

test.skip("AC-7 every request is gzip-compressed", async () => {
  const target = intake()
  await using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  await ship(config, Effect.logInfo("compressed").pipe(Effect.annotateLogs({ category: "llm.request" })))
  expect(target.requests[0].encoding).toBe("gzip")
  expect(target.requests[0].body[0].message).toBe("compressed")
})

test.skip("AC-8 disposing the runtime flushes buffered records", async () => {
  const target = intake()
  await using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour",
    }),
  )
  const runtime = ManagedRuntime.make(Logger.layer([Datadog.logger(config)]).pipe(Layer.provide(FetchHttpClient.layer)))
  await runtime.runPromise(Effect.logInfo("last words").pipe(Effect.annotateLogs({ category: "cli.exit" })))
  await runtime.dispose()
  expect(target.requests.map((request) => request.body[0].message)).toEqual(["last words"])
})

test.skip("AC-9 secret shapes inside string values never reach the intake", async () => {
  const target = intake()
  await using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  // Built at runtime so secret scanners do not flag the fixture.
  const secrets = [
    "sk-" + "a1".repeat(12),
    "AKIA" + "B2".repeat(8),
    "ghp_" + "c3".repeat(12),
    "xoxb-" + "123-456-" + "d4".repeat(6),
    "zz" + "9".repeat(14),
  ]
  await ship(
    config,
    Effect.logInfo(
      `ran ${secrets[0]} ${secrets[1]} ${secrets[2]} ${secrets[3]} https://api.test/v1?api_key=${secrets[4]}`,
    ).pipe(Effect.annotateLogs({ category: "tool.error" })),
  )
  const payload = JSON.stringify(target.requests[0].body)
  expect(secrets.filter((secret) => payload.includes(secret))).toEqual([])
})

test.skip("AC-10 question and pty records are excluded by default", async () => {
  const include = Datadog.categoryFilter(required(await settings({ DD_API_KEY: "key" })).categories)
  expect(["question.asked", "pty.write"].filter(include)).toEqual([])
  expect(include("llm.request")).toBe(true)
})

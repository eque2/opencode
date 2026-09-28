// ATDD red phase for _bmad-output/goals/datadog-log-sink.goal/spec/story.md.
// Each leaf maps to exactly one AC. Remove `test.skip` (and any `@ts-expect-error`) when its AC lands.
import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, ConfigProvider, Effect, Layer, Logger, ManagedRuntime, Option, References, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as TestClock from "effect/testing/TestClock"
import { Datadog } from "../../src/observability/datadog"
import { fileLogger } from "../../src/observability/logging"
import { ConfigV1 } from "../../src/v1/config/config"

type Received = {
  at: number
  key: string | null
  encoding: string | null
  bytes: number
  body: Array<Record<string, any>>
}

// Replies with the queued statuses in order, then 202.
function intake(statuses: Array<{ status: number; headers?: Record<string, string> }> = []) {
  const requests: Array<Received> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const raw = new Uint8Array(await request.arrayBuffer())
      const encoding = request.headers.get("content-encoding")
      const decoded = encoding === "gzip" ? Bun.gunzipSync(raw) : raw
      const body = JSON.parse(new TextDecoder().decode(decoded))
      requests.push({ at: Date.now(), key: request.headers.get("DD-API-KEY"), encoding, bytes: decoded.length, body })
      const next = statuses.shift() ?? { status: 202 }
      return new Response(null, next)
    },
  })
  return { requests, server, url: server.url.href }
}

const settings = (env: Record<string, string>) =>
  Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))), Effect.runPromise)

const required = (value: Option.Option<Datadog.Settings>) => Option.getOrThrow(value)

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
  const resolve = async (env: Record<string, string>): Promise<Option.Option<Datadog.Settings>> =>
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

test.skip("AC-2 a config-file apiKey is ignored and the env key is sent", async () => {
  await using temp = await tempDir()
  const target = intake()
  using _ = target.server
  await Bun.write(
    path.join(temp.dir, "opencode.json"),
    JSON.stringify({
      observability: { datadog: { apiKey: "from-file", api_key: "from-file", DD_API_KEY: "from-file" } },
    }),
  )
  const resolve = async (env: Record<string, string>): Promise<Option.Option<Datadog.Settings>> =>
    Effect.runPromise(
      // @ts-expect-error AC-2 red phase: Datadog.provider lands in stage 3.
      Datadog.provider({ env, configDir: temp.dir }).pipe(
        Effect.flatMap((provider: ConfigProvider.ConfigProvider) =>
          Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider))),
        ),
      ),
    )
  const config = required(await resolve({ DD_API_KEY: "env-key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  await ship(config, Effect.logInfo("keyed").pipe(Effect.annotateLogs({ category: "llm.request" })))
  expect(target.requests[0].key).toBe("env-key")
  expect(Option.isNone(await resolve({}))).toBe(true)
  // The production loader ignores excess keys, so the rest of the config still loads.
  const decoded = Schema.decodeUnknownExit(ConfigV1.Info)({
    model: "anthropic/claude",
    observability: { datadog: { apiKey: "from-file", categories: "llm" } },
  })
  expect(decoded._tag).toBe("Success")
})

test.skip("AC-3 withPolicy content full ships content only inside its scope and keeps secrets redacted", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  const secret = "sk-" + "e5".repeat(12)
  const withPolicy: (patch: {
    content?: "omit" | "hash" | "full"
    categories?: string
  }) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> =
    // @ts-expect-error AC-3 red phase: Datadog.withPolicy lands in stage 3.
    Datadog.withPolicy
  await ship(
    config,
    Effect.gen(function* () {
      yield* Effect.logInfo("scoped", {
        prompt: "visible prompt",
        apiKey: "raw-key",
        note: `Bearer abc.def ${secret}`,
      }).pipe(Effect.annotateLogs({ category: "llm.request" }), withPolicy({ content: "full" }))
      yield* Effect.logInfo("outside", { prompt: "hidden prompt" }).pipe(
        Effect.annotateLogs({ category: "llm.request" }),
      )
    }),
  )
  const [scoped, outside] = target.requests[0].body
  expect(scoped.prompt).toBe("visible prompt")
  expect(outside.prompt).toMatch(/^\[OMITTED/)
  expect(scoped.apiKey).toBe("[REDACTED]")
  expect(scoped.note).not.toContain(secret)
  expect(scoped.note).not.toContain("abc.def")
})

test.skip("AC-4 a Debug record reaches Datadog but not an Info file log", async () => {
  await using temp = await tempDir()
  const file = path.join(temp.dir, "opencode.log")
  const target = intake()
  using _ = target.server
  const config = required(
    await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_LOG_LEVEL: "Debug" }),
  )
  await Effect.gen(function* () {
    const datadog = yield* Datadog.logger(config)
    yield* Effect.all([Effect.logDebug("debug only"), Effect.logInfo("info too")]).pipe(
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
  expect(text).toContain("info too")
})

test("AC-5 a 429 with Retry-After 2 delays the next attempt by at least two seconds", async () => {
  const target = intake([{ status: 429, headers: { "Retry-After": "2" } }])
  using _ = target.server
  const config = required(
    await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_FLUSH_INTERVAL: "50 millis" }),
  )
  // The periodic flush retries; the final flush at scope close makes one attempt only.
  await ship(
    config,
    Effect.logInfo("rate limited").pipe(
      Effect.annotateLogs({ category: "llm.request" }),
      Effect.andThen(Effect.promise(() => until(() => target.requests.length >= 2))),
    ),
  )
  expect(target.requests[1].at - target.requests[0].at).toBeGreaterThanOrEqual(1900)
}, 20_000)

test.skip("AC-6 after retries fail the sink sends nothing until the cooldown ends", async () => {
  // One attempt plus 3 retries fail, then the intake recovers.
  const failures = 4
  const target = intake(Array.from({ length: failures }, () => ({ status: 503 })))
  using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "50 millis",
    }),
  )
  await Effect.gen(function* () {
    // @ts-expect-error AC-6 red phase: the cooldown option lands in stage 3.
    const logger = yield* Datadog.logger(config, { cooldown: "2 seconds" })
    const log = (message: string) =>
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({ category: "llm.request" }),
        Effect.provide(Logger.layer([logger])),
      )
    yield* log("first")
    yield* Effect.promise(() => until(() => target.requests.length >= failures))
    yield* log("second")
    yield* Effect.sleep("500 millis")
    expect(target.requests.length).toBe(failures)
    yield* Effect.sleep("2 seconds")
    yield* log("third")
    yield* Effect.promise(() => until(() => target.requests.length > failures, 3_000))
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)
  expect(target.requests.at(-1)?.body.map((entry) => entry.message)).toEqual(["third"])
}, 30_000)

test("AC-7 every request is gzip-compressed", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  await ship(config, Effect.logInfo("compressed").pipe(Effect.annotateLogs({ category: "llm.request" })))
  expect(target.requests[0].encoding).toBe("gzip")
  expect(target.requests[0].body[0].message).toBe("compressed")
})

test.skip("AC-8 disposing the runtime flushes buffered records", async () => {
  const target = intake()
  using _ = target.server
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

test("AC-9 secret shapes anywhere in a record never reach the intake and the surrounding text survives", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  // Built at runtime so secret scanners do not flag the fixture.
  const secrets = [
    "sk-" + "a1".repeat(12),
    "AKIA" + "B2".repeat(8),
    "ghp_" + "c3".repeat(12),
    "xoxb-123-456-" + "d4".repeat(6),
    "zz" + "9".repeat(14),
    "yy" + "8".repeat(14),
  ]
  const ordinary = ["task-0123456789abcdef", "risk-assessment-document", "monkey=1", "tokenizer"]
  const line = `ran ${secrets[0]} ${secrets[1]} ${secrets[2]} ${secrets[3]} https://api.test/v1?api_key=${secrets[4]}&exaApiKey=${secrets[5]}`
  await ship(
    config,
    Effect.logError(line, {
      detail: line,
      nested: { deeper: [line] },
      error: new Error(line),
      prose: ordinary.join(" "),
      inputTokens: 42,
    }).pipe(Effect.annotateLogs({ category: "tool.error" })),
  )
  const payload = JSON.stringify(target.requests[0].body)
  expect(secrets.filter((secret) => payload.includes(secret))).toEqual([])
  const [entry] = target.requests[0].body
  expect(entry.message).toStartWith("ran [REDACTED]")
  expect(entry.detail).toContain("https://api.test/v1?api_key=[REDACTED]")
  expect(entry.prose).toBe(ordinary.join(" "))
  expect(entry.inputTokens).toBe(42)
})

test("AC-10 a Question.reply-shaped record sends no answer text by default", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  // Same shape as packages/opencode/src/question/index.ts:124, which sets no category.
  await ship(config, Effect.logInfo("replied", { requestID: "que_1", answers: [["my private answer"]] }))
  expect(JSON.stringify(target.requests[0].body)).not.toContain("my private answer")
  const include = Datadog.categoryFilter(config.categories)
  expect(["question.asked", "pty.write"].filter(include)).toEqual([])
  expect(include("llm.request")).toBe(true)
})

test("AC-10b a Pty.create-shaped record sends no cmd or args text by default", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  // Same shape as packages/core/src/pty.ts:185, which sets no category.
  await ship(
    config,
    Effect.logInfo("creating session", { id: "pty_1", cmd: "private-shell", args: ["--secret-flag"], cwd: "/tmp" }),
  )
  const payload = JSON.stringify(target.requests[0].body)
  expect(payload).not.toContain("private-shell")
  expect(payload).not.toContain("--secret-flag")
  expect(target.requests[0].body[0].id).toBe("pty_1")
})

test("AC-9b secret shapes in the pretty cause are scrubbed in every content mode", async () => {
  const secret = "ghp_" + "f6".repeat(12)
  for (const content of ["omit", "hash", "full"]) {
    const target = intake()
    using _ = target.server
    const config = required(
      await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_CONTENT: content }),
    )
    await ship(
      config,
      Effect.logError("failed", Cause.fail(new Error(`upstream rejected ${secret} at step 2`))).pipe(
        Effect.annotateLogs({ category: "tool.error" }),
      ),
    )
    const [entry] = target.requests[0].body
    expect(entry.error.stack).toContain("upstream rejected [REDACTED] at step 2")
    expect(JSON.stringify(target.requests[0].body)).not.toContain(secret)
  }
})

test("AC-7b a multi-byte batch splits into gzip chunks measured in UTF-8 bytes", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  // 900,000 UTF-8 bytes but only 450,000 UTF-16 units each, so a length-based count would pack 9 MB per chunk.
  const message = "é".repeat(450_000)
  await ship(
    config,
    Effect.forEach(Array.from({ length: 12 }), () => Effect.logInfo(message), { discard: true }).pipe(
      Effect.annotateLogs({ category: "llm.request" }),
    ),
  )
  expect(target.requests.length).toBeGreaterThanOrEqual(3)
  expect(target.requests.every((request) => request.encoding === "gzip" && request.bytes < 4_500_000)).toBe(true)
  expect(target.requests.flatMap((request) => request.body).length).toBe(12)
}, 30_000)

test("AC-7b an entry above 1,000,000 bytes has its message truncated", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  await ship(config, Effect.logInfo("é".repeat(700_000)).pipe(Effect.annotateLogs({ category: "llm.request" })))
  const [entry] = target.requests[0].body
  expect(entry.message).toEndWith("[TRUNCATED]")
  expect(entry.message.startsWith("éé")).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(1_000_000)
}, 30_000)

// Sends one record that gets a 429 with the given Retry-After, under TestClock. Returns the request count after
// `before` of virtual time, then after `after` more.
async function retryGap(retryAfter: (now: number) => string, before: string, after: string) {
  const target = intake([{ status: 429, headers: { "Retry-After": retryAfter(1_000) } }])
  using _ = target.server
  const config = required(
    await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_FLUSH_INTERVAL: "1 second" }),
  )
  return await Effect.gen(function* () {
    const logger = yield* Datadog.logger(config)
    yield* Effect.logInfo("limited").pipe(
      Effect.annotateLogs({ category: "llm.request" }),
      Effect.provide(Logger.layer([logger])),
    )
    yield* TestClock.adjust("1 second")
    yield* Effect.promise(() => until(() => target.requests.length >= 1))
    // Let the client read the response and start its wait before virtual time moves.
    yield* Effect.promise(() => Bun.sleep(100))
    yield* TestClock.adjust(before)
    yield* Effect.promise(() => Bun.sleep(200))
    const early = target.requests.length
    yield* TestClock.adjust(after)
    yield* Effect.promise(() => until(() => target.requests.length >= 2, 3_000))
    return [early, target.requests.length]
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer()), Effect.provide(FetchHttpClient.layer), Effect.runPromise)
}

test("AC-5b an HTTP-date Retry-After is honoured", async () => {
  // TestClock starts at 0 and the flush runs at 1 second, so this date is a 10-second wait.
  expect(await retryGap(() => new Date(11_000).toUTCString(), "9 seconds", "1 second")).toEqual([1, 2])
})

test("AC-5b a Retry-After of 45 is capped at 30 seconds", async () => {
  expect(await retryGap(() => "45", "29500 millis", "500 millis")).toEqual([1, 2])
})

test("AC-5b a Retry-After of -1 falls back to the exponential backoff", async () => {
  expect(await retryGap(() => "-1", "400 millis", "100 millis")).toEqual([1, 2])
})

test("AC-5b 400, 401, 403 and 413 drop the batch with no retry", async () => {
  for (const status of [400, 401, 403, 413]) {
    const target = intake([{ status }])
    using _ = target.server
    const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
    await ship(config, Effect.logInfo("rejected").pipe(Effect.annotateLogs({ category: "llm.request" })))
    await Bun.sleep(700)
    expect([status, target.requests.length]).toEqual([status, 1])
  }
})

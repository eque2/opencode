// ATDD red phase for _bmad-output/goals/datadog-log-sink.goal/spec/story.md.
// Each leaf maps to exactly one AC. Remove `test.skip` (and any `@ts-expect-error`) when its AC lands.
import { expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import {
  Cause,
  ConfigProvider,
  Duration,
  Effect,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  References,
  Schema,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as TestClock from "effect/testing/TestClock"
import { Datadog } from "../../src/observability/datadog"
import { fileLogger, Logging } from "../../src/observability/logging"
import { Observability } from "../../src/observability"
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

test("AC-1 a global config file configures the sink and env overrides it", async () => {
  await using temp = await tempDir()
  await Bun.write(
    path.join(temp.dir, "opencode.jsonc"),
    `{ // JSONC comments are allowed\n "observability": { "datadog": { "categories": "llm", "content": "hash" } } }`,
  )
  const resolve = async (env: Record<string, string>): Promise<Option.Option<Datadog.Settings>> =>
    Effect.runPromise(
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

test("AC-2 a config-file apiKey is ignored and the env key is sent", async () => {
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

test("AC-3 withPolicy content full ships content only inside its scope and keeps secrets redacted", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  const secret = "sk-" + "e5".repeat(12)
  const withPolicy: (patch: {
    content?: "omit" | "hash" | "full"
    categories?: string
  }) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = Datadog.withPolicy
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

test("AC-4 a Debug record reaches Datadog but not an Info file log", async () => {
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
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "50 millis",
    }),
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

test("AC-6 after retries fail the sink sends nothing until the cooldown ends", async () => {
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

test("AC-8 disposing the runtime flushes buffered records", async () => {
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
async function retryGap(retryAfter: (now: number) => string, before: Duration.Input, after: Duration.Input) {
  const target = intake([{ status: 429, headers: { "Retry-After": retryAfter(1_000) } }])
  using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 second",
    }),
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
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestClock.layer(), FetchHttpClient.layer)), Effect.runPromise)
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

// Records the messages of Warn records, like a file sink next to Datadog.
function warnings() {
  const messages: Array<string> = []
  const logger = Logger.make((options) => {
    if (options.logLevel === "Warn") messages.push(String(options.message))
  })
  return { messages, logger }
}

test("AC-6b the default cooldown sends nothing at 59 seconds and sends again after 60 seconds", async () => {
  const target = intake(Array.from({ length: 4 }, () => ({ status: 503 })))
  using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 second",
    }),
  )
  const warned = warnings()
  const settle = () => Effect.promise(() => Bun.sleep(100))
  await Effect.gen(function* () {
    const datadog = yield* Datadog.logger(config)
    const log = (message: string) =>
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({ category: "llm.request" }),
        Effect.provide(Logger.layer([datadog, warned.logger])),
      )
    yield* log("first")
    // One attempt at 1 second, then retries after 0.5, 1 and 2 seconds of backoff.
    for (const [wait, count] of [
      ["1 second", 1],
      ["500 millis", 2],
      ["1 second", 3],
      ["2 seconds", 4],
    ] as const) {
      yield* TestClock.adjust(wait)
      yield* Effect.promise(() => until(() => target.requests.length >= count))
      yield* settle()
    }
    expect(warned.messages).toEqual(["Datadog sink disabled for 60 seconds"])
    yield* log("second")
    yield* TestClock.adjust("59 seconds")
    yield* settle()
    expect(target.requests.length).toBe(4)
    yield* TestClock.adjust("1 second")
    yield* log("third")
    yield* TestClock.adjust("1 second")
    yield* Effect.promise(() => until(() => target.requests.length >= 5))
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(TestClock.layer(), FetchHttpClient.layer)), Effect.runPromise)
  expect(target.requests.at(-1)?.body.map((entry) => entry.message)).toEqual(["third"])
  expect(warned.messages).toHaveLength(1)
  expect(JSON.stringify(target.requests.map((request) => request.body))).not.toContain("Datadog sink disabled")
}, 30_000)

test("AC-6b each off period emits one Warn, 401 opens the breaker and 413 does not", async () => {
  const target = intake([{ status: 401 }, { status: 413 }, { status: 401 }])
  using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "50 millis",
    }),
  )
  const warned = warnings()
  await Effect.gen(function* () {
    const datadog = yield* Datadog.logger(config, { cooldown: "1 second" })
    const log = (message: string) =>
      Effect.logInfo(message).pipe(
        Effect.annotateLogs({ category: "llm.request" }),
        Effect.provide(Logger.layer([datadog, warned.logger])),
      )
    yield* log("a")
    yield* Effect.promise(() => until(() => target.requests.length >= 1))
    yield* Effect.sleep("200 millis")
    yield* log("dropped while off")
    yield* Effect.sleep("300 millis")
    expect(target.requests.length).toBe(1)
    yield* Effect.sleep("700 millis")
    // The 413 drops its batch but leaves the sink on, so the next record is sent at once.
    yield* log("b")
    yield* Effect.promise(() => until(() => target.requests.length >= 2))
    yield* log("c")
    yield* Effect.promise(() => until(() => target.requests.length >= 3))
    yield* Effect.sleep("200 millis")
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.runPromise)
  expect(target.requests.map((request) => request.body.map((entry) => entry.message))).toEqual([["a"], ["b"], ["c"]])
  expect(warned.messages).toEqual(["Datadog sink disabled for 1 seconds", "Datadog sink disabled for 1 seconds"])
}, 30_000)

test("AC-6b the buffer holds at most 10,000 entries and drops the oldest first", async () => {
  const target = intake()
  using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour",
    }),
  )
  await ship(
    config,
    Effect.forEach(
      Array.from({ length: 10_005 }, (_, index) => index),
      (index) => Effect.logInfo(`record ${index}`),
      {
        discard: true,
      },
    ).pipe(Effect.annotateLogs({ category: "llm.request" })),
  )
  const messages = target.requests.flatMap((request) => request.body.map((entry) => entry.message))
  expect(messages).toHaveLength(10_000)
  expect(messages[0]).toBe("record 5")
  expect(messages.at(-1)).toBe("record 10004")
}, 30_000)

// Sets process env vars for one test, because Observability.layer reads the live process env when it builds.
async function withEnv<A>(vars: Record<string, string>, run: () => Promise<A>) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  Object.assign(process.env, vars)
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("AC-8b disposing an Observability.layer runtime flushes the Datadog buffer", async () => {
  const target = intake()
  using _ = target.server
  await withEnv(
    { DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour" },
    async () => {
      const runtime = ManagedRuntime.make(Observability.layer)
      await runtime.runPromise(
        Effect.logInfo("observability last words").pipe(Effect.annotateLogs({ category: "cli.exit" })),
      )
      await runtime.dispose()
    },
  )
  expect(target.requests.flatMap((request) => request.body.map((entry) => entry.message))).toEqual([
    "observability last words",
  ])
})

test("AC-8b disposal against a 503 or a 429 intake makes one attempt and finishes within 5 seconds", async () => {
  for (const reply of [{ status: 503 }, { status: 429, headers: { "Retry-After": "30" } }]) {
    const target = intake([reply, reply, reply, reply])
    using _ = target.server
    const config = required(
      await settings({
        DD_API_KEY: "key",
        OPENCODE_DATADOG_LOGS_URL: target.url,
        OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour",
      }),
    )
    const runtime = ManagedRuntime.make(
      Logger.layer([Datadog.logger(config)]).pipe(Layer.provide(FetchHttpClient.layer)),
    )
    await runtime.runPromise(Effect.logInfo("failing intake").pipe(Effect.annotateLogs({ category: "cli.exit" })))
    const start = Date.now()
    await runtime.dispose()
    expect(Date.now() - start).toBeLessThan(5_000)
    await Bun.sleep(700)
    expect([reply.status, target.requests.length]).toEqual([reply.status, 1])
  }
}, 20_000)

test("AC-8b disposal while the breaker is open sends nothing", async () => {
  const target = intake([{ status: 401 }])
  using _ = target.server
  const config = required(
    await settings({
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "50 millis",
    }),
  )
  const runtime = ManagedRuntime.make(Logger.layer([Datadog.logger(config)]).pipe(Layer.provide(FetchHttpClient.layer)))
  const log = (message: string) =>
    runtime.runPromise(Effect.logInfo(message).pipe(Effect.annotateLogs({ category: "cli.exit" })))
  await log("trips the breaker")
  await until(() => target.requests.length >= 1)
  await Bun.sleep(100)
  await log("buffered while off")
  await runtime.dispose()
  expect(target.requests).toHaveLength(1)
})

test("AC-3b nested withPolicy scopes merge field by field and the inner value wins", async () => {
  const target = intake()
  using _ = target.server
  const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url }))
  const log = (message: string, category: string) =>
    Effect.logInfo(message, { prompt: `${message} prompt` }).pipe(Effect.annotateLogs({ category }))
  await ship(
    config,
    Effect.gen(function* () {
      yield* log("outer", "llm.request")
      yield* Effect.gen(function* () {
        yield* log("inner", "llm.request")
        // The outer categories still apply inside the inner scope.
        yield* log("inner tool", "tool.call")
      }).pipe(Datadog.withPolicy({ content: "full" }))
    }).pipe(Datadog.withPolicy({ content: "hash", categories: "llm" })),
  )
  const [outer, inner, ...rest] = target.requests[0].body
  expect(outer.prompt).toMatch(/^sha256:/)
  expect(inner.prompt).toBe("inner prompt")
  expect(rest).toEqual([])
})

test("AC-3b a policy cannot re-include question or pty unless the env var does", async () => {
  const run = async (env: Record<string, string>) => {
    const target = intake()
    using _ = target.server
    const config = required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, ...env }))
    await ship(
      config,
      Effect.forEach(["question.asked", "pty.create", "llm.request"], (category) =>
        Effect.logInfo(category).pipe(Effect.annotateLogs({ category })),
      ).pipe(Datadog.withPolicy({ categories: "question,pty,llm" })),
    )
    return target.requests[0].body.map((entry) => entry.message)
  }
  expect(await run({})).toEqual(["llm.request"])
  expect(await run({ OPENCODE_DATADOG_CATEGORIES: "*" })).toEqual(["question.asked", "pty.create", "llm.request"])
})

test("AC-4b the global minimum is the lowest active sink level", async () => {
  const datadog = async (level: string) => settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOG_LEVEL: level })
  // With Datadog off, the global minimum equals the file level exactly.
  for (const level of ["Debug", "Info", "Warn", "Error"] as const) {
    expect(Observability.minimumLevel(level, Option.none())).toBe(level)
  }
  expect(Observability.minimumLevel("Info", await datadog("Debug"))).toBe("Debug")
  // A Datadog level above the file level leaves the file level in force.
  expect(Observability.minimumLevel("Info", await datadog("Error"))).toBe("Info")
  expect(Observability.minimumLevel("Info", await datadog("None"))).toBe("Info")
})

test("AC-4b a Datadog level of None sends nothing", async () => {
  const target = intake()
  using _ = target.server
  const config = required(
    await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOGS_URL: target.url, OPENCODE_DATADOG_LOG_LEVEL: "None" }),
  )
  await ship(config, Effect.logFatal("never sent").pipe(Effect.annotateLogs({ category: "llm.request" })))
  expect(target.requests).toEqual([])
})

test("AC-4b an invalid OPENCODE_LOG_LEVEL keeps INFO", async () => {
  expect(await withEnv({ OPENCODE_LOG_LEVEL: "LOUD" }, () => Effect.runPromise(Logging.minimumLogLevel))).toBe("Info")
})

test("AC-4b the stderr and OTLP loggers filter to the file level", async () => {
  const datadog = intake()
  using _datadog = datadog.server
  const otlp: Array<string> = []
  using collector = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/logs") otlp.push(await request.text())
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  })
  const stderr: Array<string> = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }
  try {
    await withEnv(
      {
        OPENCODE_LOG_LEVEL: "INFO",
        OPENCODE_PRINT_LOGS: "1",
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.href.replace(/\/$/, ""),
        DD_API_KEY: "key",
        OPENCODE_DATADOG_LOGS_URL: datadog.url,
        OPENCODE_DATADOG_LOG_LEVEL: "Debug",
      },
      async () => {
        // The OTLP flags read the ambient ConfigProvider, which copies process.env once per process.
        const runtime = ManagedRuntime.make(
          Observability.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv()))),
        )
        await runtime.runPromise(
          Effect.all([Effect.logDebug("per-sink debug"), Effect.logInfo("per-sink info")]).pipe(
            Effect.annotateLogs({ category: "llm.request" }),
          ),
        )
        await runtime.dispose()
      },
    )
  } finally {
    process.stderr.write = write
  }
  expect(stderr.join("")).toContain("per-sink info")
  expect(stderr.join("")).not.toContain("per-sink debug")
  expect(otlp.join("")).toContain("per-sink info")
  expect(otlp.join("")).not.toContain("per-sink debug")
  expect(datadog.requests.flatMap((request) => request.body.map((entry) => entry.message))).toEqual([
    "per-sink debug",
    "per-sink info",
  ])
}, 20_000)

// Resolves the settings through the file layer and returns the warnings that it logged.
async function fromFiles(files: Record<string, string>, env: Record<string, string> = { DD_API_KEY: "key" }) {
  await using temp = await tempDir()
  await Promise.all(Object.entries(files).map(([name, text]) => Bun.write(path.join(temp.dir, name), text)))
  const warned = warnings()
  const resolved = await Datadog.provider({ env, configDir: temp.dir }).pipe(
    Effect.flatMap((provider) => Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider)))),
    Effect.provide(Logger.layer([warned.logger])),
    Effect.runPromise,
  )
  return { settings: resolved, warnings: warned.messages }
}

const datadogFile = (datadog: unknown) => JSON.stringify({ observability: { datadog } })

test("AC-1b Observability.layer reads the global config dir from OPENCODE_CONFIG_DIR", async () => {
  await using temp = await tempDir()
  await Bun.write(path.join(temp.dir, "opencode.json"), datadogFile({ service: "from-global-file" }))
  const target = intake()
  using _ = target.server
  await withEnv(
    {
      OPENCODE_CONFIG_DIR: temp.dir,
      DD_API_KEY: "key",
      OPENCODE_DATADOG_LOGS_URL: target.url,
      OPENCODE_DATADOG_FLUSH_INTERVAL: "1 hour",
    },
    async () => {
      const runtime = ManagedRuntime.make(Observability.layer)
      await runtime.runPromise(Effect.logInfo("configured").pipe(Effect.annotateLogs({ category: "cli.exit" })))
      await runtime.dispose()
    },
  )
  expect(target.requests[0].body[0].service).toBe("from-global-file")
})

test("AC-1c files merge key by key and the later file wins", async () => {
  const result = await fromFiles({
    "config.json": datadogFile({ service: "a", env: "x" }),
    "opencode.json": datadogFile({ service: "b" }),
    "opencode.jsonc": `{ "observability": { "datadog": { "version": "3", }, }, }`,
  })
  expect(result.warnings).toEqual([])
  expect(required(result.settings)).toMatchObject({ service: "b", env: "x", version: "3" })
})

test("AC-1c an empty file counts as no file", async () => {
  const result = await fromFiles({ "config.json": datadogFile({ service: "kept" }), "opencode.json": "  \n " })
  expect(result.warnings).toEqual([])
  expect(required(result.settings).service).toBe("kept")
})

test("AC-1c a malformed JSONC file is ignored with one warning and env settings still apply", async () => {
  const result = await fromFiles(
    { "config.json": datadogFile({ env: "from-file" }), "opencode.json": `{ "observability": ` },
    { DD_API_KEY: "key", DD_SERVICE: "from-env" },
  )
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain("opencode.json")
  expect(required(result.settings)).toMatchObject({ service: "from-env", env: "from-file" })
})

test("AC-1c a non-object observability or datadog is ignored with one warning", async () => {
  for (const text of [JSON.stringify({ observability: "on" }), JSON.stringify({ observability: { datadog: 3 } })]) {
    const result = await fromFiles({ "opencode.json": text })
    expect(result.warnings).toHaveLength(1)
    expect(required(result.settings).service).toBe("opencode")
  }
})

test("AC-1c an unknown key is ignored with one warning", async () => {
  const result = await fromFiles({ "opencode.json": datadogFile({ servce: "typo", service: "kept" }) })
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain('"servce"')
  expect(required(result.settings).service).toBe("kept")
})

test("AC-1d a file cannot widen content, set url, set an unknown site, or re-include question or pty", async () => {
  const cases: Array<[Record<string, unknown>, (settings: Datadog.Settings) => void]> = [
    [{ content: "full" }, (settings) => expect(settings.content).toBe("omit")],
    [{ url: "https://collector.example/logs" }, (settings) => expect(Option.isNone(settings.url)).toBe(true)],
    [{ site: "datadog.attacker.example" }, (settings) => expect(settings.site).toBe("datadoghq.com")],
    [{ categories: "llm,question" }, (settings) => expect(settings.categories).toBe("*,-question,-pty")],
    [{ categories: "pty.create" }, (settings) => expect(settings.categories).toBe("*,-question,-pty")],
  ]
  for (const [datadog, check] of cases) {
    const result = await fromFiles({ "opencode.json": datadogFile(datadog) })
    expect(result.warnings).toHaveLength(1)
    check(required(result.settings))
  }
})

test("AC-1d the narrowing file values apply and a wildcard keeps the default exclusions", async () => {
  const result = await fromFiles({
    "opencode.json": datadogFile({ content: "hash", site: "datadoghq.eu", categories: "*,-llm.stream" }),
  })
  expect(result.warnings).toEqual([])
  const settings = required(result.settings)
  expect(settings).toMatchObject({ content: "hash", site: "datadoghq.eu" })
  const include = Datadog.categoryFilter(settings.categories)
  expect(["question.asked", "pty.create", "llm.stream"].filter(include)).toEqual([])
  expect(include("llm.request")).toBe(true)
  // A file can turn the sink off but never on.
  expect(Option.isNone((await fromFiles({ "opencode.json": datadogFile({ enabled: false }) })).settings)).toBe(true)
})

test("AC-1e level is case-insensitive, flushInterval takes a duration string, and an empty env value is unset", async () => {
  for (const level of ["DEBUG", "debug", "Debug"]) {
    expect(required(await settings({ DD_API_KEY: "key", OPENCODE_DATADOG_LOG_LEVEL: level })).level).toBe("Debug")
  }
  const result = await fromFiles(
    { "opencode.json": datadogFile({ level: "WARN", flushInterval: "10 seconds", service: "from-file" }) },
    { DD_API_KEY: "key", DD_SERVICE: "" },
  )
  expect(result.warnings).toEqual([])
  const resolved = required(result.settings)
  expect(resolved.level).toBe("Warn")
  expect(Duration.toMillis(resolved.flushInterval)).toBe(10_000)
  expect(resolved.service).toBe("from-file")
})

test("AC-1e a bad value that turns the sink off emits one Warn to the other sinks, not the console", async () => {
  const stderr: Array<string> = []
  const console_: Array<string> = []
  const write = process.stderr.write.bind(process.stderr)
  const methods = { log: console.log, warn: console.warn, error: console.error }
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }
  for (const name of ["log", "warn", "error"] as const)
    console[name] = (...args: Array<unknown>) => console_.push(args.join(" "))
  try {
    await withEnv({ DD_API_KEY: "key", OPENCODE_DATADOG_LOG_LEVEL: "Loud", OPENCODE_PRINT_LOGS: "1" }, async () => {
      const runtime = ManagedRuntime.make(Observability.layer)
      await runtime.runPromise(Effect.void)
      await runtime.dispose()
    })
  } finally {
    process.stderr.write = write
    Object.assign(console, methods)
  }
  const lines = stderr
    .join("")
    .split("\n")
    .filter((line) => line.includes("Datadog sink disabled by a bad setting"))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain("level=WARN")
  expect(console_.filter((line) => line.includes("Datadog"))).toEqual([])
})

test("AC-2b a config file API key logs one warning that names the file", async () => {
  const result = await fromFiles({ "opencode.jsonc": datadogFile({ apiKey: "from-file", service: "kept" }) }, {})
  expect(result.warnings).toHaveLength(1)
  expect(result.warnings[0]).toContain("opencode.jsonc")
  expect(result.warnings[0]).not.toContain("from-file")
  expect(Option.isNone(result.settings)).toBe(true)
})

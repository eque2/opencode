# Logging patterns for Effect

This document compares six ways to capture opencode logs with Effect v4 logging. The capture sites are in [`logging-sites.md`](./logging-sites.md). Pattern 3 is the recommended pattern. Its Datadog implementation is `packages/core/src/observability/datadog.ts`.

The examples use the pinned Effect `4.0.0-rc.117` API. Only the pattern 3 code is in the repository. The other examples show shape, not finished code.

## The two halves of a logging design

A logging design has two separate halves. Keep them separate.

1. **Emission** decides which sites produce a record, and what the record holds. Patterns 1, 2, 4, 5 and 6 are emission patterns.
2. **Transport** decides where a record goes, and in what form. Pattern 3 is the transport pattern. Pattern 2 also has a transport half (OTLP).

A record emitted with `Effect.log*` reaches every logger in the root set. So one emission pattern can feed the file log, OTLP and Datadog at the same time.

## Shared conventions

Every pattern uses the same record shape, so that sinks and dashboards do not depend on the pattern.

- **`category` annotation.** Use the dotted taxonomy from the sites document, such as `llm.request` or `tool.call`. Sinks filter on it.
- **Correlation annotations.** Use `sessionID`, `messageID`, `callID`, `agent`, `providerID` and `modelID` where they apply.
- **Content keys.** Put sensitive text under the keys `prompt`, `system`, `messages`, `content`, `text`, `input`, `output`, `args`, `arguments`, `result`, `diff` or `command`. The Datadog sink omits or hashes these keys by default.
- **Secret keys.** Never log a secret on purpose. The sink redacts keys that match `api key`, `authorization`, `password`, `secret`, `token`, `cookie` or `credential` as a safety net.

---

## Pattern 1: Inline structured events at call sites

Add an `Effect.log*` call at each site, with a category and structured fields.

```ts
// packages/opencode/src/session/processor.ts, step-finish branch
yield *
  Effect.logInfo("step finished", {
    tokens: usage.tokens,
    cost: usage.cost,
    finishReason: value.finishReason,
  }).pipe(Effect.annotateLogs({ category: "llm.usage", providerID: model.providerID, modelID: model.id }))

// packages/llm/src/route/executor.ts, retryStatusFailures, before the sleep
yield *
  Effect.logWarning("provider retry", { attempt, delayMs, reason: error.reason._tag }).pipe(
    Effect.annotateLogs({ category: "llm.retry" }),
  )
```

A small helper keeps the category spelling in one place. Add it only when the same category repeats at many sites.

```ts
export const event = (category: string, message: string, fields: Record<string, unknown> = {}) =>
  Effect.logInfo(message, fields).pipe(Effect.annotateLogs({ category }))
```

**Pros**

- The record holds exactly the fields that the author chose. It holds no accidental payload.
- A reader sees the log next to the code that it describes.
- It needs no new infrastructure. The existing file logger records it now.

**Cons**

- It touches many files. The catalogue lists more than 300 sites.
- Coverage depends on discipline. A new tool or protocol is silent until someone adds a call.
- Category names can drift unless one helper or constant owns them.

**Use it for** the silent high-value sites in "Gaps to close first", where no event or span exists.

---

## Pattern 2: Scoped annotations and spans, exported through OTLP

Annotate a scope once at a boundary. Every log and span inside the scope inherits the annotations. `Effect.fn` spans already exist at about 857 sites. OTLP carries both logs and traces to an OpenTelemetry collector or to the Datadog Agent, with no new sink.

```ts
// Boundary: one provider turn. Every log inside carries these fields.
const runTurn = Effect.fn("SessionRunner.runTurn")(function* (input: TurnInput) {
  yield* Effect.annotateLogsScoped({ sessionID: input.sessionID, step: input.step, agent: input.agent.id })
  yield* Effect.annotateCurrentSpan({ "session.id": input.sessionID, "gen_ai.request.model": input.model.id })
  // ...existing turn body; nested Effect.log* calls inherit sessionID, step and agent
}, Effect.scoped)

// Duration without a span: adds `turn=<ms>` to every log inside.
yield * stream.pipe(Effect.withLogSpan("turn"))
```

Datadog accepts OTLP directly, so this path needs only configuration:

```sh
# Datadog Agent with OTLP ingest on (otlp_config.receiver.protocols.http.endpoint: 0.0.0.0:4318)
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=prod,team=platform"
```

**Pros**

- It is nearly free. The spans exist already, and `Otlp.loggers` and `Otlp.tracingLayer` are in `core/src/observability/otlp.ts`.
- Logs link to traces through the OpenTelemetry context, so Datadog APM shows a log under its span.
- Annotations remove repeated `sessionID` arguments from every inner call.

**Cons**

- It sends everything. The OTLP logger has no per-sink level, category filter or content redaction.
- Only `Tool.execute` spans carry attributes today. Most spans have a name and nothing else.
- Some protocol handlers create one span per stream chunk. This is expensive and noisy.
- The AI SDK telemetry path records prompts and outputs by default when `experimental.openTelemetry` is on.
- A collector or Agent must run next to each client.

**Use it for** correlation. Annotate the session, turn and tool boundaries whatever transport you choose.

---

## Pattern 3: Batched custom Logger sink (recommended)

Write a `Logger` that maps each record to the vendor format. Wrap it in `Logger.batched`, and add it to the root logger set in `Observability.layer`. Read every switch through Effect `Config`.

This is the pattern of `packages/core/src/observability/datadog.ts`. The core of it:

```ts
export function logger(settings: Settings) {
  const url = Option.getOrElse(settings.url, () => `https://http-intake.logs.${settings.site}/api/v2/logs`)
  const include = categoryFilter(settings.categories)
  const format = Logger.make((options) =>
    LogLevel.isGreaterThanOrEqualTo(options.logLevel, settings.level) ? entry(options, settings, include) : undefined,
  )
  return Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const send = (batch: Array<Entry>) =>
      http.execute(HttpClientRequest.post(url).pipe(/* DD-API-KEY header, JSON body */)).pipe(
        Effect.retry({ times: 3, schedule: Schedule.exponential("500 millis") }),
        Effect.ignore,
        Effect.withTracerEnabled(false), // the export must not trace or log itself
      )
    return yield* Logger.batched(format, {
      window: settings.flushInterval,
      flush: (items) => Effect.forEach(chunks(items.filter((item) => item !== undefined)), send, { discard: true }),
    })
  })
}
```

The mount in `core/src/observability.ts`:

```ts
const datadog = yield * Datadog.settings
const loggers = [...Logging.loggers(), ...Otlp.loggers(), ...(datadog ? [Datadog.logger(datadog)] : [])]
const logs = Logger.layer(loggers, { mergeWithExisting: false }).pipe(Layer.provide(FetchHttpClient.layer) /* … */)
```

`entry` maps one record to the Datadog format:

- It sets the reserved attributes `message`, `status`, `date`, `service`, `hostname`, `ddsource` and `ddtags`.
- It merges the annotations and object messages as attributes.
- It adds `dd.trace_id` and `dd.span_id` from the current span, so Datadog links the log to APM.
- It redacts secrets, and omits or hashes content keys.

**Pros**

- One place owns level, category filter, redaction, batching, retry and vendor format. No call site changes.
- It receives every record from every emission pattern, including the existing `Effect.log*` calls.
- It shares the logger scope, so `Logger.batched` flushes remaining records when the runtime shuts down.
- It is testable end to end with a local `Bun.serve` intake. See `core/test/effect/observability-datadog.test.ts`.
- It needs no Agent or collector next to each client.

**Cons**

- It only sees what is emitted. Silent sites stay silent until pattern 1, 4 or 5 emits a record.
- It owns the delivery work: batching, payload limits, retry and backoff. The current version drops a batch after three retries and has no disk spool.
- It needs a vendor API key on each client. The key is `Redacted` in memory, but it is still on the machine.
- A sink per vendor duplicates the delivery work. OTLP avoids this.

**Why it is the recommendation.** The Eque2 data-loss-prevention rules need a filter and redaction that nothing can bypass. The sink is the one point that every record passes through. Patterns 1, 2, 4 and 5 then decide what is emitted, and the sink decides what leaves the machine.

---

## Pattern 4: Event-bus projector

Subscribe once to `EventV2` and map event types to log records. The durable V2 events (`session.next.*`) already describe the whole session: prompt admitted, step started and ended, tool called, succeeded and failed, compaction, and retry. V1 events reach the same bus through `EventV2Bridge`.

```ts
// packages/core/src/observability/event-log.ts (illustrative)
const categories: Record<string, (data: any) => { category: string; message: string; fields: object } | undefined> = {
  "session.next.prompt.admitted": (data) => ({
    category: "session.prompt",
    message: "prompt admitted",
    fields: { prompt: data.prompt },
  }),
  "session.next.tool.called": (data) => ({
    category: "tool.call",
    message: data.tool,
    fields: { callID: data.callID, input: data.input },
  }),
  "session.next.tool.failed": (data) => ({
    category: "tool.error",
    message: data.message,
    fields: { callID: data.callID },
  }),
  "session.next.step.ended": (data) => ({
    category: "llm.usage",
    message: "step ended",
    fields: { tokens: data.tokens, finish: data.finish },
  }),
  "session.next.retried": (data) => ({ category: "llm.retry", message: "retried", fields: data }),
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const unsubscribe = yield* events.listen((event) => {
      const record = categories[event.type]?.(event.data)
      if (!record) return Effect.void
      return Effect.logInfo(record.message, record.fields).pipe(
        Effect.annotateLogs({ category: record.category, sessionID: event.data.sessionID, eventID: event.id }),
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)
  }),
)
```

**Pros**

- It changes no call site. One file covers every session, tool and permission event in both stacks.
- Events are the product contract, so their shape is stable and typed in `packages/schema`.
- Durable events carry a sequence number, so a record can say exactly where it sits in the session.
- Tool duration comes from the `tool.called` and `tool.success` timestamps.

**Cons**

- It only sees what is published. LLM transport detail (the request body, HTTP retries, rate limits, token refresh) is not an event.
- Delta events (`text.delta`, `tool.input.delta`) are very frequent. The map must skip them, or the volume explodes.
- It loses the fiber context of the emitter. Span links and annotations from the call site are missing, unless the event carries them.
- Listener work runs on the publish path (`notify`). A slow listener slows every publish, so keep the mapping cheap.

**Use it for** the session and tool audit trail. It is the fastest way to broad coverage.

---

## Pattern 5: Service decorator layers

Wrap a service with a layer that logs around each method, and keep the original implementation. This is aspect-style logging at a service boundary, such as `LLMClient`, `ToolRegistry` or `Permission`.

```ts
// packages/llm/src/route/logged-client.ts (illustrative)
export const logged = Layer.effect(
  LLMClient,
  Effect.gen(function* () {
    const inner = yield* LLMClient
    return LLMClient.of({
      ...inner,
      stream: (request) =>
        inner.stream(request).pipe(
          Stream.tap((event) =>
            event.type === "finish"
              ? Effect.logInfo("llm finish", { usage: event.usage, reason: event.reason })
              : Effect.void,
          ),
          Stream.tapError((error) => Effect.logError("llm error", { reason: error.reason._tag })),
          Stream.withSpan("LLMClient.stream"),
          Stream.annotateLogs({ category: "llm.request", modelID: request.model.id }),
        ),
    })
  }),
).pipe(Layer.provide(LLMClient.layer))
```

The same shape wraps `ToolRegistry.settle` to log the tool name, duration and outcome of every V2 tool, which today have no log.

**Pros**

- It gives uniform coverage for a whole service. Every present and future caller is covered.
- It sees typed inputs and outputs, and the caller's fiber context, so spans and annotations are intact.
- A layer swap turns it on or off. Tests and production can choose different layers.

**Cons**

- It sees only the service boundary, not the internals. Retries inside the executor stay silent.
- Each service interface change means a decorator change.
- Layer order matters. A decorator provided in the wrong place wraps nothing, or wraps twice.
- Stream decoration is harder to read than a plain call.

**Use it for** the few high-traffic boundaries: `LLMClient`, `ToolRegistry`, and the HTTP `RequestExecutor`.

---

## Pattern 6: Plugin-hook logger

Put the logging in an opencode plugin. The plugin uses the hooks `event`, `chat.params`, `chat.headers`, `tool.execute.before`, `tool.execute.after`, `experimental.chat.system.transform` and `experimental.text.complete`. The plugin runs its own Effect runtime and logger. The host runtime does not change.

```ts
// An Eque2 plugin, outside packages/opencode (illustrative)
import type { Plugin } from "@opencode-ai/plugin"
import { Effect, Layer, Logger, ManagedRuntime } from "effect"

export const DatadogAudit: Plugin = async () => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Logger.layer([
        /* vendor sink */
      ]) /* , config */,
    ),
  )
  const log = (category: string, message: string, fields: object) =>
    runtime.runFork(Effect.logInfo(message, fields).pipe(Effect.annotateLogs({ category })))
  const started = new Map<string, number>()
  return {
    "tool.execute.before": async (input) => {
      started.set(input.callID, Date.now())
    },
    "tool.execute.after": async (input, output) => {
      log("tool.result", input.tool, {
        callID: input.callID,
        sessionID: input.sessionID,
        durationMs: Date.now() - (started.get(input.callID) ?? Date.now()),
        title: output.title,
      })
      started.delete(input.callID)
    },
    "chat.params": async (input, output) => {
      log("llm.request", "chat params", {
        sessionID: input.sessionID,
        modelID: input.model.id,
        temperature: output.temperature,
      })
    },
    event: async ({ event }) => {
      if (event.type === "session.error") log("session.error", "session error", { properties: event.properties })
    },
    dispose: async () => runtime.dispose(),
  }
}
```

**Pros**

- It keeps vendor and policy code out of the host runtime, in line with the fork policy in `AGENTS.md`.
- It ships and versions on its own cycle, and each organisation can choose its own plugin.
- It is the right home for organisation-specific rules, such as which user events count as audit events.

**Cons**

- It only sees what a hook exposes. The hooks are V1 only. The V2 runner does not trigger `tool.execute.*` or `chat.*`.
- `permission.ask` is declared but never triggered.
- Every record crosses the plugin boundary, and the `event` fan-out drops rejections silently.
- The plugin runtime does not share the host's spans or annotations, so trace correlation is lost.
- Hooks can change output, so a logging plugin has more power than it needs.

**Use it for** organisation audit rules on top of the host sink. Do not use it as the main transport.

---

## Comparison

|                          | 1 Inline       | 2 Annotations + OTLP   | 3 Custom sink       | 4 Bus projector  | 5 Decorator      | 6 Plugin hooks         |
| ------------------------ | -------------- | ---------------------- | ------------------- | ---------------- | ---------------- | ---------------------- |
| Role                     | emission       | emission and transport | transport           | emission         | emission         | emission and transport |
| Call-site changes        | many           | few                    | none                | none             | none             | none                   |
| Coverage                 | chosen sites   | spans that exist       | all emitted records | published events | wrapped services | exposed hooks, V1 only |
| LLM transport detail     | yes            | partial                | n/a                 | no               | boundary only    | params only            |
| Trace correlation        | yes            | best                   | yes (`dd.trace_id`) | weak             | yes              | no                     |
| Redaction control        | author         | none                   | central             | map author       | decorator author | plugin author          |
| Datadog without an Agent | with pattern 3 | no                     | yes                 | with pattern 3   | with pattern 3   | yes                    |

## Recommended combination

1. Use **pattern 3** as the single transport and policy gate. It is implemented.
2. Mount **pattern 4** for the session, tool and permission audit trail. This gives broad coverage with one file.
3. Add **pattern 2** annotations at the session, turn and tool boundaries, so every record carries correlation fields.
4. Add **pattern 1** calls at the silent sites that no event covers: LLM retries, token refresh, tool-call repair, HTTP 401, and the swallowed LSP and MCP errors.
5. Add **pattern 5** only for `LLMClient`, when per-request latency and usage are needed on the native path.

Keep pattern 6 for Eque2 audit rules in the Eque2 plugin.

---

## Configuration layers

The logging configuration has five layers. Each layer overrides the layer above it.

| Layer            | Mechanism                                                                       | Example                                                    | Scope           |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------- |
| 1. Code defaults | `Config.withDefault`                                                            | `level: Info`, `content: omit`, `flushInterval: 5 seconds` | build           |
| 2. Config file   | `ConfigProvider.fromUnknown(config.observability)`                              | `{ "datadog": { "categories": "llm,tool" } }`              | user or project |
| 3. Environment   | `ConfigProvider.fromEnv()`                                                      | `OPENCODE_DATADOG_CONTENT=hash`                            | process         |
| 4. CLI flags     | yargs middleware that writes env before the layer builds                        | `--log-level DEBUG`                                        | invocation      |
| 5. Runtime scope | `Effect.provideService(References.MinimumLogLevel, …)` or a `Context.Reference` | debug logs for one session only                            | fiber           |

Layers 1 to 4 need no new code, because the sink reads `Config` values. To add layer 2, compose the providers when the observability layer builds:

```ts
const provider = ConfigProvider.orElse(ConfigProvider.fromEnv(), () =>
  ConfigProvider.fromUnknown({ DD_SERVICE: "opencode" }),
)
const datadog = yield * Datadog.settings.pipe(Effect.provide(ConfigProvider.layer(provider)))
```

Layer 5 changes behaviour for one fiber tree, without a restart:

```ts
// Everything inside this session's drain logs at Debug. Other sessions keep Info.
drain(sessionID).pipe(Effect.provideService(References.MinimumLogLevel, "Debug"))

// A per-scope policy that sinks can read from options.fiber
export const LogPolicy = Context.Reference<{ readonly content: "omit" | "hash" | "full" }>("opencode/LogPolicy", {
  defaultValue: () => ({ content: "omit" }),
})
```

A sink reads a per-scope policy with `options.fiber.getRef(LogPolicy)`. That lets a support engineer turn on full content for one debug session, while every other session stays redacted. The current Datadog sink does not read `LogPolicy`. Add it when a support workflow needs per-session content.

### Datadog sink switches

| Variable                             | Default                                      | Purpose                                                                                                                              |
| ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DD_API_KEY`                         | none                                         | Required. The sink stays off without it.                                                                                             |
| `OPENCODE_DATADOG_LOGS`              | `true`                                       | Master switch. `false` turns the sink off while the key stays set.                                                                   |
| `DD_SITE`                            | `datadoghq.com`                              | Datadog region, such as `datadoghq.eu` for EU data residency.                                                                        |
| `OPENCODE_DATADOG_LOGS_URL`          | derived from `DD_SITE`                       | Full intake URL override: a proxy, the Agent, or a test server.                                                                      |
| `DD_SERVICE`, `DD_ENV`, `DD_VERSION` | `opencode`, install channel, install version | Unified service tagging.                                                                                                             |
| `DD_TAGS`                            | empty                                        | Extra comma-separated `key:value` tags.                                                                                              |
| `DD_HOSTNAME`                        | `os.hostname()`                              | Host attribute.                                                                                                                      |
| `OPENCODE_DATADOG_LOG_LEVEL`         | `Info`                                       | Sink level: `Trace`, `Debug`, `Info`, `Warn`, `Error` or `Fatal`. It can only raise the global `OPENCODE_LOG_LEVEL`, never lower it. |
| `OPENCODE_DATADOG_CATEGORIES`        | `*`                                          | Category prefixes to send; a `-` prefix excludes. Example: `llm,tool,-tool.read`.                                                    |
| `OPENCODE_DATADOG_CONTENT`           | `omit`                                       | Content keys: `omit` (length only), `hash` (SHA-256 prefix) or `full`.                                                               |
| `OPENCODE_DATADOG_FLUSH_INTERVAL`    | `5 seconds`                                  | Batch window.                                                                                                                        |

An invalid value turns the sink off. It does not stop startup.

### Limits of the current sink

- A batch is dropped after three failed retries. There is no disk spool.
- Payloads are not gzip-compressed. Add compression when volume makes bandwidth matter.
- An `Error` keeps only its name and message. The V2 bash `ToolFailure` message holds the command text, so exclude `tool.error` or accept the command text.
- The global `OPENCODE_LOG_LEVEL` filters records before any sink. To send `Debug` to Datadog, lower both levels.
- `opencode/src/server/server.ts:132` builds its listener with a fresh memo map, so it can build a second sink instance. Each instance batches on its own, so this is safe, but it doubles the HTTP connections.

# Logging coverage gaps

This document checks every site in [`logging-sites.md`](./logging-sites.md) against the Datadog logging in pull request [#1](https://github.com/eque2/opencode/pull/1). It answers one question for each site: does a Datadog log record exist for the site when the PR is merged?

The check was made on 2026-09-29 against branch `datadog-logging` at `1f1eb26968`. Line numbers come from the catalogue and drift.

## What reaches Datadog

The Datadog sink is an Effect `Logger`. It receives only `Effect.log*` records.

- **Log records** reach Datadog when their level is at or above `OPENCODE_DATADOG_LOG_LEVEL` (default `Info`).
- **Spans** (`Effect.fn`, `Effect.withSpan`) go only to an OTLP collector, and only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. They never reach the Datadog sink.
- **Bus events** (`EventV2`, `Bus`, `GlobalBus`) and **plugin hooks** produce no log record.
- **Categories.** Only the PR's MCP tool call log sets a `category` annotation. Every other record arrives as `general`, so `OPENCODE_DATADOG_CATEGORIES` cannot select or exclude it.

The PR adds one new log site: the MCP tool call (`opencode/src/session/tools.ts:571`, category `mcp.tool`). Every other captured site was already logging before the PR.

## Summary

| Status         |   Sites | Meaning                                                                                         |
| -------------- | ------: | ----------------------------------------------------------------------------------------------- |
| Gap            |     201 | No log record. The site is silent, or it has only a span, a bus event or a hook.                |
| Partial        |      56 | A log record exists, but with category `general`, only on a failure branch, or only at `Debug`. |
| Captured by PR |       1 | The PR adds a categorised log record.                                                           |
| Excluded       |       1 | The site handles secrets and must not be logged.                                                |
| n/a            |       2 | A mount point, not an event.                                                                    |
| **Total**      | **261** |                                                                                                 |

## Cross-cutting gaps

These five gaps explain most rows. Closing one closes many sites at once.

1. **No span-to-log bridge.** About 857 `Effect.fn` sites record duration and outcome, but only for OTLP. A tracer wrapper that logs each span end would turn every `span (OTLP only)` gap below into a Partial. It needs a noise filter for the per-chunk protocol spans.
2. **No bus tap.** `EventV2.publish` (`core/src/event.ts:419`) sees every V1 and V2 event, including session, tool, permission and question state. One listener that logs the event type and IDs, without `data`, would close every `bus event` gap.
3. **No categories on existing logs.** 56 Partial sites log as `general`. The category taxonomy in the catalogue is not applied in code.
4. **No LLM call record.** Native LLM calls (`llm/src/route/client.ts:374`, `executor.ts:370`), the AI SDK fetch wrappers (`provider.ts:1804`, `core/src/aisdk.ts:85`) and the V2 provider turn (`core/src/session/runner/llm.ts:239`) log nothing. Token usage and cost reach no sink.
5. **No HTTP access or auth log.** Every router sets `disableLogger: true`, and a 401 is not logged.

## Priority 1 gaps

The catalogue marks these 39 sites as high value. None of them has a log record. Sections 7 to 16 of the catalogue have no priority column, so their high-value sites (bold in the catalogue, for example prompt admission, session idle and the shell tool) appear only in the tables below.

| Site                                                             | Symbol                                                     | Event                                                                                             | Today                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `llm/src/route/client.ts:344`                                    | `compile`                                                  | Request built: cache policy, provider body, transport                                             | No log; span (OTLP only)              |
| `llm/src/route/client.ts:374`                                    | `streamRequestWith`                                        | Entry point of every streamed call                                                                | No log; span (OTLP only)              |
| `llm/src/route/client.ts:279`                                    | `route.streamPrepared`                                     | Frames decoded, `protocol.step` per event, `onHalt` flush                                         | Silent; nothing records it            |
| `llm/src/route/executor.ts:370`                                  | `executeOnce`                                              | One HTTP attempt                                                                                  | No log; span (OTLP only)              |
| `llm/src/route/executor.ts:277`                                  | `statusError`                                              | HTTP ≥ 400 mapped to a provider error                                                             | Silent; nothing records it            |
| `llm/src/route/executor.ts:225`                                  | `statusReason`                                             | Error classified (content policy, auth, quota, rate limit, invalid, internal)                     | Silent; nothing records it            |
| `llm/src/route/executor.ts:353`                                  | `retryStatusFailures`                                      | Retry (max 2, 500 ms to 10 s, honours retry-after)                                                | Silent; nothing records it            |
| `llm/src/route/transport/http.ts:130`                            | `httpJson.frames`                                          | Response received; read errors at :139                                                            | Silent; nothing records it            |
| `llm/src/protocols/utils/lifecycle.ts:80`                        | `Lifecycle.finish`                                         | `step-finish` and `finish` with usage, for every native protocol                                  | Silent; nothing records it            |
| `llm/src/protocols/anthropic-messages.ts:652`, `:782`            | `onMessageStart`, `onMessageDelta`                         | Initial and final usage, stop reason                                                              | Silent; nothing records it            |
| `llm/src/protocols/anthropic-messages.ts:804`, `:814`            | `onError`, `step`                                          | Stream error to `provider-error` (context overflow flag)                                          | Silent; nothing records it            |
| `llm/src/protocols/openai-chat.ts:344`, `:391`, `:407`, `:462`   | `fromRequest`, `mapUsage`, `step`, `finishEvents`          | Body, usage, chunks, finish                                                                       | No log; span (OTLP only)              |
| `llm/src/protocols/openai-responses.ts:478`, `:507`, `:875`      | `fromRequest`, `mapUsage`, `onResponseFinish`              | Body, usage, completed or incomplete                                                              | No log; span (OTLP only)              |
| `llm/src/protocols/openai-responses.ts:904-975`                  | `providerError`, `onResponseFailed`, `onError`, `terminal` | Provider error mapped                                                                             | Silent; nothing records it            |
| `llm/src/protocols/gemini.ts:302`, `:342`, `:363`, `:399`        | `fromRequest`, `mapUsage`, `mapFinishReason`, `step`       | Body, usage, finish                                                                               | No log; span (OTLP only)              |
| `llm/src/protocols/bedrock-converse.ts:443-618`                  | `mapUsage`, `step`, exceptions, `onHalt`                   | Usage, throttling and validation errors, finish                                                   | Silent; nothing records it            |
| `llm/src/tool-runtime.ts:23-63`                                  | `dispatch`, `decodeAndExecute`, `result`                   | Local tool dispatch, decode, execute, encode failures                                             | Silent; nothing records it            |
| `opencode/src/session/llm.ts:296`                                | `experimental_repairToolCall`                              | Tool call repaired or redirected to `invalid`                                                     | Silent; nothing records it            |
| `opencode/src/session/llm.ts:330`                                | `transformParams` middleware                               | **Final provider prompt**                                                                         | Silent; nothing records it            |
| `opencode/src/session/llm.ts:357-378`                            | `stream`                                                   | AI SDK `fullStream` to `LLMEvent`s                                                                | Silent; nothing records it            |
| `opencode/src/session/llm/request.ts:58-78`                      | `prepare`                                                  | **System prompt assembled**; hook `experimental.chat.system.transform` at :69                     | No log; span (OTLP only), plugin hook |
| `opencode/src/session/llm/native-runtime.ts:74-121`              | `stream`                                                   | Native request built, `llmClient.stream`, local tool dispatch                                     | Silent; nothing records it            |
| `opencode/src/session/llm/ai-sdk.ts:88-112`                      | `finish-step`                                              | Step usage, provider metadata, Copilot nano-AIU                                                   | Silent; nothing records it            |
| `opencode/src/session/llm/ai-sdk.ts:114`, `:252`, `:267`, `:277` | `finish`, `tool-error`, `error`, `raw`                     | Total usage, errors, raw billing chunk                                                            | Silent; nothing records it            |
| `opencode/src/session/processor.ts:674-686`                      | `Effect.retry(SessionRetry.policy)`                        | Session-level retry                                                                               | No log; bus event                     |
| `opencode/src/session/retry.ts:85`, `:183`, `:196`               | `retryable`, `policy`                                      | Retry classification; give-up                                                                     | Silent; nothing records it            |
| `opencode/src/session/session.ts:338`                            | `getUsage`                                                 | **Cost calculated** (tiers, over-200K pricing, nano-AIU)                                          | Silent; nothing records it            |
| `opencode/src/session/message-v2.ts:610`                         | `fromError`                                                | Error mapped to API, overflow, auth or aborted                                                    | Silent; nothing records it            |
| `core/src/session/runner/llm.ts:333`                             | `Step.Ended`                                               | V2 step end; **records `cost: 0`**                                                                | No log; bus event                     |
| `opencode/src/provider/provider.ts:1400-1730`                    | `state`                                                    | Provider and model catalogue resolved (plugins, env keys, stored auth, loaders, GitLab discovery) | Silent; nothing records it            |
| `opencode/src/provider/provider.ts:37`, `:85`                    | `wrapSSE`, `timeoutController`                             | Chunk timeout, header timeout                                                                     | Silent; nothing records it            |
| `core/src/integration.ts:385-401`                                | `connection.resolve`                                       | **OAuth auto-refresh** under 5 minutes to expiry                                                  | No log; span (OTLP only), bus event   |
| `core/src/plugin/provider/openai.ts:209`, `:221`                 | `refresh`, `request`                                       | OpenAI token refresh                                                                              | Silent; nothing records it            |
| `opencode/src/plugin/openai/codex.ts:135`, `:350`                | `refreshAccessToken`, `fetch`                              | Codex token refresh, header rewrite                                                               | Silent; nothing records it            |
| `opencode/src/plugin/xai.ts:77`, `:244`                          | refresh, fetch                                             | Token refresh                                                                                     | Silent; nothing records it            |
| `opencode/src/plugin/snowflake-cortex.ts:136`, `:445`            | refresh, fetch                                             | Token refresh                                                                                     | Silent; nothing records it            |
| `opencode/src/plugin/github-copilot/copilot.ts:96-176`           | `auth.loader` fetch                                        | Per request: `x-initiator` (agent or user), vision, auth header                                   | Silent; nothing records it            |
| `core/src/session/runner/model.ts:83-211`                        | `apiKey`, `resolve`                                        | V2 model resolved; credential may refresh                                                         | No log; span (OTLP only)              |
| `opencode/src/session/prompt.ts:1255-1271`                       | loop body                                                  | `experimental.chat.messages.transform`; system array assembled                                    | No log; plugin hook                   |

## Every site

The tables follow the catalogue sections. **Today** is the capture before the PR, from the catalogue. **Gap** says what is missing.

### 1. Central tap points

Gap: 11 · Partial: 1 · n/a: 2

| Site                                        | Symbol                            | Today                          | Status  | Gap                                             |
| ------------------------------------------- | --------------------------------- | ------------------------------ | ------- | ----------------------------------------------- |
| `core/src/event.ts:419`                     | `EventV2.publish`                 | none                           | Gap     | Silent; nothing records it                      |
| `core/src/event.ts:369`                     | `publishEvent`                    | none                           | Gap     | Silent; nothing records it                      |
| `core/src/event.ts:406`                     | `notify`                          | log on listener failure (:402) | Partial | Logs a failure branch only; success path silent |
| `core/src/event.ts:136`, `:152`             | `listen`, `allBounded`            | none                           | Gap     | Silent; nothing records it                      |
| `opencode/src/event-v2-bridge.ts:19`, `:35` | `EventV2Bridge.publish`, listener | none                           | Gap     | Silent; nothing records it                      |
| `opencode/src/bus/global.ts:14`             | `GlobalBusEmitter.emit`           | none                           | Gap     | Silent; nothing records it                      |
| `opencode/src/plugin/index.ts:284`          | `Plugin.trigger`                  | fn (no hook-name attribute)    | Gap     | No log; span (OTLP only), plugin hook           |
| `opencode/src/plugin/index.ts:255`          | plugin `event` fan-out            | none; rejections dropped       | Gap     | Silent; nothing records it                      |
| `llm/src/route/client.ts:417`               | `LLMClient` layer                 | none                           | n/a     | Mount point, not an event                       |
| `opencode/src/provider/provider.ts:1804`    | `resolveSDK` fetch wrapper        | none                           | Gap     | Silent; nothing records it                      |
| `core/src/aisdk.ts:85`                      | `prepareOptions` fetch wrapper    | none                           | Gap     | Silent; nothing records it                      |
| `core/src/tool/registry.ts:50`              | `ToolRegistry.settle`             | fn (no attributes)             | Gap     | No log; span (OTLP only)                        |
| `opencode/src/tool/tool.ts:113`             | `wrap` / `execute`                | span `Tool.execute`            | Gap     | No log; span (OTLP only)                        |
| `core/src/observability.ts:11`              | `Observability.layer`             | file, stderr, OTLP, Datadog    | n/a     | Mount point, not an event                       |

### 2. LLM runtime (`llm/src`) / Public API and client

Gap: 10

| Site                                  | Symbol                  | Today                                    | Status | Gap                        |
| ------------------------------------- | ----------------------- | ---------------------------------------- | ------ | -------------------------- |
| `llm/src/llm.ts:53`                   | `request`               | none                                     | Gap    | Silent; nothing records it |
| `llm/src/llm.ts:110`                  | `runGenerateObject`     | fn                                       | Gap    | No log; span (OTLP only)   |
| `llm/src/route/client.ts:167`         | `resolveRequestOptions` | none                                     | Gap    | Silent; nothing records it |
| `llm/src/route/client.ts:344`         | `compile`               | fn `LLM.compile`                         | Gap    | No log; span (OTLP only)   |
| `llm/src/route/client.ts:361`         | `prepareWith`           | fn                                       | Gap    | No log; span (OTLP only)   |
| `llm/src/route/client.ts:374`         | `streamRequestWith`     | none: no span covers the stream lifetime | Gap    | No log; span (OTLP only)   |
| `llm/src/route/client.ts:279`         | `route.streamPrepared`  | none                                     | Gap    | Silent; nothing records it |
| `llm/src/route/client.ts:232`         | `decodeEvent`           | none                                     | Gap    | Silent; nothing records it |
| `llm/src/route/client.ts:220`, `:293` | `streamError`           | none                                     | Gap    | Silent; nothing records it |
| `llm/src/route/client.ts:382`         | `generateWith`          | fn                                       | Gap    | No log; span (OTLP only)   |

### 2. LLM runtime (`llm/src`) / Transport, executor and auth

Gap: 14 · Excluded: 1

| Site                                                          | Symbol                       | Today                                    | Status   | Gap                                 |
| ------------------------------------------------------------- | ---------------------------- | ---------------------------------------- | -------- | ----------------------------------- |
| `llm/src/route/executor.ts:370`                               | `executeOnce`                | automatic `http.client` span (OTLP only) | Gap      | No log; span (OTLP only)            |
| `llm/src/route/executor.ts:277`                               | `statusError`                | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/executor.ts:225`                               | `statusReason`               | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/executor.ts:307`                               | `toHttpError`                | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/executor.ts:353`                               | `retryStatusFailures`        | **none**                                 | Gap      | Silent; nothing records it          |
| `llm/src/route/executor.ts:112`                               | `rateLimitDetails`           | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/executor.ts:41-202`                            | redaction helpers            | reusable for new logging                 | Gap      | Silent; nothing records it          |
| `llm/src/route/transport/http.ts:88`                          | `jsonRequestParts`           | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/transport/http.ts:130`                         | `httpJson.frames`            | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/auth.ts:151`, `:137`                           | `toEffect`, `toLLMError`     | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/auth.ts:65`                                    | `fromCredential`             | none. **Never log here.**                | Excluded | Secret material; must not be logged |
| `llm/src/route/transport/websocket.ts:125`, `:52`, `:146-173` | `open`, `waitOpen`, handlers | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/transport/websocket.ts:229`, `:257`            | `json.prepare`, `frames`     | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/route/endpoint.ts:47`                                | `render`                     | none                                     | Gap      | Silent; nothing records it          |
| `llm/src/protocols/utils/bedrock-auth.ts:48`                  | `sigV4`                      | none                                     | Gap      | Silent; nothing records it          |

### 2. LLM runtime (`llm/src`) / Protocols, providers and utilities

Gap: 20 · Partial: 2

| Site                                                           | Symbol                                                     | Today                  | Status  | Gap                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------- | ------- | --------------------------------------------------------- |
| `llm/src/protocols/utils/lifecycle.ts:80`                      | `Lifecycle.finish`                                         | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/shared.ts:90`                               | `eventError`                                               | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/shared.ts:242`                              | `sseFraming`                                               | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/anthropic-messages.ts:506`, `:535`          | `fromRequest`                                              | fn, `logWarning`       | Partial | Existing log reaches Datadog, but with category `general` |
| `llm/src/protocols/anthropic-messages.ts:652`, `:782`          | `onMessageStart`, `onMessageDelta`                         | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/anthropic-messages.ts:804`, `:814`          | `onError`, `step`                                          | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/anthropic-messages.ts:703`, `:763`          | content-block handlers                                     | **one span per chunk** | Gap     | No log; span (OTLP only)                                  |
| `llm/src/protocols/openai-chat.ts:344`, `:391`, `:407`, `:462` | `fromRequest`, `mapUsage`, `step`, `finishEvents`          | fn on `fromRequest`    | Gap     | No log; span (OTLP only)                                  |
| `llm/src/protocols/openai-responses.ts:478`, `:507`, `:875`    | `fromRequest`, `mapUsage`, `onResponseFinish`              | fn on `fromRequest`    | Gap     | No log; span (OTLP only)                                  |
| `llm/src/protocols/openai-responses.ts:904-975`                | `providerError`, `onResponseFailed`, `onError`, `terminal` | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/openai-responses.ts:789`, `:808`            | argument deltas, output item done                          | **one span per chunk** | Gap     | No log; span (OTLP only)                                  |
| `llm/src/protocols/gemini.ts:302`, `:342`, `:363`, `:399`      | `fromRequest`, `mapUsage`, `mapFinishReason`, `step`       | fn on `fromRequest`    | Gap     | No log; span (OTLP only)                                  |
| `llm/src/protocols/bedrock-converse.ts:388`, `:401`            | `fromRequest`                                              | fn, `logWarning`       | Partial | Existing log reaches Datadog, but with category `general` |
| `llm/src/protocols/bedrock-converse.ts:443-618`                | `mapUsage`, `step`, exceptions, `onHalt`                   | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/bedrock-event-stream.ts:47-82`              | `framing`                                                  | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/protocols/utils/tool-stream.ts:127-200`               | tool input assembly                                        | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/provider-error.ts:36`, `:40`                          | `isContextOverflow*`                                       | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/cache-policy.ts:99`                                   | `applyCachePolicy`                                         | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/tool-runtime.ts:23-63`                                | `dispatch`, `decodeAndExecute`, `result`                   | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/tool.ts:221`                                          | `toDefinitions`                                            | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/providers/*.ts` (`auth`, `configure`)                 | provider routes                                            | none                   | Gap     | Silent; nothing records it                                |
| `llm/src/providers/github-copilot.ts:19`, `:49`                | `shouldUseResponsesApi`                                    | none                   | Gap     | Silent; nothing records it                                |

### 3. Session LLM turn (`opencode/src/session/llm*`, V1)

Gap: 15 · Partial: 3

| Site                                                             | Symbol                                 | Today                                       | Status  | Gap                                                       |
| ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------- | ------- | --------------------------------------------------------- |
| `opencode/src/session/llm.ts:85`                                 | `LLM.run`                              | fn, `logInfo("stream")`                     | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/session/llm.ts:95`                                 | `run`                                  | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm.ts:127-187`                            | GitLab executors                       | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm.ts:226-275`                            | runtime selection                      | `logInfo` ×4                                | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/session/llm.ts:281`                                | `streamText.onError`                   | `logError`                                  | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/session/llm.ts:296`                                | `experimental_repairToolCall`          | **none**                                    | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm.ts:330`                                | `transformParams` middleware           | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm.ts:344`                                | `experimental_telemetry`               | OTel, gated by `experimental.openTelemetry` | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm.ts:357-378`                            | `stream`                               | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/request.ts:58-78`                      | `prepare`                              | fn, hook                                    | Gap     | No log; span (OTLP only), plugin hook                     |
| `opencode/src/session/llm/request.ts:99`, `:114`, `:134`         | `prepare`                              | hook                                        | Gap     | No log; plugin hook                                       |
| `opencode/src/session/llm/request.ts:148`, `:165`                | `resolveTools`                         | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/request.ts:181-204`                    | return value                           | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/native-runtime.ts:74-121`              | `stream`                               | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/native-runtime.ts:178-188`             | `nativeTools.execute`                  | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/native-request.ts:153`, `:181`         | `model`, `request`                     | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/ai-sdk.ts:88-112`                      | `finish-step`                          | none                                        | Gap     | Silent; nothing records it                                |
| `opencode/src/session/llm/ai-sdk.ts:114`, `:252`, `:267`, `:277` | `finish`, `tool-error`, `error`, `raw` | none                                        | Gap     | Silent; nothing records it                                |

### 4. Usage, cost, retry and errors

Gap: 7 · Partial: 1

| Site                                               | Symbol                                  | Today                              | Status  | Gap                                             |
| -------------------------------------------------- | --------------------------------------- | ---------------------------------- | ------- | ----------------------------------------------- |
| `opencode/src/session/processor.ts:435-497`        | `step-finish`                           | `logWarning` (:445)                | Partial | Logs a failure branch only; success path silent |
| `opencode/src/session/processor.ts:674-686`        | `Effect.retry(SessionRetry.policy)`     | event `status.set({type:"retry"})` | Gap     | No log; bus event                               |
| `opencode/src/session/processor.ts:421`            | `provider-error`                        | via `halt`                         | Gap     | Silent; nothing records it                      |
| `opencode/src/session/retry.ts:85`, `:183`, `:196` | `retryable`, `policy`                   | **none**                           | Gap     | Silent; nothing records it                      |
| `opencode/src/session/session.ts:338`              | `getUsage`                              | none                               | Gap     | Silent; nothing records it                      |
| `opencode/src/session/message-v2.ts:610`           | `fromError`                             | none                               | Gap     | Silent; nothing records it                      |
| `opencode/src/provider/error.ts:102`, `:172`       | `parseStreamError`, `parseAPICallError` | none                               | Gap     | Silent; nothing records it                      |
| `core/src/session/runner/llm.ts:333`               | `Step.Ended`                            | event                              | Gap     | No log; bus event                               |

### 5. Provider, model and credentials

Gap: 21 · Partial: 2

| Site                                                      | Symbol                                                                               | Today                   | Status  | Gap                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- | ------- | --------------------------------------------------------- |
| `opencode/src/provider/provider.ts:1400-1730`             | `state`                                                                              | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/provider/provider.ts:733`, `:1667`          | GitLab discovery                                                                     | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/provider/provider.ts:174-1000`              | `custom()` loaders                                                                   | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/provider/provider.ts:1734`, `:1864`         | `resolveSDK`                                                                         | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/provider/provider.ts:37`, `:85`             | `wrapSSE`, `timeoutController`                                                       | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/provider/provider.ts:1868-2008`             | `getProvider`, `getModel`, `getLanguage`, `closest`, `getSmallModel`, `defaultModel` | fn                      | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/provider/auth.ts:131`, `:163`, `:188`       | `methods`, `authorize`, `callback`                                                   | fn                      | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/provider/transform.ts:465-1562`             | `message`, `options`, `schema`, …                                                    | none                    | Gap     | Silent; nothing records it                                |
| `core/src/aisdk.ts:26`, `:198`                            | `wrapSSE`, `language`                                                                | fn                      | Gap     | No log; span (OTLP only)                                  |
| `core/src/models-dev.ts:175-250`                          | `fetchApi`, `refresh`                                                                | fn, `logError`, event   | Partial | Existing log reaches Datadog, but with category `general` |
| `core/src/credential.ts:67-131`                           | CRUD                                                                                 | fn                      | Gap     | No log; span (OTLP only)                                  |
| `core/src/integration.ts:385-401`                         | `connection.resolve`                                                                 | fn; **no log or event** | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/integration.ts:404-484`                         | connection lifecycle                                                                 | fn, event               | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/plugin/provider/openai.ts:209`, `:221`          | `refresh`, `request`                                                                 | none                    | Gap     | Silent; nothing records it                                |
| `core/src/plugin/provider/opencode.ts:64`, `:104`         | `refresh`, config load                                                               | `logWarning` (:104)     | Partial | Logs a failure branch only; success path silent           |
| `opencode/src/plugin/openai/codex.ts:135`, `:350`         | `refreshAccessToken`, `fetch`                                                        | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/plugin/xai.ts:77`, `:244`                   | refresh, fetch                                                                       | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/plugin/snowflake-cortex.ts:136`, `:445`     | refresh, fetch                                                                       | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/plugin/github-copilot/copilot.ts:96-176`    | `auth.loader` fetch                                                                  | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/plugin/github-copilot/copilot.ts:62`, `:86` | `provider.models`                                                                    | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/plugin/github-copilot/copilot.ts:222-262`   | `authorize`, `callback`                                                              | none                    | Gap     | Silent; nothing records it                                |
| `core/src/github-copilot/**/*-language-model.ts`          | `getArgs`, `doGenerate`, `doStream`, `flush`                                         | none                    | Gap     | Silent; nothing records it                                |
| `core/src/session/runner/model.ts:83-211`                 | `apiKey`, `resolve`                                                                  | fn                      | Gap     | No log; span (OTLP only)                                  |

### 6. System prompt and context

Gap: 8

| Site                                                | Symbol                                                 | Today                      | Status | Gap                                 |
| --------------------------------------------------- | ------------------------------------------------------ | -------------------------- | ------ | ----------------------------------- |
| `opencode/src/session/system.ts:28`                 | `provider`                                             | none                       | Gap    | Silent; nothing records it          |
| `opencode/src/session/system.ts:69`, `:107`, `:121` | `environment`, `skills`, `mcp`                         | fn                         | Gap    | No log; span (OTLP only)            |
| `opencode/src/session/instruction.ts:95-179`        | `systemPaths`, `system`, `fetch`, `resolve`            | fn                         | Gap    | No log; span (OTLP only)            |
| `opencode/src/session/prompt.ts:1255-1271`          | loop body                                              | hook                       | Gap    | No log; plugin hook                 |
| `core/src/system-context/index.ts:139-314`          | `make`, `combine`, `initialize`, `reconcile`, `render` | none                       | Gap    | Silent; nothing records it          |
| `core/src/system-context/registry.ts:25`, `:39`     | `register`, `load`                                     | fn                         | Gap    | No log; span (OTLP only)            |
| `core/src/instruction-context.ts:40-99`             | `observe`, `render`                                    | fn                         | Gap    | No log; span (OTLP only)            |
| `core/src/session/context-epoch.ts:28-111`          | `initialize`, `prepare`, `reset`                       | fn, event `ContextUpdated` | Gap    | No log; span (OTLP only), bus event |

### 7. Session lifecycle, V2 (`core/src/session`)

Gap: 18 · Partial: 1

| Site                                                  | Symbol                                                          | Today                              | Status  | Gap                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- | ------- | --------------------------------------------------------- |
| `core/src/session.ts:208`                             | `V2Session.create`                                              | fn, event `Created`                | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session.ts:360-382`                         | `V2Session.prompt`                                              | fn                                 | Gap     | No log; span (OTLP only)                                  |
| `core/src/session.ts:393-449`                         | `switchAgent`, `switchModel`, `resume`, `interrupt`, `revert.*` | fn, event                          | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/input.ts:41`                        | `SessionInput.admit`                                            | fn, event `PromptAdmitted`         | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/input.ts:216-268`                   | `publish`, `promoteSteers`, `promoteNextQueued`                 | fn, event `Prompted`               | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/execution/local.ts:17-25`           | `drain`, `tapCause`                                             | `logError`                         | Partial | Existing log reaches Datadog, but with category `general` |
| `core/src/session/run-coordinator.ts:37-94`           | `start`, `run`, `wake`, `interrupt`, `settle`                   | **none**                           | Gap     | Silent; nothing records it                                |
| `core/src/session/runner/llm.ts:390`                  | `SessionRunner.run`                                             | fn                                 | Gap     | No log; span (OTLP only)                                  |
| `core/src/session/runner/llm.ts:119`                  | `failInterruptedTools`                                          | fn, event                          | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/runner/llm.ts:173-239`              | `runTurnAttempt`                                                | fn                                 | Gap     | No log; span (OTLP only)                                  |
| `core/src/session/runner/llm.ts:250-278`              | stream handler                                                  | event `Tool.*`                     | Gap     | No log; bus event                                         |
| `core/src/session/runner/llm.ts:289-322`              | error branches                                                  | event `Step.Failed`, `Tool.Failed` | Gap     | No log; bus event                                         |
| `core/src/session/runner/llm.ts:323-343`              | `Step.Ended`                                                    | event                              | Gap     | No log; bus event                                         |
| `core/src/session/runner/publish-llm-event.ts:74-406` | `createLLMEventPublisher`                                       | fn, events                         | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/compaction.ts:178-232`              | `compactAfterOverflow`, `compactIfNeeded`                       | fn, event                          | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/revert.ts:60-116`                   | `stage`, `clear`, `commit`                                      | fn, event                          | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/todo.ts:32`                         | `SessionTodo.update`                                            | fn, event                          | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/session/projector.ts:242-413`               | `events.project(...)`                                           | none                               | Gap     | Silent; nothing records it                                |
| `core/src/session/message-updater.ts:78`              | `update`                                                        | none                               | Gap     | Silent; nothing records it                                |

### 8. Session lifecycle, V1 (`opencode/src/session`)

Gap: 17 · Partial: 12

| Site                               | Symbol                                           | Today                      | Status  | Gap                                                       |
| ---------------------------------- | ------------------------------------------------ | -------------------------- | ------- | --------------------------------------------------------- |
| `prompt.ts:1052`                   | `SessionPrompt.prompt`                           | fn                         | Gap     | No log; span (OTLP only)                                  |
| `prompt.ts:635-679`                | `createUserMessage`, `setAgentModel`             | fn, event `Session.Error`  | Gap     | No log; span (OTLP only), bus event                       |
| `prompt.ts:705-914`                | `resolveUserPart`                                | log                        | Partial | Existing log reaches Datadog, but with category `general` |
| `prompt.ts:999`, `:1046`           | `chat.message` hook, `updateMessage`             | hook, span                 | Gap     | No log; span (OTLP only), plugin hook                     |
| `prompt.ts:1081-1128`              | `runLoop`                                        | log                        | Partial | Existing log reaches Datadog, but with category `general` |
| `prompt.ts:193`, `:1134`           | `ensureTitle`                                    | fn, log on failure         | Partial | Logs a failure branch only; success path silent           |
| `prompt.ts:255-389`                | `handleSubtask`                                  | fn, log, hooks             | Partial | Existing log reaches Datadog, but with category `general` |
| `prompt.ts:1150-1175`              | compaction triggers                              | fn                         | Gap     | No log; span (OTLP only)                                  |
| `prompt.ts:1201-1272`              | turn setup                                       | fn                         | Gap     | No log; span (OTLP only)                                  |
| `prompt.ts:1301-1321`              | outcomes                                         | event `Session.Error`      | Gap     | No log; bus event                                         |
| `prompt.ts:152`                    | `SessionPrompt.cancel`                           | fn, log                    | Partial | Existing log reaches Datadog, but with category `general` |
| `prompt.ts:451-572`                | `shellImpl`                                      | fn, event, hook            | Gap     | No log; span (OTLP only), bus event, plugin hook          |
| `prompt.ts:1356-1474`              | `SessionPrompt.command`                          | fn, `logInfo`, hook, event | Partial | Existing log reaches Datadog, but with category `general` |
| `run-state.ts:52-111`              | `runner`, `cancel`, `startShell`                 | fn, event                  | Gap     | No log; span (OTLP only), bus event                       |
| `status.ts:39`                     | `SessionStatus.set`                              | fn, event                  | Gap     | No log; span (OTLP only), bus event                       |
| `processor.ts:98`, `:641`          | `create`, `process`                              | fn, log                    | Partial | Existing log reaches Datadog, but with category `general` |
| `processor.ts:331-351`             | `tool-call`                                      | event `PartUpdated`        | Gap     | No log; bus event                                         |
| `processor.ts:358-379`             | doom-loop check                                  | event `Permission.Asked`   | Gap     | No log; bus event                                         |
| `processor.ts:383-416`             | `tool-result`, `tool-error`                      | fn, event                  | Gap     | No log; span (OTLP only), bus event                       |
| `processor.ts:295-313`, `:500-546` | text and reasoning                               | event, hook                | Gap     | No log; bus event, plugin hook                            |
| `processor.ts:553-607`             | `cleanup`                                        | fn, event                  | Gap     | No log; span (OTLP only), bus event                       |
| `processor.ts:613-638`             | `halt`                                           | fn, `logError`, event      | Partial | Existing log reaches Datadog, but with category `general` |
| `compaction.ts:203-559`            | `process`, `create`, `prune`, `isOverflow`       | fn, log, hooks, event      | Partial | Existing log reaches Datadog, but with category `general` |
| `summary.ts:82-129`                | `summarize`, `computeDiff`                       | fn, event                  | Gap     | No log; span (OTLP only), bus event                       |
| `revert.ts:38-101`                 | `revert`, `unrevert`, `cleanup`                  | fn, log, event             | Partial | Existing log reaches Datadog, but with category `general` |
| `session.ts:499-535`               | `createNext`                                     | fn, log, event             | Partial | Existing log reaches Datadog, but with category `general` |
| `session.ts:606-625`               | `remove`                                         | log on failure, event      | Partial | Logs a failure branch only; success path silent           |
| `session.ts:629`, `:635`, `:877`   | `updateMessage`, `updatePart`, `updatePartDelta` | span, event                | Gap     | No log; span (OTLP only), bus event                       |
| `todo.ts:29`                       | `Todo.update`                                    | fn, event                  | Gap     | No log; span (OTLP only), bus event                       |

### 9. Tools / V2 tool framework (`core/src/tool`)

Gap: 13

| Site                                               | Symbol                    | Today                          | Status | Gap                                         |
| -------------------------------------------------- | ------------------------- | ------------------------------ | ------ | ------------------------------------------- |
| `registry.ts:50-75`                                | `ToolRegistry.settle`     | fn (no attributes)             | Gap    | No log; span (OTLP only)                    |
| `registry.ts:85-113`                               | `register`, `materialize` | fn                             | Gap    | No log; span (OTLP only)                    |
| `tool.ts:91-105`                                   | `settle` runtime          | none                           | Gap    | Silent; nothing records it                  |
| `bash.ts:122-196`                                  | `execute`                 | none (`AppProcess.run` fn)     | Gap    | No log; span (OTLP only)                    |
| `edit.ts:109-208`                                  | `execute`                 | FileMutation fn                | Gap    | No log; span (OTLP only), file/console only |
| `write.ts:63-87`                                   | `execute`                 | FileMutation fn                | Gap    | No log; span (OTLP only), file/console only |
| `read.ts:53-72`                                    | `execute`                 | fn in `read-filesystem.ts:171` | Gap    | No log; span (OTLP only), file/console only |
| `glob.ts:60`, `grep.ts:79`                         | `execute`                 | none                           | Gap    | Silent; nothing records it                  |
| `webfetch.ts:131-149`                              | `execute`                 | none                           | Gap    | Silent; nothing records it                  |
| `websearch.ts:206-221`                             | `execute`, `callMcp`      | none                           | Gap    | Silent; nothing records it                  |
| `todowrite.ts:39`, `skill.ts:70`, `question.ts:62` | `execute`                 | none                           | Gap    | Silent; nothing records it                  |
| `apply-patch.ts:76-179`                            | `execute`                 | FileMutation fn                | Gap    | No log; span (OTLP only), file/console only |
| `application-tools.ts:43`                          | `register`                | fn                             | Gap    | No log; span (OTLP only)                    |

### 9. Tools / V1 tool framework and tools (`opencode/src`)

Gap: 14 · Partial: 2 · Captured by PR: 1

| Site                                                                         | Symbol                                                   | Today                       | Status         | Gap                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- | -------------- | --------------------------------------------------------- |
| `session/tools.ts:102-129`                                                   | AI SDK `execute`                                         | hook                        | Gap            | No log; plugin hook                                       |
| `session/tools.ts:67-89`                                                     | `ctx.metadata`, `ctx.ask`                                | event                       | Gap            | No log; bus event                                         |
| `session/tools.ts:155-381`                                                   | MCP resource tools                                       | hooks                       | Gap            | No log; plugin hook                                       |
| `session/tools.ts:398-424`                                                   | MCP tool `execute`                                       | span with attributes, hooks | Captured by PR | `MCP tool call` log, category `mcp.tool` (tools.ts:571)   |
| `tool/tool.ts:121-145`                                                       | `wrap`                                                   | span                        | Gap            | No log; span (OTLP only)                                  |
| `tool/registry.ts:143-318`                                                   | `fromPlugin`, state, `tools`                             | span, fn, hook              | Gap            | No log; span (OTLP only), plugin hook                     |
| `tool/code-mode.ts:134-274`                                                  | `invokeChildTool`, `CodeMode.execute`                    | fn, span, hooks             | Gap            | No log; span (OTLP only), plugin hook                     |
| `tool/truncate.ts:53-144`                                                    | `write`, `output`, `cleanup`                             | fn, log                     | Partial        | Existing log reaches Datadog, but with category `general` |
| `tool/external-directory.ts:15`                                              | `assertExternalDirectoryEffect`                          | fn                          | Gap            | No log; span (OTLP only)                                  |
| `tool/shell.ts:257-609`                                                      | parse, ask, `shellEnv`, run, spawn, stream, race, result | fn, log                     | Partial        | Existing log reaches Datadog, but with category `general` |
| `tool/edit.ts:69-160`, `write.ts:38-69`                                      | `execute`                                                | event                       | Gap            | No log; bus event                                         |
| `tool/read.ts:229-382`                                                       | `ReadTool.execute`                                       | fn                          | Gap            | No log; span (OTLP only)                                  |
| `tool/glob.ts:25`, `grep.ts:28`                                              | `execute`                                                | none                        | Gap            | Silent; nothing records it                                |
| `tool/webfetch.ts:33-79`, `websearch.ts:110`, `mcp-websearch.ts:70`          | `execute`                                                | fn (parse only)             | Gap            | No log; span (OTLP only)                                  |
| `tool/task.ts:92-350`                                                        | `TaskTool.execute`, `runTask`                            | fn, event                   | Gap            | No log; span (OTLP only), bus event                       |
| `tool/apply_patch.ts:30-262`                                                 | `ApplyPatchTool.execute`                                 | fn, event                   | Gap            | No log; span (OTLP only), bus event                       |
| `tool/todo.ts`, `question.ts`, `skill.ts`, `plan.ts`, `lsp.ts`, `invalid.ts` | `execute`                                                | none                        | Gap            | Silent; nothing records it                                |

### 10. Permission, question and agent

Gap: 6 · Partial: 2

| Site                                      | Symbol                        | Today                 | Status  | Gap                                                       |
| ----------------------------------------- | ----------------------------- | --------------------- | ------- | --------------------------------------------------------- |
| `core/src/permission.ts:137`, `:155`      | `configured`, `evaluateInput` | fn; evaluation silent | Gap     | No log; span (OTLP only)                                  |
| `core/src/permission.ts:176-208`          | `create`, `ask`, `assert`     | fn, event `Asked`     | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/permission.ts:220-276`          | `reply`                       | fn, event `Replied`   | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/question.ts:93-133`             | `ask`, `reply`, `reject`      | fn, event             | Gap     | No log; span (OTLP only), bus event                       |
| `core/src/agent.ts:84-102`                | `AgentV2.*`                   | fn                    | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/permission/index.ts:67-166` | `Permission.ask`, `reply`     | fn, log, event        | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/question/index.ts:87-143`   | `ask`, `reply`, `reject`      | fn, log, event        | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/agent/agent.ts:356-392`     | `get`, `list`, `generate`     | fn, hook              | Gap     | No log; span (OTLP only), plugin hook                     |

### 11. Process, shell, PTY, snapshot and file mutation

Gap: 5 · Partial: 4

| Site                                     | Symbol                                                   | Today                  | Status  | Gap                                                       |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------- | ------- | --------------------------------------------------------- |
| `core/src/process.ts:144-214`            | `runCommand`, `AppProcess.run`, `runStream`              | fn (run only)          | Gap     | No log; span (OTLP only)                                  |
| `core/src/background-job.ts:126-337`     | `start`, `settle`, `promote`, `cancel`, `wait`           | fn                     | Gap     | No log; span (OTLP only)                                  |
| `core/src/pty.ts:141-262`                | `create`, onExit, `write`, `attach`, `remove`            | fn, log, event         | Partial | Existing log reaches Datadog, but with category `general` |
| `core/src/pty/ticket.ts:43`, `:48`       | `issue`, `consume`                                       | fn                     | Gap     | No log; span (OTLP only)                                  |
| `core/src/file-mutation.ts:98-159`       | `write`, `create`, `writeIfUnchanged`, `remove`          | fn (no path attribute) | Gap     | No log; span (OTLP only)                                  |
| `core/src/tool-output-store.ts:129-176`  | `write`, `bound`, `cleanup`                              | fn                     | Gap     | No log; span (OTLP only)                                  |
| `core/src/snapshot.ts:129-219`           | `capture`, `diff`, `restore`, `checkout`                 | fn, log                | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/snapshot/index.ts:156-762` | `track`, `patch`, `restore`, `revert`, `diff`, `cleanup` | fn, ~21 log calls      | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/patch/index.ts:514-575`    | `applyHunksToFiles`, `applyPatch`                        | fn, log                | Partial | Existing log reaches Datadog, but with category `general` |

### 12. HTTP server and SSE

Gap: 6 · Partial: 9

| Site                                                                                       | Symbol                                              | Today                            | Status  | Gap                                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------- | ------- | --------------------------------------------------------- |
| `opencode/src/server/server.ts:83`, `:117`, `:157`, `:174`                                 | `listenEffect`, port fallback, mDNS, stop           | fn, console, `logWarning`        | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/server/server.ts:100-104`                                                    | `HttpRouter.serve`                                  | **none**                         | Gap     | Silent; nothing records it                                |
| `opencode/src/server/routes/instance/httpapi/server.ts:317`                                | `webHandler`                                        | none                             | Gap     | Silent; nothing records it                                |
| `.../httpapi/middleware/error.ts:7-44`                                                     | `errorLayer`                                        | `logError`                       | Partial | Existing log reaches Datadog, but with category `general` |
| `.../httpapi/middleware/schema-error.ts:25`, `server/src/middleware/schema-error.ts:16`    | schema error                                        | `logWarning`                     | Partial | Existing log reaches Datadog, but with category `general` |
| `.../httpapi/middleware/authorization.ts:40-150`, `server/src/middleware/authorization.ts` | `validateCredential`, `credentialFromURL`, PTY auth | **none**                         | Gap     | Silent; nothing records it                                |
| `.../httpapi/middleware/workspace-routing.ts`, `proxy.ts:14-134`                           | routing, proxy                                      | `logError` on 5xx only           | Partial | Logs a failure branch only; success path silent           |
| `.../httpapi/middleware/instance-context.ts`, `fence.ts`, `lifecycle.ts:43`                | instance, fence, dispose                            | `logWarning`                     | Partial | Existing log reaches Datadog, but with category `general` |
| `.../httpapi/handlers/control.ts:28-39`                                                    | `ControlHttpApi.log` (`POST /log`)                  | `Effect.log*`                    | Partial | Existing log reaches Datadog, but with category `general` |
| `.../httpapi/handlers/control.ts:13-26`                                                    | `authSet`, `authRemove`                             | fn                               | Gap     | No log; span (OTLP only)                                  |
| `.../httpapi/handlers/session.ts:319`                                                      | `prompt_async`                                      | `logError`                       | Partial | Existing log reaches Datadog, but with category `general` |
| `.../httpapi/handlers/event.ts:25-87`, `global.ts:25-60`                                   | SSE subscribe                                       | `logInfo` (no client annotation) | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/control-plane/workspace.ts:184-423`                                          | `connectSSE`, `parseSSE`                            | `logWarning`                     | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/cli/tui/worker.ts:24`                                                        | GlobalBus to RPC                                    | none                             | Gap     | Silent; nothing records it                                |
| `opencode/src/cli/cmd/run/trace.ts`                                                        | `trace()`                                           | file                             | Gap     | No log; file/console only                                 |

### 13. MCP and LSP

Gap: 3 · Partial: 4

| Site                                                                                     | Symbol                                              | Today                       | Status  | Gap                                                                           |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------- | ------- | ----------------------------------------------------------------------------- |
| `opencode/src/mcp/index.ts:218-370`                                                      | `connectTransport`, `connectRemote`, `connectLocal` | fn, toast event             | Gap     | No log; span (OTLP only), bus event                                           |
| `opencode/src/mcp/index.ts:372-490`                                                      | `create`, `watch`, `serverLog`, tool list changed   | `logWarning`, `log*`, event | Partial | Existing log reaches Datadog, but with category `general`                     |
| `opencode/src/mcp/index.ts:493-766`                                                      | `state`, `status`, `tools`, `withClient`            | `logError`, `logWarning`    | Partial | Existing log reaches Datadog, but with category `general`                     |
| `opencode/src/mcp/index.ts:806-970`, `auth.ts`, `oauth-provider.ts`, `oauth-callback.ts` | OAuth flow and token store                          | fn, event                   | Gap     | No log; span (OTLP only), bus event                                           |
| `opencode/src/mcp/catalog.ts:38-110`                                                     | `defs`, `listTools`, `convertTool`, `fetch`         | `logWarning`                | Partial | Tool call captured by the PR (`mcp.tool`); `listTools` errors still swallowed |
| `opencode/src/lsp/lsp.ts:146-480`                                                        | `state`, `schedule`, `touchFile`, requests          | `logInfo`, fn               | Partial | Existing log reaches Datadog, but with category `general`                     |
| `opencode/src/lsp/client.ts:123-640`                                                     | `create`, handlers, waits, `shutdown`               | none                        | Gap     | Silent; nothing records it                                                    |

### 14. Plugins

Gap: 4 · Partial: 1

| Site                                                              | Symbol                  | Today                      | Status  | Gap                                                       |
| ----------------------------------------------------------------- | ----------------------- | -------------------------- | ------- | --------------------------------------------------------- |
| `opencode/src/plugin/index.ts:134-282`                            | `Plugin.state`          | fn, `logError`             | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/plugin/index.ts:186-218`                            | loader report callbacks | event `session.error`      | Gap     | No log; bus event                                         |
| `opencode/src/plugin/loader.ts:86-208`, `install.ts`, `shared.ts` | resolve, load, install  | none                       | Gap     | Silent; nothing records it                                |
| `opencode/src/plugin/tui/runtime.ts:130`                          | TUI plugin runtime      | `console.error`            | Gap     | No log; file/console only                                 |
| `core/src/plugin.ts:42-80`, `plugin/internal.ts:108`              | `PluginV2.add`, `boot`  | span, event `plugin.added` | Gap     | No log; span (OTLP only), bus event                       |

### 15. Configuration, storage, sync, share and workspaces

Gap: 2 · Partial: 6

| Site                                                                 | Symbol                                                                                     | Today                                               | Status  | Gap                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------- | --------------------------------------------------------- |
| `opencode/src/config/config.ts:188-660`                              | `decodeConfig`, `fetchRemoteJson`, `loadFile`, `loadGlobal`, `loadInstanceState`, `update` | `logInfo`, `logDebug`, `logWarning`, `logError`, fn | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/config/tui.ts:83-259`, `core/src/config.ts:150-221`    | TUI config; V2 config entries and migration                                                | log, fn                                             | Partial | Existing log reaches Datadog, but with category `general` |
| `core/src/database/database.ts:22-55`, `migration.ts:18-108`         | database layer, migrations                                                                 | none                                                | Gap     | Silent; nothing records it                                |
| `opencode/src/storage/storage.ts:82-301`                             | migrations, key I/O                                                                        | log, fn                                             | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/server/routes/instance/httpapi/handlers/sync.ts:27-89` | sync handlers                                                                              | `logInfo`                                           | Partial | Existing log reaches Datadog, but with category `general` |
| `core/src/control-plane/move-session.ts:77`                          | `moveSession`                                                                              | fn                                                  | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/share/share-next.ts:150-340`                           | `state`, `request`, `flush`, `create`, `remove`                                            | log, fn                                             | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/control-plane/workspace.ts:270-860`                    | sync loop, `create`, `sessionWarp`, lifecycle                                              | `logWarning`, `logError`                            | Partial | Existing log reaches Datadog, but with category `general` |

### 16. CLI, bootstrap, installation, git, skills and ACP

Gap: 7 · Partial: 6

| Site                                                                                        | Symbol                                     | Today                   | Status  | Gap                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------- | ------- | --------------------------------------------------------- |
| `opencode/src/index.ts:53-78`                                                               | yargs middleware                           | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/index.ts:104-141`                                                             | `.fail`, top-level catch                   | stderr only             | Gap     | No log; file/console only                                 |
| `opencode/src/cli/effect-cmd.ts:69-110`                                                     | `effectCmd`                                | fn `Cli.<name>`         | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/cli/tui/worker.ts:16-77`                                                      | worker handlers, RPC                       | none                    | Gap     | Silent; nothing records it                                |
| `opencode/src/cli/heap.ts:12-40`                                                            | `Heap.start`                               | file                    | Gap     | No log; file/console only                                 |
| `opencode/src/project/bootstrap.ts:32-46`                                                   | `InstanceBootstrap.run`                    | log, fn                 | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/project/instance-store.ts:63-185`                                             | `boot`, `load`, `reload`, `dispose`        | log, fn                 | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/installation/index.ts:168-320`, `cli/upgrade.ts`                              | `latest`, `upgrade`                        | fn, `logInfo`, event    | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/git/index.ts:110-322`, `core/src/git.ts:184-912`                              | `Git.run` and ops                          | fn                      | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/worktree/index.ts:175-606`, `project/project.ts`, `project/vcs.ts`            | worktree, project, VCS                     | log, fn, event          | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/skill/index.ts:104-310`, `skill/discovery.ts`, `core/src/skill/discovery.ts`  | skill load and discovery                   | log, event              | Partial | Existing log reaches Datadog, but with category `general` |
| `opencode/src/command/index.ts:65-166`                                                      | `Command.state`                            | fn                      | Gap     | No log; span (OTLP only)                                  |
| `opencode/src/acp/service.ts:94-839`, `acp/event.ts`, `acp/permission.ts`, `acp/profile.ts` | ACP requests, events, permissions, profile | fn, `logError`, console | Partial | Existing log reaches Datadog, but with category `general` |

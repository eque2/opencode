# Logging coverage

This document checks every site in [`logging-sites.md`](./logging-sites.md) against the Datadog logging in pull request [#1](https://github.com/eque2/opencode/pull/1). For each site it names the record that reaches Datadog.

The check was made on 2026-09-29 against branch `datadog-logging`. A script found each site's symbol in the current code and looked for a span, a log call, a bus publish or a `Telemetry` call next to it. Each site with no mechanism next to it was then checked by hand and given the enclosing record that captures it, or a reason for exclusion.

## Summary

| Status    |   Sites | Meaning                                                                                                                                           |
| --------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captured  |     201 | A record is written at the site: a categorised log, a span-bridge record, a bus-tap record or a `Telemetry` record.                               |
| Enclosed  |      54 | The site has no record of its own. An enclosing record captures its outcome, for example the `LLM.stream` span or the `ToolRegistry.settle` span. |
| Excluded  |       4 | The site handles secrets, or it is an opt-in local trace of prompt content.                                                                       |
| n/a       |       2 | A mount point, not an event.                                                                                                                      |
| Gap       |       0 | No record.                                                                                                                                        |
| **Total** | **261** |                                                                                                                                                   |

## How the records reach Datadog

| Mechanism        | Code                                                 | What it records                                                                                                                            | Switch                        |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| Span bridge      | `core/src/observability/telemetry.ts` `bridge`       | One record per ended `Effect.fn` or `withSpan` span: name, duration, outcome, attributes, and the error at `Warn`                          | `OPENCODE_DATADOG_SPANS`      |
| Bus tap          | `telemetry.ts` `event`, called in `EventV2` `notify` | One record per V1 or V2 event: type, IDs, durable position, token counts; never the event data                                             | `OPENCODE_DATADOG_EVENTS`     |
| Categorised log  | `Effect.log*` at the site                            | A log without a `category` annotation takes the domain of its enclosing span                                                               | `OPENCODE_DATADOG_CATEGORIES` |
| Telemetry record | `telemetry.ts` `record`, `request`, `accessLog`      | Records from Promise edges and fresh runtimes: fetch wrappers, the HTTP access log, the plugin loader, the TUI worker and fatal CLI errors | none                          |

The span-bridge, bus-tap and Telemetry records go to the Datadog sink only, so the local log file does not grow. Per-chunk protocol spans (`llm.chunk`) and per-token events (`bus.delta`) are off by default. The `question` and `pty` categories stay excluded unless the env var re-includes them.

## Main records added by the PR

| Category                                 | Where                                                                  | Content                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `llm.<span>` `LLM.stream`                | `llm/src/route/client.ts`                                              | One span per native LLM call: provider, model, route, protocol, duration, outcome  |
| `llm.usage`, `llm.error`                 | `client.ts` `recordEvent`, `opencode/src/session/llm.ts` `recordEvent` | Tokens per step and finish, Copilot nano-AIU, provider error classification        |
| `llm.<span>` `LLM.http`, `llm.retry`     | `llm/src/route/executor.ts`                                            | One span per HTTP attempt (method, host, status, reason); each retry               |
| `llm.request`, `llm.timeout`             | `core/src/aisdk.ts`, `opencode/src/provider/provider.ts`               | Each AI SDK HTTP call (method, host, status, duration); SSE and header timeouts    |
| `llm.prompt`, `llm.repair`, `llm.cost`   | `session/llm.ts`, `session/processor.ts`                               | Prompt shape (message and tool counts), tool-call repair, cost and tokens per step |
| `session.retry`, `session.idle`          | `session/retry.ts`, `core/src/session/run-coordinator.ts`              | Retry and give-up; one span per V2 drain; session idle                             |
| `mcp.tool`, `mcp.connect`, `mcp.tools`   | `session/tools.ts`, `mcp/index.ts`, `mcp/catalog.ts`                   | MCP tool calls, transport results, tool list failures                              |
| `http.request`, `http.auth`              | `telemetry.ts` `accessLog`, authorization middlewares                  | Access log (method, path, status, duration), 401s                                  |
| `auth.refresh`                           | `core/src/integration.ts`                                              | Each OAuth refresh                                                                 |
| `provider.state`, `provider.discovery`   | `provider/provider.ts`, `github-copilot/copilot.ts`                    | Resolved providers and their sources; discovery failures                           |
| `lsp.spawn`, `lsp.stderr`                | `lsp/lsp.ts`, `lsp/client.ts`                                          | Spawn and initialise failures; server stderr                                       |
| `plugin.load`, `plugin.event`            | `plugin/index.ts`                                                      | Loader stages and failures; failed event hooks                                     |
| `cli.fatal`, `cli.worker`, `cli.upgrade` | `index.ts`, `cli/tui/worker.ts`                                        | Fatal CLI errors, TUI worker crashes, failed update checks                         |

## Limits

- **Enclosed sites** record the outcome of the enclosing operation, not the detail of the site. For example, a WebSocket close code and the base prompt name are not recorded.
- **No content.** Prompts, completions, tool input and output, file content and answers stay out of every new record. Operators widen this only through `OPENCODE_DATADOG_CONTENT` for existing logs.
- **Volume.** The span bridge sends about one record for each `Effect.fn` call. Use `OPENCODE_DATADOG_CATEGORIES` to exclude noisy domains, or `OPENCODE_DATADOG_SPANS=false` to turn it off.
- **Line numbers** come from the catalogue and drift.

## Every site

### 1. Central tap points

Captured: 9 · Enclosed: 3 · n/a: 2

| Site                                        | Symbol                            | Status   | Captured by                                                                            |
| ------------------------------------------- | --------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `core/src/event.ts:419`                     | `EventV2.publish`                 | Captured | bus tap                                                                                |
| `core/src/event.ts:369`                     | `publishEvent`                    | Captured | categorised log, bus tap                                                               |
| `core/src/event.ts:406`                     | `notify`                          | Captured | Telemetry record, categorised log, bus tap                                             |
| `core/src/event.ts:136`, `:152`             | `listen`, `allBounded`            | Enclosed | Every event a listener sees passes `notify`, where the bus tap records it              |
| `opencode/src/event-v2-bridge.ts:19`, `:35` | `EventV2Bridge.publish`, listener | Enclosed | A V1 publish goes through `EventV2.publish` and `notify`, where the bus tap records it |
| `opencode/src/bus/global.ts:14`             | `GlobalBusEmitter.emit`           | Enclosed | Every event it re-emits was recorded by the bus tap in `notify`                        |
| `opencode/src/plugin/index.ts:284`          | `Plugin.trigger`                  | Captured | span bridge                                                                            |
| `opencode/src/plugin/index.ts:255`          | plugin `event` fan-out            | Captured | Telemetry record, categorised log, span bridge                                         |
| `llm/src/route/client.ts:417`               | `LLMClient` layer                 | n/a      | Mount point, not an event                                                              |
| `opencode/src/provider/provider.ts:1804`    | `resolveSDK` fetch wrapper        | Captured | `Telemetry.request` in `timeoutFetch` (`llm.request`) and timeouts (`llm.timeout`)     |
| `core/src/aisdk.ts:85`                      | `prepareOptions` fetch wrapper    | Captured | Telemetry.request in the `request` fetch wrapper (`llm.request`)                       |
| `core/src/tool/registry.ts:50`              | `ToolRegistry.settle`             | Captured | span bridge                                                                            |
| `opencode/src/tool/tool.ts:113`             | `wrap` / `execute`                | Captured | span bridge                                                                            |
| `core/src/observability.ts:11`              | `Observability.layer`             | n/a      | Mount point, not an event                                                              |

### 2. LLM runtime (`llm/src`) / Public API and client

Captured: 8 · Enclosed: 2

| Site                                  | Symbol                  | Status   | Captured by                                                      |
| ------------------------------------- | ----------------------- | -------- | ---------------------------------------------------------------- |
| `llm/src/llm.ts:53`                   | `request`               | Captured | span bridge                                                      |
| `llm/src/llm.ts:110`                  | `runGenerateObject`     | Captured | span bridge                                                      |
| `llm/src/route/client.ts:167`         | `resolveRequestOptions` | Captured | span bridge                                                      |
| `llm/src/route/client.ts:344`         | `compile`               | Captured | span bridge, categorised log                                     |
| `llm/src/route/client.ts:361`         | `prepareWith`           | Captured | categorised log, span bridge                                     |
| `llm/src/route/client.ts:374`         | `streamRequestWith`     | Captured | categorised log, span bridge                                     |
| `llm/src/route/client.ts:279`         | `route.streamPrepared`  | Captured | categorised log, span bridge                                     |
| `llm/src/route/client.ts:232`         | `decodeEvent`           | Enclosed | A decode failure fails the `LLM.stream` span (outcome and error) |
| `llm/src/route/client.ts:220`, `:293` | `streamError`           | Enclosed | The mapped `LLMError` fails the `LLM.stream` span                |
| `llm/src/route/client.ts:382`         | `generateWith`          | Captured | span bridge                                                      |

### 2. LLM runtime (`llm/src`) / Transport, executor and auth

Captured: 5 · Enclosed: 7 · Excluded: 3

| Site                                                          | Symbol                       | Status   | Captured by                                                                        |
| ------------------------------------------------------------- | ---------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `llm/src/route/executor.ts:370`                               | `executeOnce`                | Captured | span bridge                                                                        |
| `llm/src/route/executor.ts:277`                               | `statusError`                | Captured | span bridge                                                                        |
| `llm/src/route/executor.ts:225`                               | `statusReason`               | Enclosed | The reason is the `llm.reason` attribute on the `LLM.http` span                    |
| `llm/src/route/executor.ts:307`                               | `toHttpError`                | Captured | span bridge                                                                        |
| `llm/src/route/executor.ts:353`                               | `retryStatusFailures`        | Captured | categorised log, span bridge                                                       |
| `llm/src/route/executor.ts:112`                               | `rateLimitDetails`           | Enclosed | Rate-limit details travel in the `LLMError` on the failed `LLM.http` span          |
| `llm/src/route/executor.ts:41-202`                            | redaction helpers            | Captured | categorised log, span bridge                                                       |
| `llm/src/route/transport/http.ts:88`                          | `jsonRequestParts`           | Enclosed | Inside `LLM.compile`; the URL host is on the `LLM.http` span, the path stays out   |
| `llm/src/route/transport/http.ts:130`                         | `httpJson.frames`            | Enclosed | The `LLM.http` span records status and duration; read errors fail `LLM.stream`     |
| `llm/src/route/auth.ts:151`, `:137`                           | `toEffect`, `toLLMError`     | Enclosed | A missing credential fails the `LLM.compile` span                                  |
| `llm/src/route/auth.ts:65`                                    | `fromCredential`             | Excluded | Secret material; must not be logged                                                |
| `llm/src/route/transport/websocket.ts:125`, `:52`, `:146-173` | `open`, `waitOpen`, handlers | Enclosed | Connect and socket errors fail the `LLM.stream` span; close codes are not recorded |
| `llm/src/route/transport/websocket.ts:229`, `:257`            | `json.prepare`, `frames`     | Enclosed | Inside the `LLM.stream` span; the request JSON is content and stays out            |
| `llm/src/route/endpoint.ts:47`                                | `render`                     | Excluded | The URL can carry a key; the `LLM.http` span records the host only                 |
| `llm/src/protocols/utils/bedrock-auth.ts:48`                  | `sigV4`                      | Excluded | AWS credentials; must not be logged                                                |

### 2. LLM runtime (`llm/src`) / Protocols, providers and utilities

Captured: 10 · Enclosed: 12

| Site                                                           | Symbol                                                     | Status   | Captured by                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `llm/src/protocols/utils/lifecycle.ts:80`                      | `Lifecycle.finish`                                         | Enclosed | Its `step-finish` and `finish` events are logged by `recordEvent` (`llm.usage`)            |
| `llm/src/protocols/shared.ts:90`                               | `eventError`                                               | Captured | span bridge                                                                                |
| `llm/src/protocols/shared.ts:242`                              | `sseFraming`                                               | Enclosed | SSE decode errors fail the `LLM.stream` span                                               |
| `llm/src/protocols/anthropic-messages.ts:506`, `:535`          | `fromRequest`                                              | Captured | categorised log, span bridge                                                               |
| `llm/src/protocols/anthropic-messages.ts:652`, `:782`          | `onMessageStart`, `onMessageDelta`                         | Enclosed | Usage and stop reason reach the `finish` event, logged as `llm.usage`                      |
| `llm/src/protocols/anthropic-messages.ts:804`, `:814`          | `onError`, `step`                                          | Enclosed | The `provider-error` event is logged as `llm.error` with its classification                |
| `llm/src/protocols/anthropic-messages.ts:703`, `:763`          | content-block handlers                                     | Captured | categorised log, span bridge                                                               |
| `llm/src/protocols/openai-chat.ts:344`, `:391`, `:407`, `:462` | `fromRequest`, `mapUsage`, `step`, `finishEvents`          | Captured | span bridge                                                                                |
| `llm/src/protocols/openai-responses.ts:478`, `:507`, `:875`    | `fromRequest`, `mapUsage`, `onResponseFinish`              | Captured | span bridge                                                                                |
| `llm/src/protocols/openai-responses.ts:904-975`                | `providerError`, `onResponseFailed`, `onError`, `terminal` | Enclosed | The `provider-error` event is logged as `llm.error`; a terminal failure fails `LLM.stream` |
| `llm/src/protocols/openai-responses.ts:789`, `:808`            | argument deltas, output item done                          | Captured | span bridge                                                                                |
| `llm/src/protocols/gemini.ts:302`, `:342`, `:363`, `:399`      | `fromRequest`, `mapUsage`, `mapFinishReason`, `step`       | Captured | span bridge                                                                                |
| `llm/src/protocols/bedrock-converse.ts:388`, `:401`            | `fromRequest`                                              | Captured | categorised log, span bridge                                                               |
| `llm/src/protocols/bedrock-converse.ts:443-618`                | `mapUsage`, `step`, exceptions, `onHalt`                   | Enclosed | Usage reaches `finish` (`llm.usage`); exceptions reach `provider-error` (`llm.error`)      |
| `llm/src/protocols/bedrock-event-stream.ts:47-82`              | `framing`                                                  | Enclosed | Frame decode failures fail the `LLM.stream` span                                           |
| `llm/src/protocols/utils/tool-stream.ts:127-200`               | tool input assembly                                        | Enclosed | Tool input errors fail `LLM.stream`; the dispatch runs in the `LLM.tool` span              |
| `llm/src/provider-error.ts:36`, `:40`                          | `isContextOverflow*`                                       | Enclosed | The classification is on the `llm.error` record                                            |
| `llm/src/cache-policy.ts:99`                                   | `applyCachePolicy`                                         | Enclosed | Runs inside the `LLM.compile` span                                                         |
| `llm/src/tool-runtime.ts:23-63`                                | `dispatch`, `decodeAndExecute`, `result`                   | Captured | span bridge                                                                                |
| `llm/src/tool.ts:221`                                          | `toDefinitions`                                            | Enclosed | Runs inside the `LLM.compile` span; the tool count is on the `llm.prompt` record           |
| `llm/src/providers/*.ts` (`auth`, `configure`)                 | provider routes                                            | Captured | span bridge                                                                                |
| `llm/src/providers/github-copilot.ts:19`, `:49`                | `shouldUseResponsesApi`                                    | Enclosed | The chosen route and protocol are attributes of the `LLM.stream` span                      |

### 3. Session LLM turn (`opencode/src/session/llm*`, V1)

Captured: 12 · Enclosed: 6

| Site                                                             | Symbol                                 | Status   | Captured by                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `opencode/src/session/llm.ts:85`                                 | `LLM.run`                              | Captured | categorised log, span bridge                                                                                 |
| `opencode/src/session/llm.ts:95`                                 | `run`                                  | Captured | categorised log, span bridge                                                                                 |
| `opencode/src/session/llm.ts:127-187`                            | GitLab executors                       | Captured | categorised log, span bridge                                                                                 |
| `opencode/src/session/llm.ts:226-275`                            | runtime selection                      | Captured | categorised log, span bridge                                                                                 |
| `opencode/src/session/llm.ts:281`                                | `streamText.onError`                   | Captured | categorised log                                                                                              |
| `opencode/src/session/llm.ts:296`                                | `experimental_repairToolCall`          | Captured | categorised log                                                                                              |
| `opencode/src/session/llm.ts:330`                                | `transformParams` middleware           | Captured | categorised log                                                                                              |
| `opencode/src/session/llm.ts:344`                                | `experimental_telemetry`               | Captured | span bridge                                                                                                  |
| `opencode/src/session/llm.ts:357-378`                            | `stream`                               | Captured | categorised log, span bridge                                                                                 |
| `opencode/src/session/llm/request.ts:58-78`                      | `prepare`                              | Captured | span bridge                                                                                                  |
| `opencode/src/session/llm/request.ts:99`, `:114`, `:134`         | `prepare`                              | Captured | span bridge                                                                                                  |
| `opencode/src/session/llm/request.ts:148`, `:165`                | `resolveTools`                         | Enclosed | Runs inside the `LLMRequestPrep.prepare` span; the tool count is on `llm.prompt`                             |
| `opencode/src/session/llm/request.ts:181-204`                    | return value                           | Captured | span bridge                                                                                                  |
| `opencode/src/session/llm/native-runtime.ts:74-121`              | `stream`                               | Enclosed | The native call runs in the `LLM.stream` span with usage records                                             |
| `opencode/src/session/llm/native-runtime.ts:178-188`             | `nativeTools.execute`                  | Enclosed | Each tool runs in the `LLM.tool` span and the V1 `Tool.execute` span                                         |
| `opencode/src/session/llm/native-request.ts:153`, `:181`         | `model`, `request`                     | Enclosed | The mapped route and model are attributes of the `LLM.stream` span                                           |
| `opencode/src/session/llm/ai-sdk.ts:88-112`                      | `finish-step`                          | Enclosed | Each `step-finish` is logged by `recordEvent` in session/llm.ts (`llm.usage`)                                |
| `opencode/src/session/llm/ai-sdk.ts:114`, `:252`, `:267`, `:277` | `finish`, `tool-error`, `error`, `raw` | Enclosed | `finish` and `tool-error` are logged by `recordEvent`; `error` fails `LLM.aisdk`; nano-AIU is on `llm.usage` |

### 4. Usage, cost, retry and errors

Captured: 4 · Enclosed: 4

| Site                                               | Symbol                                  | Status   | Captured by                                                              |
| -------------------------------------------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `opencode/src/session/processor.ts:435-497`        | `step-finish`                           | Captured | categorised log, span bridge, bus tap                                    |
| `opencode/src/session/processor.ts:674-686`        | `Effect.retry(SessionRetry.policy)`     | Enclosed | Each retry and the give-up are logged in retry.ts (`session.retry`)      |
| `opencode/src/session/processor.ts:421`            | `provider-error`                        | Captured | categorised log, span bridge, bus tap                                    |
| `opencode/src/session/retry.ts:85`, `:183`, `:196` | `retryable`, `policy`                   | Captured | categorised log                                                          |
| `opencode/src/session/session.ts:338`              | `getUsage`                              | Enclosed | The processor logs each step's cost and tokens (`llm.cost`)              |
| `opencode/src/session/message-v2.ts:610`           | `fromError`                             | Enclosed | The mapped error is logged by the processor `halt` and fails `LLM.aisdk` |
| `opencode/src/provider/error.ts:102`, `:172`       | `parseStreamError`, `parseAPICallError` | Enclosed | The parsed error is logged by the processor `halt` and fails `LLM.aisdk` |
| `core/src/session/runner/llm.ts:333`               | `Step.Ended`                            | Captured | bus tap                                                                  |

### 5. Provider, model and credentials

Captured: 22 · Enclosed: 1

| Site                                                      | Symbol                                                                               | Status   | Captured by                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `opencode/src/provider/provider.ts:1400-1730`             | `state`                                                                              | Captured | Telemetry record, categorised log, span bridge                                      |
| `opencode/src/provider/provider.ts:733`, `:1667`          | GitLab discovery                                                                     | Captured | Telemetry record, categorised log, span bridge                                      |
| `opencode/src/provider/provider.ts:174-1000`              | `custom()` loaders                                                                   | Captured | categorised log                                                                     |
| `opencode/src/provider/provider.ts:1734`, `:1864`         | `resolveSDK`                                                                         | Captured | span bridge                                                                         |
| `opencode/src/provider/provider.ts:37`, `:85`             | `wrapSSE`, `timeoutController`                                                       | Captured | Telemetry record                                                                    |
| `opencode/src/provider/provider.ts:1868-2008`             | `getProvider`, `getModel`, `getLanguage`, `closest`, `getSmallModel`, `defaultModel` | Captured | span bridge                                                                         |
| `opencode/src/provider/auth.ts:131`, `:163`, `:188`       | `methods`, `authorize`, `callback`                                                   | Captured | span bridge                                                                         |
| `opencode/src/provider/transform.ts:465-1562`             | `message`, `options`, `schema`, …                                                    | Enclosed | Runs inside `LLMRequestPrep.prepare` and the `llm.prompt` record; content stays out |
| `core/src/aisdk.ts:26`, `:198`                            | `wrapSSE`, `language`                                                                | Captured | Telemetry record, span bridge                                                       |
| `core/src/models-dev.ts:175-250`                          | `fetchApi`, `refresh`                                                                | Captured | span bridge, categorised log, bus tap                                               |
| `core/src/credential.ts:67-131`                           | CRUD                                                                                 | Captured | span bridge                                                                         |
| `core/src/integration.ts:385-401`                         | `connection.resolve`                                                                 | Captured | categorised log, span bridge                                                        |
| `core/src/integration.ts:404-484`                         | connection lifecycle                                                                 | Captured | categorised log, span bridge, bus tap                                               |
| `core/src/plugin/provider/openai.ts:209`, `:221`          | `refresh`, `request`                                                                 | Captured | span bridge                                                                         |
| `core/src/plugin/provider/opencode.ts:64`, `:104`         | `refresh`, config load                                                               | Captured | span bridge, categorised log                                                        |
| `opencode/src/plugin/openai/codex.ts:135`, `:350`         | `refreshAccessToken`, `fetch`                                                        | Captured | span bridge                                                                         |
| `opencode/src/plugin/xai.ts:77`, `:244`                   | refresh, fetch                                                                       | Captured | span bridge                                                                         |
| `opencode/src/plugin/snowflake-cortex.ts:136`, `:445`     | refresh, fetch                                                                       | Captured | span bridge                                                                         |
| `opencode/src/plugin/github-copilot/copilot.ts:96-176`    | `auth.loader` fetch                                                                  | Captured | span bridge                                                                         |
| `opencode/src/plugin/github-copilot/copilot.ts:62`, `:86` | `provider.models`                                                                    | Captured | categorised log, span bridge                                                        |
| `opencode/src/plugin/github-copilot/copilot.ts:222-262`   | `authorize`, `callback`                                                              | Captured | span bridge, categorised log                                                        |
| `core/src/github-copilot/**/*-language-model.ts`          | `getArgs`, `doGenerate`, `doStream`, `flush`                                         | Captured | span bridge                                                                         |
| `core/src/session/runner/model.ts:83-211`                 | `apiKey`, `resolve`                                                                  | Captured | span bridge                                                                         |

### 6. System prompt and context

Captured: 6 · Enclosed: 2

| Site                                                | Symbol                                                 | Status   | Captured by                                                                      |
| --------------------------------------------------- | ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------- |
| `opencode/src/session/system.ts:28`                 | `provider`                                             | Enclosed | Runs inside `LLMRequestPrep.prepare`; the prompt name is not recorded            |
| `opencode/src/session/system.ts:69`, `:107`, `:121` | `environment`, `skills`, `mcp`                         | Captured | span bridge                                                                      |
| `opencode/src/session/instruction.ts:95-179`        | `systemPaths`, `system`, `fetch`, `resolve`            | Captured | span bridge                                                                      |
| `opencode/src/session/prompt.ts:1255-1271`          | loop body                                              | Captured | categorised log, span bridge, bus tap                                            |
| `core/src/system-context/index.ts:139-314`          | `make`, `combine`, `initialize`, `reconcile`, `render` | Enclosed | Runs inside the `SessionContextEpoch` spans; `ContextUpdated` passes the bus tap |
| `core/src/system-context/registry.ts:25`, `:39`     | `register`, `load`                                     | Captured | span bridge                                                                      |
| `core/src/instruction-context.ts:40-99`             | `observe`, `render`                                    | Captured | span bridge                                                                      |
| `core/src/session/context-epoch.ts:28-111`          | `initialize`, `prepare`, `reset`                       | Captured | span bridge, bus tap                                                             |

### 7. Session lifecycle, V2 (`core/src/session`)

Captured: 17 · Enclosed: 2

| Site                                                  | Symbol                                                          | Status   | Captured by                               |
| ----------------------------------------------------- | --------------------------------------------------------------- | -------- | ----------------------------------------- |
| `core/src/session.ts:208`                             | `V2Session.create`                                              | Captured | span bridge, bus tap                      |
| `core/src/session.ts:360-382`                         | `V2Session.prompt`                                              | Captured | span bridge, bus tap                      |
| `core/src/session.ts:393-449`                         | `switchAgent`, `switchModel`, `resume`, `interrupt`, `revert.*` | Captured | span bridge, bus tap                      |
| `core/src/session/input.ts:41`                        | `SessionInput.admit`                                            | Captured | span bridge, bus tap                      |
| `core/src/session/input.ts:216-268`                   | `publish`, `promoteSteers`, `promoteNextQueued`                 | Captured | span bridge, bus tap                      |
| `core/src/session/execution/local.ts:17-25`           | `drain`, `tapCause`                                             | Captured | categorised log                           |
| `core/src/session/run-coordinator.ts:37-94`           | `start`, `run`, `wake`, `interrupt`, `settle`                   | Captured | span bridge, categorised log              |
| `core/src/session/runner/llm.ts:390`                  | `SessionRunner.run`                                             | Captured | span bridge                               |
| `core/src/session/runner/llm.ts:119`                  | `failInterruptedTools`                                          | Captured | span bridge, bus tap                      |
| `core/src/session/runner/llm.ts:173-239`              | `runTurnAttempt`                                                | Captured | span bridge                               |
| `core/src/session/runner/llm.ts:250-278`              | stream handler                                                  | Captured | span bridge, bus tap                      |
| `core/src/session/runner/llm.ts:289-322`              | error branches                                                  | Captured | span bridge, bus tap                      |
| `core/src/session/runner/llm.ts:323-343`              | `Step.Ended`                                                    | Captured | bus tap                                   |
| `core/src/session/runner/publish-llm-event.ts:74-406` | `createLLMEventPublisher`                                       | Captured | bus tap                                   |
| `core/src/session/compaction.ts:178-232`              | `compactAfterOverflow`, `compactIfNeeded`                       | Captured | span bridge, bus tap                      |
| `core/src/session/revert.ts:60-116`                   | `stage`, `clear`, `commit`                                      | Captured | span bridge, bus tap                      |
| `core/src/session/todo.ts:32`                         | `SessionTodo.update`                                            | Captured | span bridge, bus tap                      |
| `core/src/session/projector.ts:242-413`               | `events.project(...)`                                           | Enclosed | Every projected event passes the bus tap  |
| `core/src/session/message-updater.ts:78`              | `update`                                                        | Enclosed | Every event it reduces passes the bus tap |

### 8. Session lifecycle, V1 (`opencode/src/session`)

Captured: 29

| Site                               | Symbol                                           | Status   | Captured by                           |
| ---------------------------------- | ------------------------------------------------ | -------- | ------------------------------------- |
| `prompt.ts:1052`                   | `SessionPrompt.prompt`                           | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:635-679`                | `createUserMessage`, `setAgentModel`             | Captured | span bridge, categorised log          |
| `prompt.ts:705-914`                | `resolveUserPart`                                | Captured | categorised log, span bridge          |
| `prompt.ts:999`, `:1046`           | `chat.message` hook, `updateMessage`             | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:1081-1128`              | `runLoop`                                        | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:193`, `:1134`           | `ensureTitle`                                    | Captured | span bridge                           |
| `prompt.ts:255-389`                | `handleSubtask`                                  | Captured | categorised log, span bridge          |
| `prompt.ts:1150-1175`              | compaction triggers                              | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:1201-1272`              | turn setup                                       | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:1301-1321`              | outcomes                                         | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:152`                    | `SessionPrompt.cancel`                           | Captured | categorised log, span bridge, bus tap |
| `prompt.ts:451-572`                | `shellImpl`                                      | Captured | span bridge, categorised log, bus tap |
| `prompt.ts:1356-1474`              | `SessionPrompt.command`                          | Captured | span bridge, categorised log, bus tap |
| `run-state.ts:52-111`              | `runner`, `cancel`, `startShell`                 | Captured | span bridge                           |
| `status.ts:39`                     | `SessionStatus.set`                              | Captured | span bridge, bus tap                  |
| `processor.ts:98`, `:641`          | `create`, `process`                              | Captured | span bridge, categorised log, bus tap |
| `processor.ts:331-351`             | `tool-call`                                      | Captured | categorised log, span bridge, bus tap |
| `processor.ts:358-379`             | doom-loop check                                  | Captured | categorised log, span bridge, bus tap |
| `processor.ts:383-416`             | `tool-result`, `tool-error`                      | Captured | categorised log, span bridge, bus tap |
| `processor.ts:295-313`, `:500-546` | text and reasoning                               | Captured | categorised log, span bridge, bus tap |
| `processor.ts:553-607`             | `cleanup`                                        | Captured | span bridge                           |
| `processor.ts:613-638`             | `halt`                                           | Captured | categorised log, span bridge, bus tap |
| `compaction.ts:203-559`            | `process`, `create`, `prune`, `isOverflow`       | Captured | span bridge, categorised log, bus tap |
| `summary.ts:82-129`                | `summarize`, `computeDiff`                       | Captured | span bridge, bus tap                  |
| `revert.ts:38-101`                 | `revert`, `unrevert`, `cleanup`                  | Captured | span bridge, bus tap, categorised log |
| `session.ts:499-535`               | `createNext`                                     | Captured | categorised log, span bridge, bus tap |
| `session.ts:606-625`               | `remove`                                         | Captured | categorised log, span bridge, bus tap |
| `session.ts:629`, `:635`, `:877`   | `updateMessage`, `updatePart`, `updatePartDelta` | Captured | categorised log, span bridge, bus tap |
| `todo.ts:29`                       | `Todo.update`                                    | Captured | span bridge, bus tap                  |

### 9. Tools / V2 tool framework (`core/src/tool`)

Captured: 3 · Enclosed: 10

| Site                                               | Symbol                    | Status   | Captured by                                                                          |
| -------------------------------------------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `registry.ts:50-75`                                | `ToolRegistry.settle`     | Captured | span bridge                                                                          |
| `registry.ts:85-113`                               | `register`, `materialize` | Captured | span bridge                                                                          |
| `tool.ts:91-105`                                   | `settle` runtime          | Enclosed | Runs inside the `ToolRegistry.settle` span (tool name, call ID, tool.failed)         |
| `bash.ts:122-196`                                  | `execute`                 | Enclosed | `ToolRegistry.settle` span and the `AppProcess.run` span; command text stays out     |
| `edit.ts:109-208`                                  | `execute`                 | Enclosed | `ToolRegistry.settle` span and the `FileMutation` spans                              |
| `write.ts:63-87`                                   | `execute`                 | Enclosed | `ToolRegistry.settle` span and the `FileMutation` spans                              |
| `read.ts:53-72`                                    | `execute`                 | Enclosed | `ToolRegistry.settle` span and the read-filesystem span                              |
| `glob.ts:60`, `grep.ts:79`                         | `execute`                 | Enclosed | Runs inside the `ToolRegistry.settle` span                                           |
| `webfetch.ts:131-149`                              | `execute`                 | Enclosed | Runs inside the `ToolRegistry.settle` span                                           |
| `websearch.ts:206-221`                             | `execute`, `callMcp`      | Enclosed | Runs inside the `ToolRegistry.settle` span; the sink scrubs the Exa key from any URL |
| `todowrite.ts:39`, `skill.ts:70`, `question.ts:62` | `execute`                 | Enclosed | Runs inside the `ToolRegistry.settle` span; answers stay out                         |
| `apply-patch.ts:76-179`                            | `execute`                 | Enclosed | `ToolRegistry.settle` span and the `FileMutation` spans                              |
| `application-tools.ts:43`                          | `register`                | Captured | span bridge                                                                          |

### 9. Tools / V1 tool framework and tools (`opencode/src`)

Captured: 14 · Enclosed: 3

| Site                                                                         | Symbol                                                   | Status   | Captured by                                                                              |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `session/tools.ts:102-129`                                                   | AI SDK `execute`                                         | Captured | span bridge                                                                              |
| `session/tools.ts:67-89`                                                     | `ctx.metadata`, `ctx.ask`                                | Captured | span bridge, categorised log                                                             |
| `session/tools.ts:155-381`                                                   | MCP resource tools                                       | Captured | categorised log, span bridge                                                             |
| `session/tools.ts:398-424`                                                   | MCP tool `execute`                                       | Captured | span bridge                                                                              |
| `tool/tool.ts:121-145`                                                       | `wrap`                                                   | Captured | The `Tool.execute` span (tool.ts:144) with its attributes, now with duration and outcome |
| `tool/registry.ts:143-318`                                                   | `fromPlugin`, state, `tools`                             | Captured | span bridge                                                                              |
| `tool/code-mode.ts:134-274`                                                  | `invokeChildTool`, `CodeMode.execute`                    | Captured | span bridge                                                                              |
| `tool/truncate.ts:53-144`                                                    | `write`, `output`, `cleanup`                             | Captured | span bridge, categorised log                                                             |
| `tool/external-directory.ts:15`                                              | `assertExternalDirectoryEffect`                          | Captured | span bridge                                                                              |
| `tool/shell.ts:257-609`                                                      | parse, ask, `shellEnv`, run, spawn, stream, race, result | Captured | span bridge                                                                              |
| `tool/edit.ts:69-160`, `write.ts:38-69`                                      | `execute`                                                | Captured | bus tap                                                                                  |
| `tool/read.ts:229-382`                                                       | `ReadTool.execute`                                       | Captured | span bridge                                                                              |
| `tool/glob.ts:25`, `grep.ts:28`                                              | `execute`                                                | Enclosed | Runs inside the V1 `Tool.execute` span                                                   |
| `tool/webfetch.ts:33-79`, `websearch.ts:110`, `mcp-websearch.ts:70`          | `execute`                                                | Enclosed | Runs inside the V1 `Tool.execute` span                                                   |
| `tool/task.ts:92-350`                                                        | `TaskTool.execute`, `runTask`                            | Captured | span bridge, bus tap                                                                     |
| `tool/apply_patch.ts:30-262`                                                 | `ApplyPatchTool.execute`                                 | Captured | span bridge                                                                              |
| `tool/todo.ts`, `question.ts`, `skill.ts`, `plan.ts`, `lsp.ts`, `invalid.ts` | `execute`                                                | Enclosed | Runs inside the V1 `Tool.execute` span                                                   |

### 10. Permission, question and agent

Captured: 8

| Site                                      | Symbol                        | Status   | Captured by                           |
| ----------------------------------------- | ----------------------------- | -------- | ------------------------------------- |
| `core/src/permission.ts:137`, `:155`      | `configured`, `evaluateInput` | Captured | bus tap                               |
| `core/src/permission.ts:176-208`          | `create`, `ask`, `assert`     | Captured | bus tap                               |
| `core/src/permission.ts:220-276`          | `reply`                       | Captured | bus tap                               |
| `core/src/question.ts:93-133`             | `ask`, `reply`, `reject`      | Captured | span bridge, bus tap                  |
| `core/src/agent.ts:84-102`                | `AgentV2.*`                   | Captured | span bridge                           |
| `opencode/src/permission/index.ts:67-166` | `Permission.ask`, `reply`     | Captured | span bridge, categorised log, bus tap |
| `opencode/src/question/index.ts:87-143`   | `ask`, `reply`, `reject`      | Captured | span bridge, categorised log, bus tap |
| `opencode/src/agent/agent.ts:356-392`     | `get`, `list`, `generate`     | Captured | span bridge                           |

### 11. Process, shell, PTY, snapshot and file mutation

Captured: 9

| Site                                     | Symbol                                                   | Status   | Captured by                           |
| ---------------------------------------- | -------------------------------------------------------- | -------- | ------------------------------------- |
| `core/src/process.ts:144-214`            | `runCommand`, `AppProcess.run`, `runStream`              | Captured | span bridge                           |
| `core/src/background-job.ts:126-337`     | `start`, `settle`, `promote`, `cancel`, `wait`           | Captured | span bridge                           |
| `core/src/pty.ts:141-262`                | `create`, onExit, `write`, `attach`, `remove`            | Captured | categorised log, span bridge, bus tap |
| `core/src/pty/ticket.ts:43`, `:48`       | `issue`, `consume`                                       | Captured | span bridge                           |
| `core/src/file-mutation.ts:98-159`       | `write`, `create`, `writeIfUnchanged`, `remove`          | Captured | span bridge                           |
| `core/src/tool-output-store.ts:129-176`  | `write`, `bound`, `cleanup`                              | Captured | span bridge                           |
| `core/src/snapshot.ts:129-219`           | `capture`, `diff`, `restore`, `checkout`                 | Captured | categorised log, span bridge          |
| `opencode/src/snapshot/index.ts:156-762` | `track`, `patch`, `restore`, `revert`, `diff`, `cleanup` | Captured | span bridge, categorised log          |
| `opencode/src/patch/index.ts:514-575`    | `applyHunksToFiles`, `applyPatch`                        | Captured | categorised log, span bridge          |

### 12. HTTP server and SSE

Captured: 13 · Enclosed: 1 · Excluded: 1

| Site                                                                                       | Symbol                                              | Status   | Captured by                                                                                 |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `opencode/src/server/server.ts:83`, `:117`, `:157`, `:174`                                 | `listenEffect`, port fallback, mDNS, stop           | Captured | Telemetry record, span bridge                                                               |
| `opencode/src/server/server.ts:100-104`                                                    | `HttpRouter.serve`                                  | Captured | Telemetry record                                                                            |
| `opencode/src/server/routes/instance/httpapi/server.ts:317`                                | `webHandler`                                        | Captured | Telemetry record                                                                            |
| `.../httpapi/middleware/error.ts:7-44`                                                     | `errorLayer`                                        | Captured | categorised log                                                                             |
| `.../httpapi/middleware/schema-error.ts:25`, `server/src/middleware/schema-error.ts:16`    | schema error                                        | Captured | categorised log                                                                             |
| `.../httpapi/middleware/authorization.ts:40-150`, `server/src/middleware/authorization.ts` | `validateCredential`, `credentialFromURL`, PTY auth | Captured | categorised log                                                                             |
| `.../httpapi/middleware/workspace-routing.ts`, `proxy.ts:14-134`                           | routing, proxy                                      | Captured | categorised log                                                                             |
| `.../httpapi/middleware/instance-context.ts`, `fence.ts`, `lifecycle.ts:43`                | instance, fence, dispose                            | Captured | `logWarning` in lifecycle.ts and server/shared/fence.ts, plus the `http.request` access log |
| `.../httpapi/handlers/control.ts:28-39`                                                    | `ControlHttpApi.log` (`POST /log`)                  | Captured | span bridge                                                                                 |
| `.../httpapi/handlers/control.ts:13-26`                                                    | `authSet`, `authRemove`                             | Captured | span bridge                                                                                 |
| `.../httpapi/handlers/session.ts:319`                                                      | `prompt_async`                                      | Captured | categorised log, span bridge, bus tap                                                       |
| `.../httpapi/handlers/event.ts:25-87`, `global.ts:25-60`                                   | SSE subscribe                                       | Captured | categorised log, span bridge, bus tap                                                       |
| `opencode/src/control-plane/workspace.ts:184-423`                                          | `connectSSE`, `parseSSE`                            | Captured | span bridge, categorised log, bus tap                                                       |
| `opencode/src/cli/tui/worker.ts:24`                                                        | GlobalBus to RPC                                    | Enclosed | Every forwarded event was recorded by the bus tap in `notify`                               |
| `opencode/src/cli/cmd/run/trace.ts`                                                        | `trace()`                                           | Excluded | Opt-in local JSONL trace of prompts; the same turns reach Datadog through the LLM records   |

### 13. MCP and LSP

Captured: 7

| Site                                                                                     | Symbol                                              | Status   | Captured by                           |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- | -------- | ------------------------------------- |
| `opencode/src/mcp/index.ts:218-370`                                                      | `connectTransport`, `connectRemote`, `connectLocal` | Captured | span bridge, categorised log, bus tap |
| `opencode/src/mcp/index.ts:372-490`                                                      | `create`, `watch`, `serverLog`, tool list changed   | Captured | categorised log, span bridge, bus tap |
| `opencode/src/mcp/index.ts:493-766`                                                      | `state`, `status`, `tools`, `withClient`            | Captured | span bridge, categorised log, bus tap |
| `opencode/src/mcp/index.ts:806-970`, `auth.ts`, `oauth-provider.ts`, `oauth-callback.ts` | OAuth flow and token store                          | Captured | categorised log, span bridge, bus tap |
| `opencode/src/mcp/catalog.ts:38-110`                                                     | `defs`, `listTools`, `convertTool`, `fetch`         | Captured | categorised log                       |
| `opencode/src/lsp/lsp.ts:146-480`                                                        | `state`, `schedule`, `touchFile`, requests          | Captured | span bridge, categorised log, bus tap |
| `opencode/src/lsp/client.ts:123-640`                                                     | `create`, handlers, waits, `shutdown`               | Captured | Telemetry record, span bridge         |

### 14. Plugins

Captured: 5

| Site                                                              | Symbol                  | Status   | Captured by                                             |
| ----------------------------------------------------------------- | ----------------------- | -------- | ------------------------------------------------------- |
| `opencode/src/plugin/index.ts:134-282`                            | `Plugin.state`          | Captured | span bridge, bus tap                                    |
| `opencode/src/plugin/index.ts:186-218`                            | loader report callbacks | Captured | Telemetry record, categorised log, span bridge, bus tap |
| `opencode/src/plugin/loader.ts:86-208`, `install.ts`, `shared.ts` | resolve, load, install  | Captured | span bridge                                             |
| `opencode/src/plugin/tui/runtime.ts:130`                          | TUI plugin runtime      | Captured | span bridge, bus tap                                    |
| `core/src/plugin.ts:42-80`, `plugin/internal.ts:108`              | `PluginV2.add`, `boot`  | Captured | span bridge, bus tap                                    |

### 15. Configuration, storage, sync, share and workspaces

Captured: 8

| Site                                                                 | Symbol                                                                                     | Status   | Captured by                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | ---------------------------- |
| `opencode/src/config/config.ts:188-660`                              | `decodeConfig`, `fetchRemoteJson`, `loadFile`, `loadGlobal`, `loadInstanceState`, `update` | Captured | categorised log, span bridge |
| `opencode/src/config/tui.ts:83-259`, `core/src/config.ts:150-221`    | TUI config; V2 config entries and migration                                                | Captured | categorised log, span bridge |
| `core/src/database/database.ts:22-55`, `migration.ts:18-108`         | database layer, migrations                                                                 | Captured | span bridge                  |
| `opencode/src/storage/storage.ts:82-301`                             | migrations, key I/O                                                                        | Captured | categorised log, span bridge |
| `opencode/src/server/routes/instance/httpapi/handlers/sync.ts:27-89` | sync handlers                                                                              | Captured | categorised log, span bridge |
| `core/src/control-plane/move-session.ts:77`                          | `moveSession`                                                                              | Captured | span bridge, bus tap         |
| `opencode/src/share/share-next.ts:150-340`                           | `state`, `request`, `flush`, `create`, `remove`                                            | Captured | categorised log, span bridge |
| `opencode/src/control-plane/workspace.ts:270-860`                    | sync loop, `create`, `sessionWarp`, lifecycle                                              | Captured | span bridge, categorised log |

### 16. CLI, bootstrap, installation, git, skills and ACP

Captured: 12 · Enclosed: 1

| Site                                                                                        | Symbol                                     | Status   | Captured by                                                                                          |
| ------------------------------------------------------------------------------------------- | ------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `opencode/src/index.ts:53-78`                                                               | yargs middleware                           | Enclosed | It only maps flags to env vars; each command run is a `Cli.<name>` span that the span bridge records |
| `opencode/src/index.ts:104-141`                                                             | `.fail`, top-level catch                   | Captured | Telemetry record                                                                                     |
| `opencode/src/cli/effect-cmd.ts:69-110`                                                     | `effectCmd`                                | Captured | span bridge                                                                                          |
| `opencode/src/cli/tui/worker.ts:16-77`                                                      | worker handlers, RPC                       | Captured | Telemetry record, categorised log                                                                    |
| `opencode/src/cli/heap.ts:12-40`                                                            | `Heap.start`                               | Captured | span bridge                                                                                          |
| `opencode/src/project/bootstrap.ts:32-46`                                                   | `InstanceBootstrap.run`                    | Captured | categorised log, span bridge                                                                         |
| `opencode/src/project/instance-store.ts:63-185`                                             | `boot`, `load`, `reload`, `dispose`        | Captured | span bridge, bus tap, categorised log                                                                |
| `opencode/src/installation/index.ts:168-320`, `cli/upgrade.ts`                              | `latest`, `upgrade`                        | Captured | span bridge, categorised log                                                                         |
| `opencode/src/git/index.ts:110-322`, `core/src/git.ts:184-912`                              | `Git.run` and ops                          | Captured | span bridge                                                                                          |
| `opencode/src/worktree/index.ts:175-606`, `project/project.ts`, `project/vcs.ts`            | worktree, project, VCS                     | Captured | categorised log, span bridge, bus tap                                                                |
| `opencode/src/skill/index.ts:104-310`, `skill/discovery.ts`, `core/src/skill/discovery.ts`  | skill load and discovery                   | Captured | categorised log, span bridge, bus tap                                                                |
| `opencode/src/command/index.ts:65-166`                                                      | `Command.state`                            | Captured | span bridge                                                                                          |
| `opencode/src/acp/service.ts:94-839`, `acp/event.ts`, `acp/permission.ts`, `acp/profile.ts` | ACP requests, events, permissions, profile | Captured | categorised log, span bridge                                                                         |

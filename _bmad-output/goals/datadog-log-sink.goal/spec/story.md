# Story: production-ready Datadog log sink (pattern 3)

Source plan: [`../plan.md`](../plan.md). Design record, as repository paths:

- `specs/observability/logging-patterns.md` §Pattern 3, §Configuration layers, §Datadog sink switches, §Limits of the current sink
- `specs/observability/logging-sites.md` §How to read the tables, §Existing infrastructure, §Gaps to close first

## Summary

As an operator, I want the Datadog sink to take settings from layered configuration, to deliver reliably without hurting the client, and to keep secrets and personal data on the machine. Then I can switch it on for a team without checking what each session sends.

## Resolved design details

Stage 2 resolved these details. Phase R reviewed them (see `../reviews/2026-09-28-phase-r.md`). The config-file items follow the Decisions that the user revised and re-approved on 2026-09-28.

### Configuration

1. **Files.** Layer 2 reads `observability.datadog` from `config.json`, `opencode.json` and `opencode.jsonc` in `Global.Path.config`, in that order. `Global.Path.config` already follows `OPENCODE_CONFIG_DIR`.
   - A project `opencode.json` has no effect, and the schema description says so.
   - `OPENCODE_CONFIG` and `OPENCODE_CONFIG_CONTENT` are ignored.
   - No `{env:}` or `{file:}` substitution happens.
2. **Merge.** Files merge key by key, and the later file wins.
   - An empty or whitespace-only file counts as no file.
   - A malformed JSONC file is ignored with one warning, and the env settings still apply.
   - If `observability` or `datadog` is not an object, it is ignored with one warning.
   - Unknown keys are ignored with one warning.
3. **Narrow-only file keys.** The file accepts these keys:
   - `enabled`, but only `false` has an effect;
   - `service`, `env`, `version`, `tags` (a comma-separated string) and `hostname`;
   - `level`;
   - `categories`, but the file cannot remove the default exclusions of `question` and `pty`;
   - `content`, but only `omit` or `hash`;
   - `flushInterval`, as a duration string such as `"10 seconds"`;
   - `site`, but only a known Datadog site: `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`, `ap1.datadoghq.com` or `ddog-gov.com`.

   A value outside these rules is ignored with one warning. `url` is env-only.
4. **API key.** `apiKey`, `api_key` and `DD_API_KEY` in a file are ignored with one warning naming the file. The key is read only from the `DD_API_KEY` env var.
5. **Precedence** is env, then file, then code default, through `Datadog.provider({ env, configDir })`. An empty env value counts as unset.
6. **Levels** in `OPENCODE_DATADOG_LOG_LEVEL` and the file `level` are case-insensitive, for example `DEBUG` or `debug`.
7. **Bad configuration.** When a bad value turns the sink off, one `Warn` record reaches the other sinks. It is emitted after the logger layer is installed, never to the default console logger.

### Runtime policy

8. **`Datadog.LogPolicy`** is a `Context.Reference<{ content?: "omit" | "hash" | "full"; categories?: string }>` with default `{}`.
   - `Datadog.withPolicy(patch)` merges the patch into the current policy field by field, and the inner value wins.
   - A policy may widen `content` up to `full`. `question` and `pty` stay excluded unless the `OPENCODE_DATADOG_CATEGORIES` env var re-includes them.
9. **Secrets in every mode.** Secret keys and value patterns are redacted in every content mode, including `full`.

### Levels

10. **Per-sink levels.**
    - `Logging.fileLogger(file, runID, level)` and the stderr logger filter to `OPENCODE_LOG_LEVEL`. The OTLP logger is wrapped to filter at the same level.
    - The global `References.MinimumLogLevel` is the lowest level among the active sinks.
    - With Datadog off, the global minimum equals the file level exactly.
    - With a Datadog level above the file level, the file level applies to the file log.
    - A Datadog level of `None` means Datadog receives nothing.
    - An invalid `OPENCODE_LOG_LEVEL` keeps today's default, `INFO`.

### Delivery

11. **Status handling.**
    - `400`, `401`, `403` and `413` drop the batch with no retry.
    - `401` and `403` open the breaker (see item 12). `413` does not.
    - `408`, `429`, `5xx` and transport errors retry up to 3 times.
    - A `Retry-After` value that is an integer or an HTTP-date is honoured, capped at 30 seconds. Any other value falls back to the exponential backoff. Each wait uses one retry.
12. **Breaker.** When the retries run out, the sink opens its breaker for a cooldown of 60 seconds.
    - The cooldown is an option: `Datadog.logger(settings, { cooldown })`. Tests shorten it, or they use `TestClock` provided before `Datadog.logger` builds.
    - While the breaker is open, records are dropped at flush, and the other chunks of the flush that tripped it are skipped.
    - After the cooldown, the next flush uses full retries again.
    - The buffer holds at most 10,000 entries, and it drops the oldest first.
13. **Breaker record.** Each time the breaker opens, the sink emits one `Warn` record, "Datadog sink disabled for 60 seconds", to the other sinks.
    - It uses the loggers captured when the layer was built, minus the Datadog logger.
    - The record never appears in an intake body.
14. **Shutdown.**
    - The final flush makes one attempt with a 5-second timeout and no `Retry-After` wait.
    - A final flush while the breaker is open sends nothing.
    - Disposal against a failing intake finishes within 5 seconds.
15. **Chunks.**
    - Size is measured in UTF-8 bytes with `Buffer.byteLength`. A chunk stays under 4.5 MB before compression.
    - An entry above 1,000,000 bytes has its message truncated, with the marker `[TRUNCATED]`.
16. **Gzip.** Each body is `Bun.gzipSync(JSON.stringify(batch))`, sent with `Content-Encoding: gzip`.

### Redaction

17. **Default categories** are `*,-question,-pty`.
18. **More content keys.** The `CONTENT` keys gain `answers`, `cmd` and `data`. So the existing `Question.reply` log (`packages/opencode/src/question/index.ts:125`) and the `Pty.create` and `Pty.write` records (`packages/core/src/pty.ts`) are safe with no category annotation.
19. **Secret keys.** A key is a secret when its lowercase form, with `-` and `_` removed, equals or ends with one of these: `apikey`, `authorization`, `password`, `secret`, `token`, `cookie` or `credential`. `inputTokens` and `tokenizer` are not secret keys.
20. **Value scrubbing.**
    - It applies to the message, every attribute value at any depth, `error.message` and `error.stack`.
    - These shapes become `[REDACTED]`, each with a left boundary `(?<![A-Za-z0-9])`:
      - `sk-` followed by 16 or more characters from `[A-Za-z0-9_-]`;
      - `AKIA` followed by 16 characters from `[0-9A-Z]`;
      - `gh[pousr]_` followed by 20 or more alphanumeric characters;
      - `xox[abprs]-` followed by one or more characters from `[A-Za-z0-9-]`.
    - A query parameter is redacted when its name, compared case-insensitively, ends with `key` or `token` and is preceded by `?` or `&`, or when it is one of `api_key` or `access_token`. So `exaApiKey` and `access_token` are covered.
    - Only the value is replaced. The surrounding text survives.
    - These must not be redacted: `task-0123456789abcdef`, `risk-assessment-document`, `monkey=1` in prose, `tokenizer` and `inputTokens: 42`.

## Acceptance criteria

- **AC-1** A value in a global config file's `observability.datadog` object configures the sink, and the same env var overrides it.
- **AC-2** An `apiKey` in a config file never reaches the sink. It is ignored with a warning, and the env key is the one sent.
- **AC-3** A record emitted under `Datadog.withPolicy({ content: "full" })` ships its content, a record outside that scope stays redacted, and secrets stay redacted inside it.
- **AC-4** With `OPENCODE_LOG_LEVEL=INFO` and `OPENCODE_DATADOG_LOG_LEVEL=Debug`, a `Debug` record reaches Datadog and does not reach the file log.
- **AC-5** A `429` with `Retry-After: 2` delays the next attempt by at least two seconds.
- **AC-6** After a batch exhausts its retries, the sink sends no request for the next 60 seconds.
- **AC-7** Every request is gzip-compressed and declares `Content-Encoding: gzip`.
- **AC-8** Disposing a runtime that holds the sink flushes the buffered records.
- **AC-9** Known secret shapes in the message, in attribute values at any depth, and in error messages do not reach the intake, and the surrounding text survives.
- **AC-10** By default, a record shaped like today's `Question.reply` log, with no category, sends no answer text, and `question.*` and `pty.*` categories are excluded.
- **AC-11** Operator docs and the specs match the shipped behaviour. This criterion is documentation only and has no test.

## Affected components

- `packages/core/src/observability/datadog.ts`
- `packages/core/src/observability/logging.ts`
- `packages/core/src/observability/otlp.ts`
- `packages/core/src/observability.ts`
- `packages/core/src/v1/config/config.ts`
- `packages/core/test/effect/observability-datadog.test.ts`
- `packages/core/test/effect/observability-datadog-atdd.test.ts`
- `packages/web/src/content/docs/cli.mdx`
- `specs/observability/logging-patterns.md`
